import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { computeEntryHash, GENESIS_HASH, verifyAuditChain } from "../../lib/audit-chain.js";
import { nonNull } from "../../lib/non-null.js";
import { compactCommand, loadArchiveManifest, registerCompactCommand } from "../compact.js";

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
		const seg = nonNull(manifest.segments[0]);
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

	it("does nothing (with a message) when activity.jsonl does not exist at all", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-"));
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true });
		} finally {
			log.mockRestore();
		}
		expect(JSON.parse(nonNull(out[0]))).toEqual({ compacted: false, reason: "no activity.jsonl" });
	});

	it("prints human-readable output (not JSON) when --json is not passed", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, keepRecentBytes: 20 });
		} finally {
			log.mockRestore();
		}
		expect(out).toHaveLength(1);
		// Human output is not parseable JSON — it's the "✓ Compacted" narrative line.
		expect(() => JSON.parse(nonNull(out[0]))).toThrow();
		expect(out[0]).toContain("Compacted");
	});

	it("reports 'first record exceeds the archivable region' for a single-record file with nothing to cut before it", async () => {
		const { tempDir, dataDir, content } = writeLog([{ type: "tool_use", i: 1 }]);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 0 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe("first record exceeds the archivable region");
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
	});

	it("reports the recent-tail reason when keepRecentBytes exceeds the whole (synced) file", async () => {
		const records = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// --all so syncedBytes is irrelevant (ignoreSync=true); keepRecentBytes bigger
			// than the whole file forces `fileSize - keepRecentBytes <= 0`.
			await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes: fileBytes + 10_000 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe(
			`log is within the ${((fileBytes + 10_000) / 1024 / 1024).toFixed(1)}MB recent-tail kept live`,
		);
	});

	it("reports the pre-audit-tail-empty reason when the chained record is the very first line", async () => {
		const records = [
			{ type: "guard_allow", hash: "d".repeat(64), previousHash: "0".repeat(64), first: true },
			...Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		setSync(dataDir, fileBytes); // everything synced (first cond of the reason ternary: false)
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// Small keepRecentBytes so fileSize - keepRecentBytes > 0 (second cond: false too) —
			// only the chained-record-at-offset-0 constraint drives limit to 0.
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe("the pre-audit-tail region is empty");
	});

	it("treats a missing/non-numeric synced_through_bytes as nothing synced (fail safe)", async () => {
		const { tempDir, dataDir } = writeLog(Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })));
		// sync-state.json exists but its field is the wrong type — not the number branch.
		writeFileSync(join(dataDir, "sync-state.json"), JSON.stringify({ synced_through_bytes: "not-a-number" }));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.synced_bytes).toBe(0);
		expect(parsed.reason).toBe("no synced data yet — pass --all to compact a local-only log");
	});
});

describe("loadArchiveManifest — malformed manifest handling", () => {
	function withManifest(raw: string): string {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-manifest-"));
		const archiveDir = join(tempDir, ".interlinked", "archive");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "manifest.json"), raw);
		return tempDir;
	}

	it("falls back to an empty manifest when manifest.json is not valid JSON (parse error)", () => {
		const tempDir = withManifest("{not valid json");
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("falls back to an empty manifest when manifest.json parses but has no segments array", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1 }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("falls back to an empty manifest when manifest.json is valid JSON `null`", () => {
		const tempDir = withManifest("null");
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});
});

describe("registerCompactCommand — CLI wiring", () => {
	it("parses --keep-recent-mb and --json and drives a real compaction through the commander action", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-cli-"));
		const dataDir = join(tempDir, ".interlinked");
		mkdirSync(dataDir, { recursive: true });
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
		writeFileSync(join(dataDir, "activity.jsonl"), content);
		writeFileSync(
			join(dataDir, "sync-state.json"),
			JSON.stringify({ synced_through_bytes: Buffer.byteLength(content) }),
		);

		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins a worker-thread pool.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tempDir));
		try {
			const program = new Command();
			program.exitOverride();
			registerCompactCommand(program);
			// A tiny --keep-recent-mb (in MB) converts to a small byte count, so the
			// 30-record fixture is comfortably archivable.
			await program.parseAsync(["node", "interlinked", "compact", "--keep-recent-mb", "0.00001", "--json"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}

		expect(out).toHaveLength(1);
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(true);
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);
	});

	it("runs with the default 2MB keep-recent-mb and reports nothing-to-compact for a tiny file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-cli-default-"));
		const dataDir = join(tempDir, ".interlinked");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "activity.jsonl"), '{"type":"tool_use","i":1}\n');
		writeFileSync(join(dataDir, "sync-state.json"), JSON.stringify({ synced_through_bytes: 27 }));

		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tempDir));
		try {
			const program = new Command();
			program.exitOverride();
			registerCompactCommand(program);
			await program.parseAsync(["node", "interlinked", "compact", "--json"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}

		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		// Default 2MB keep-recent-mb dwarfs this tiny fixture.
		expect(parsed.reason).toBe("log is within the 2.0MB recent-tail kept live");
	});
});
