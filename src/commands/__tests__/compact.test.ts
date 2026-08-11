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

	it("prints human-readable output (not JSON) when --json is not passed, with the exact mb/percentage figures", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));

		// Probe run: identical fixture, --json, to derive the exact expected figures
		// independently of the human-message template under test.
		const probeFixture = writeLog(records);
		setSync(probeFixture.dataDir, Buffer.byteLength(probeFixture.content));
		const probeOut: string[] = [];
		const probeLog = vi.spyOn(console, "log").mockImplementation((m) => void probeOut.push(String(m)));
		let probe: { archived_bytes: number; archived_records: number; gz_bytes: number; live_after_bytes: number; segment: string };
		try {
			await compactCommand({ cwd: probeFixture.tempDir, json: true, keepRecentBytes: 20 });
			probe = JSON.parse(nonNull(probeOut[0]));
		} finally {
			probeLog.mockRestore();
		}

		// Real run: identical fixture, human-readable mode.
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
		const msg = nonNull(out[0]);
		// Human output is not parseable JSON — it's the "✓ Compacted" narrative line.
		expect(() => JSON.parse(msg)).toThrow();
		expect(msg).toContain("Compacted");
		expect(msg).toContain(`${(probe.archived_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`(${probe.archived_records} records)`);
		expect(msg).toContain(`archive/${probe.segment}`);
		expect(msg).toContain(`gzipped to ${(probe.gz_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`${Math.round((1 - probe.gz_bytes / probe.archived_bytes) * 100)}% smaller, lossless`);
		// Whole contiguous phrase (label + before-size + arrow + after-size), not just
		// the after-size figure in isolation — a small fixture's mb() values can all
		// format to the same "0.0MB" text, so a lone-number check can't tell "this
		// exact labeled line is present" from "some other line's number matches".
		const totalBytes = Buffer.byteLength(content);
		expect(msg).toContain(
			`live activity.jsonl: ${(totalBytes / 1024 / 1024).toFixed(1)}MB → ${(probe.live_after_bytes / 1024 / 1024).toFixed(1)}MB`,
		);
		expect(msg).toContain(`recover: gunzip -c .interlinked/archive/${probe.segment}`);
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

	it("a non-string cwd option is ignored in favor of process.cwd() (never passed straight through)", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tempDir));
		try {
			// opts.cwd is a NUMBER, not a string. If it were used directly, getDataDir's
			// internal path.join would throw (join() rejects non-string arguments); the
			// typeof guard exists precisely to fall back to process.cwd() instead.
			await compactCommand({ cwd: 42, json: true, keepRecentBytes: 20 });
		} finally {
			cwdSpy.mockRestore();
		}
		// Compacted the MOCKED process.cwd() dir, proving the numeric opts.cwd was ignored.
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);
	});

	it("omitting keepRecentBytes falls back to the DEFAULT_KEEP_RECENT_BYTES (2MB) constant, not undefined/NaN", async () => {
		const { tempDir, dataDir, content } = writeLog([{ type: "tool_use", i: 1 }]);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// No keepRecentBytes at all — exercises the typeof guard's fallback branch
			// directly (the CLI layer always computes a numeric value itself, so this
			// path is otherwise only reachable by a direct caller).
			await compactCommand({ cwd: tempDir, json: true });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe("log is within the 2.0MB recent-tail kept live");
	});

	it("fileSize - keepRecentBytes landing exactly at zero reports the recent-tail reason (inclusive boundary)", async () => {
		const records = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// --all so syncedBytes is irrelevant; keepRecentBytes === fileBytes forces
			// `fileSize - keepRecentBytes` to exactly 0, the <=0 / <0 boundary itself.
			await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes: fileBytes });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe(`log is within the ${(fileBytes / 1024 / 1024).toFixed(1)}MB recent-tail kept live`);
	});

	it("archives exactly up to a record boundary that lands precisely at the keep-recent limit (off-by-one safe)", async () => {
		const records = Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const totalBytes = Buffer.byteLength(content);
		// Independently compute (not via planCut) the byte offset where record #6 begins.
		const cutIndex = 6;
		const prefix = `${records
			.slice(0, cutIndex)
			.map((r) => JSON.stringify(r))
			.join("\n")}\n`;
		const cutOffset = Buffer.byteLength(prefix);
		// keepRecentBytes chosen so `fileSize - keepRecentBytes === cutOffset` EXACTLY —
		// the record-boundary offset lands precisely on the computed limit.
		const keepRecentBytes = totalBytes - cutOffset;

		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(true);
		// A boundary offset exactly AT the limit is included (`start <= limit`), so the
		// cut lands exactly at cutOffset — not one record short.
		expect(parsed.archived_bytes).toBe(cutOffset);
		expect(parsed.archived_records).toBe(cutIndex);
		expect(parsed.live_after_bytes).toBe(totalBytes - cutOffset);

		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).toBe(content.slice(cutOffset));
	});

	it("sequential compactions increment the segment seq and reuse the existing archive dir", async () => {
		const records = Array.from({ length: 100 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));

		// First compaction: keep a generous tail live so plenty remains for a 2nd cut.
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 200 });
		const manifestAfter1 = loadArchiveManifest(tempDir);
		expect(manifestAfter1.segments.length).toBe(1);
		expect(manifestAfter1.segments[0]?.seq).toBe(1);
		expect(manifestAfter1.segments[0]?.file).toBe("activity-0001.jsonl.gz");

		// Second compaction on the SAME (now-shrunk) live file + the EXISTING archive dir
		// (mkdirSync must tolerate an already-existing directory — recursive:true).
		const liveAfter1 = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		setSync(dataDir, Buffer.byteLength(liveAfter1));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 10 });
		const manifestAfter2 = loadArchiveManifest(tempDir);
		expect(manifestAfter2.segments.length).toBe(2);
		expect(manifestAfter2.segments[1]?.seq).toBe(2);
		expect(manifestAfter2.segments[1]?.file).toBe("activity-0002.jsonl.gz");
	});

	it("dry-run JSON payload reports exact would_archive_bytes/records, gz_bytes, live_after_bytes, and flags", async () => {
		const records = Array.from({ length: 20 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const totalBytes = Buffer.byteLength(content);
		setSync(dataDir, totalBytes);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, dryRun: true, keepRecentBytes: 20 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.dry_run).toBe(true);
		expect(typeof parsed.would_archive_bytes).toBe("number");
		expect(parsed.would_archive_bytes).toBeGreaterThan(0);
		expect(parsed.would_archive_bytes).toBeLessThan(totalBytes);
		expect(parsed.live_after_bytes).toBe(totalBytes - parsed.would_archive_bytes);
		expect(parsed.gz_bytes).toBeGreaterThan(0);
		expect(parsed.gz_bytes).toBeLessThan(parsed.would_archive_bytes);
		expect(parsed.segment).toBe("activity-0001.jsonl.gz");
		// Dry-run truly makes no changes.
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toBe(content);
	});

	it("dry-run human-readable message shows the exact mb figures and shrink percentage", async () => {
		const records = Array.from({ length: 20 }, (_, i) => ({ type: "tool_use", i }));

		// Probe run: identical fixture, --json, to derive the exact expected figures
		// independently of the human-message template under test.
		const probeFixture = writeLog(records);
		setSync(probeFixture.dataDir, Buffer.byteLength(probeFixture.content));
		const probeOut: string[] = [];
		const probeLog = vi.spyOn(console, "log").mockImplementation((m) => void probeOut.push(String(m)));
		let probe: { would_archive_bytes: number; would_archive_records: number; gz_bytes: number; live_after_bytes: number; segment: string };
		try {
			await compactCommand({ cwd: probeFixture.tempDir, json: true, dryRun: true, keepRecentBytes: 20 });
			probe = JSON.parse(nonNull(probeOut[0]));
		} finally {
			probeLog.mockRestore();
		}

		// Real run: identical fixture, human-readable mode.
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, dryRun: true, keepRecentBytes: 20 });
		} finally {
			log.mockRestore();
		}
		const msg = nonNull(out[0]);
		expect(msg).toContain("Dry run");
		expect(msg).toContain(`would archive ${(probe.would_archive_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`(${probe.would_archive_records} records)`);
		expect(msg).toContain(probe.segment);
		expect(msg).toContain(`gzipped: ${(probe.gz_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`${Math.round((1 - probe.gz_bytes / probe.would_archive_bytes) * 100)}% smaller`);
		expect(msg).toContain(`live activity.jsonl after: ${(probe.live_after_bytes / 1024 / 1024).toFixed(1)}MB`);
	});

	it("prints a human-readable 'nothing to compact' message (not JSON) when activity.jsonl is absent", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-"));
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir });
		} finally {
			log.mockRestore();
		}
		expect(out).toHaveLength(1);
		expect(() => JSON.parse(nonNull(out[0]))).toThrow();
		expect(out[0]).toContain("Nothing to compact");
		expect(out[0]).toContain("no activity.jsonl");
	});

	it("prints a human-readable 'nothing safely compactable' message with mb-formatted file/synced sizes", async () => {
		const records = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// --all + a huge keepRecentBytes so nothing is archivable; no sync-state
			// written at all, so synced_bytes stays 0.
			await compactCommand({ cwd: tempDir, all: true, keepRecentBytes: fileBytes + 10_000 });
		} finally {
			log.mockRestore();
		}
		expect(out).toHaveLength(1);
		expect(() => JSON.parse(nonNull(out[0]))).toThrow();
		expect(out[0]).toContain("Nothing safely compactable");
		expect(out[0]).toContain(`log ${(fileBytes / 1024 / 1024).toFixed(1)}MB, synced 0.0MB`);
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

	// --- parseArchiveManifest / parseArchiveSegment boundary parser ---

	const VALID_SEGMENT = {
		seq: 1,
		file: "activity-0001.jsonl.gz",
		bytes: 1000,
		gz_bytes: 200,
		records: 30,
		created_at: "2026-08-01T00:00:00Z",
	};

	it("P1: accepts a well-formed manifest with a fully-shaped segment", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [VALID_SEGMENT] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [VALID_SEGMENT] });
	});

	it("N1: a single malformed segment (wrong-typed field) invalidates the whole manifest", () => {
		// manifest.json has exactly one in-repo writer (compactCommand itself),
		// unlike the multi-writer activity/collection logs — a shape mismatch
		// here is corruption, not a legitimately-optional legacy field, so it
		// falls back to empty rather than silently serving a partial segment
		// list to `audit verify` (which reads segments in manifest order).
		const badSegment = { ...VALID_SEGMENT, bytes: "not-a-number" };
		const tempDir = withManifest(
			JSON.stringify({ version: 1, segments: [VALID_SEGMENT, badSegment] }),
		);
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N2: a segments array containing a non-object entry invalidates the whole manifest", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: ["not-an-object"] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N3: segments being a non-array (a plain object) still yields an empty manifest", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: {} }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N4: a segments array containing null still yields an empty manifest", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [null] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	// --- per-field type-guard MC/DC: each field wrong in isolation, all others valid,
	// so a disabled/weakened check on ONE field can't hide behind another field's check
	// catching the same malformed segment for a different reason. ---

	it("N5: seq wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, seq: "1" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N6: file wrong type (not a string) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, file: 123 };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N7: bytes wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, bytes: "1000" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N8: gz_bytes wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, gz_bytes: "200" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N9: records wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, records: "30" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N10: created_at wrong type (not a string) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, created_at: 20260801 };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});
});

describe("planCut — hash-chain line classification boundary parser", () => {
	it("P1: a well-formed chained record (string type + string hash) blocks archiving past it", async () => {
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: "a".repeat(64), previousHash: "0".repeat(64) },
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toContain("guard_allow");
	});

	it("N1: a line with hash present but NOT a string is not treated as chained", async () => {
		// A malformed "type": "guard_allow" line whose hash is a number rather
		// than a string must not pin lastChainedStart — the isJsonObject +
		// typeof guards must keep behaving exactly like the pre-fix
		// `as { type?: unknown; hash?: unknown }` cast's own typeof checks did.
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: 12345 }, // hash is a number, not a string
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		// Nothing pins lastChainedStart, so the malformed line itself can be
		// archived away — it does not survive as the mid-log chain anchor.
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).not.toContain('"hash":12345');
	});

	it("N2: a numeric 'type' field is not treated as chained even with a valid-looking hash", async () => {
		// isJsonObject(rec) is true and hash is a real string — only the
		// `typeof rec.type === "string"` clause should be what rejects this line.
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: 999, hash: "e".repeat(64), marker: "weird-numeric-type" },
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).not.toContain("weird-numeric-type");
	});

	it("N3: a valid string 'type' outside CHAINED_TYPES is not treated as chained even with a valid hash", async () => {
		// isJsonObject(rec), typeof rec.type === "string", and typeof rec.hash ===
		// "string" are ALL true here — only `CHAINED_TYPES.has(rec.type)` rejects it.
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "custom_event", hash: "f".repeat(64), marker: "weird-custom-type" },
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).not.toContain("weird-custom-type");
	});

	it("P2: each of the other three CHAINED_TYPES members (guard_block, guard_warn, session_end) blocks archiving past it", async () => {
		for (const chainedType of ["guard_block", "guard_warn", "session_end"]) {
			const records = [
				...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
				{ type: chainedType, hash: "a".repeat(64) },
				...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
			];
			const { tempDir, dataDir, content } = writeLog(records);
			setSync(dataDir, Buffer.byteLength(content));
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
			const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
			expect(live).toContain(`"type":"${chainedType}"`);
		}
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

	it("registers --dry-run, --keep-recent-mb, --all, --json with their documented descriptions", () => {
		const program = new Command();
		registerCompactCommand(program);
		const cmd = nonNull(program.commands.find((command) => command.name() === "compact"));
		expect(cmd.description()).toBe(
			"Gzip + archive the synced prefix of activity.jsonl (lossless), reclaiming disk",
		);
		const flags = new Map(cmd.options.map((o) => [o.long, o.description]));
		expect(flags.get("--dry-run")).toBe("Show what would be archived without changing anything");
		expect(flags.get("--keep-recent-mb")).toBe("Keep at least this many MB of recent log live");
		expect(flags.get("--all")).toBe(
			"Archive past the recent tail even when un-synced (local-only / disk recovery; archived events won't be sent to the server)",
		);
		expect(flags.get("--json")).toBe("Machine-readable output");
	});
});
