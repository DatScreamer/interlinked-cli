import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, computeEntryHash, verifyAuditChain } from "../../lib/audit-chain.js";
import { compactCommand, loadArchiveManifest } from "../compact.js";

function writeLog(records: object[]): { tempDir: string; dataDir: string; content: string } {
	const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-"));
	const dataDir = join(tempDir, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
	const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	writeFileSync(join(dataDir, "activity.jsonl"), content);
	return { tempDir, dataDir, content };
}

function setSync(dataDir: string, bytes: number): void {
	writeFileSync(
		join(dataDir, "sync-state.json"),
		JSON.stringify({ synced_through_bytes: bytes, last_sync_at: "" }),
	);
}

describe("interlinked compact", () => {
	it("archives the synced prefix, keeps unsynced + audit tail live, and is lossless", async () => {
		const records = [
			...Array.from({ length: 20 }, (_, i) => ({ schema_version: 5, type: "tool_use", i })),
			{ schema_version: 5, type: "guard_allow", hash: "a".repeat(64), previousHash: "0".repeat(64) },
			...Array.from({ length: 5 }, (_, i) => ({ schema_version: 5, type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		const total = Buffer.byteLength(content);
		setSync(dataDir, total); // everything synced

		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 50 });

		const manifest = loadArchiveManifest(tempDir);
		expect(manifest.segments.length).toBe(1);
		const seg = manifest.segments[0];
		const gzPath = join(dataDir, "archive", seg.file);
		expect(existsSync(gzPath)).toBe(true);

		// Lossless: gunzip(segment) + live === original, byte-for-byte.
		const archived = gunzipSync(readFileSync(gzPath)).toString("utf-8");
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(archived + live).toBe(content);

		// Audit tail stays live: the last chained record must remain in the live file.
		expect(live).toContain("guard_allow");

		// Cursor decremented by exactly the archived byte count.
		const sync = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf-8"));
		expect(sync.synced_through_bytes).toBe(total - seg.bytes);
	});

	it("does nothing when no data is synced", async () => {
		const { tempDir, dataDir } = writeLog([
			{ type: "tool_use", i: 1 },
			{ type: "tool_use", i: 2 },
		]);
		setSync(dataDir, 0);
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 10 });
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
		expect(existsSync(join(dataDir, "archive"))).toBe(false);
	});

	it("dry-run makes no changes", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, dryRun: true, keepRecentBytes: 20 });
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toBe(content);
	});

	it("never archives past the last chained record (write-time chain continuity)", async () => {
		const records = [
			...Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: "b".repeat(64), previousHash: "0".repeat(64), last: true },
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).toContain('"last":true');
	});

	it("audit chain still verifies across the compaction boundary", async () => {
		// Build a valid 2-link chain (real hashes) with plain records around it.
		const c1 = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
		const c1full = { ...c1, hash: computeEntryHash(c1) };
		const c2 = { type: "guard_allow", previousHash: c1full.hash, n: 2, last: true };
		const c2full = { ...c2, hash: computeEntryHash(c2) };
		const records = [
			...Array.from({ length: 8 }, (_, i) => ({ type: "tool_use", i })),
			c1full,
			...Array.from({ length: 4 }, (_, i) => ({ type: "tool_use", i: 50 + i })),
			c2full,
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));

		// Valid before compaction.
		expect(verifyAuditChain(tempDir).valid).toBe(true);

		// Compact: c1 lands in the archive, c2 (last chained) stays live.
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toContain('"last":true');
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);

		// Still valid — verify reads archive(c1) then live(c2) across the boundary.
		const result = verifyAuditChain(tempDir);
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(2);
	});

	it("--all archives un-synced data (local-only / disk recovery), still audit-tail-safe", async () => {
		const records = [
			...Array.from({ length: 15 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: "c".repeat(64), previousHash: "0".repeat(64), last: true },
		];
		const { tempDir, dataDir } = writeLog(records);
		// No sync-state at all — the real local-only case (nothing ever synced).
		await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes: 1 });
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);
		// The last chained record still stays live (audit-tail-safe) even with --all.
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toContain('"last":true');
	});
});
