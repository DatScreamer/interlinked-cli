import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, computeEntryHash, getActivityPath, verifyAuditChain } from "./audit-chain.js";

let tmpDirs: string[] = [];

function makeTmpCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "audit-chain-w45-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tmpDirs) {
		rmSync(d, { recursive: true, force: true });
	}
	tmpDirs = [];
});

interface RawRecord {
	type: string;
	previousHash: string;
	ts: string;
	[k: string]: unknown;
}

function chainedLine(rec: RawRecord): string {
	const hash = computeEntryHash(rec);
	return JSON.stringify({ ...rec, hash });
}

function writeActivity(cwd: string, content: string): void {
	const path = getActivityPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

describe("verifyAuditChain — positive (must fire correctly)", () => {
	// test-contract: public-api — verifyAuditChain(cwd) is the module's sole
	// verification entry point; a correctly-hashed genesis record must verify.
	it("P1: a single valid genesis-rooted record verifies as valid (kills utf8-encoding mutants in safeEqualHex)", () => {
		const cwd = makeTmpCwd();
		const rec: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		writeActivity(cwd, `${chainedLine(rec)}\n`);

		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(1);
		expect(result.guard_events).toBe(1);
		expect(result.unchained_guard_events).toBe(0);
	});

	// test-contract: public-api — chaining is defined by previousHash equal
	// to the prior record's hash; the chain must extend correctly.
	it("P2: a two-link chain (previousHash = prior hash) verifies as valid end to end", () => {
		const cwd = makeTmpCwd();
		const rec1: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		const hash1 = computeEntryHash(rec1);
		const rec2: RawRecord = { type: "guard_warn", previousHash: hash1, ts: "t2" };
		writeActivity(cwd, `${JSON.stringify({ ...rec1, hash: hash1 })}\n${chainedLine(rec2)}\n`);

		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(2);
	});
});

describe("verifyAuditChain — negative / edge parsing (must not miscount)", () => {
	// test-contract: invariant — the documented "mixed-file tolerant" walk
	// must not let non-content (whitespace-only) lines inflate total_events.
	it("N1: whitespace-only lines are not counted as events (kills rawLine.trim -> rawLine)", () => {
		const cwd = makeTmpCwd();
		const rec1: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		const hash1 = computeEntryHash(rec1);
		const rec2: RawRecord = { type: "guard_warn", previousHash: hash1, ts: "t2" };
		const content = [
			JSON.stringify({ ...rec1, hash: hash1 }),
			"   ",
			chainedLine(rec2),
		].join("\n");
		writeActivity(cwd, content);

		const result = verifyAuditChain(cwd);
		// Only the two real JSON lines should count; the whitespace-only line
		// must be filtered before totalEvents is incremented.
		expect(result.total_events).toBe(2);
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(2);
	});

	// test-contract: boundary — comment above isJsonObject's call site says
	// non-object JSON (array/string/number/null) is treated as unrecognized
	// and skipped rather than crashing the walk; null is the sharpest case
	// since accessing .type on it without the guard would throw.
	it("N2: a non-object JSON value (null) is skipped without throwing and without becoming a guard event (kills !isJsonObject -> false)", () => {
		const cwd = makeTmpCwd();
		const rec1: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		const hash1 = computeEntryHash(rec1);
		const rec2: RawRecord = { type: "guard_warn", previousHash: hash1, ts: "t2" };
		const content = [
			JSON.stringify({ ...rec1, hash: hash1 }),
			"null",
			chainedLine(rec2),
		].join("\n");
		writeActivity(cwd, content);

		expect(() => verifyAuditChain(cwd)).not.toThrow();
		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(true);
		expect(result.total_events).toBe(3);
		expect(result.guard_events).toBe(2);
		expect(result.chained_events).toBe(2);
	});

	// test-contract: invariant — hasHash requires a 64-char string (a real
	// sha256 hex digest); a shorter value must fall into the legacy
	// "unchained" bucket, not be run through hash comparison.
	it("N3: a hash field shorter than 64 chars is treated as unchained, not compared (kills record.hash.length === 64 -> true)", () => {
		const cwd = makeTmpCwd();
		const line = JSON.stringify({
			type: "guard_block",
			previousHash: GENESIS_HASH,
			ts: "t1",
			hash: "not-a-real-hash",
		});
		writeActivity(cwd, `${line}\n`);

		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(true);
		expect(result.guard_events).toBe(1);
		expect(result.unchained_guard_events).toBe(1);
		expect(result.chained_events).toBe(0);
	});
});

describe("verifyAuditChain — break detection (must report the exact break)", () => {
	// test-contract: public-api — first_bad_line_number and first_bad_reason
	// are the documented fields callers use to locate/report a chain break;
	// the message doc-comment explicitly promises truncated hash prefixes.
	it("N4: a previousHash mismatch reports the correct 1-indexed line number and truncated (not full) hashes", () => {
		const cwd = makeTmpCwd();
		const rec1: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		const hash1 = computeEntryHash(rec1);
		const wrongPrev = "f".repeat(64);
		const rec2: RawRecord = { type: "guard_warn", previousHash: wrongPrev, ts: "t2" };
		const content = `${JSON.stringify({ ...rec1, hash: hash1 })}\n${chainedLine(rec2)}`;
		writeActivity(cwd, content);

		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(false);
		// Two physical lines; the break is on line 2 (i + 1, not i - 1).
		expect(result.first_bad_line_number).toBe(2);
		expect(result.first_bad_reason).toBeDefined();
		// SAFETY: just asserted defined above; the field is `string | undefined`.
		const reason = result.first_bad_reason as string;
		// Sliced to 12 chars, not the full 64-char hash, for both sides.
		expect(reason).toContain(hash1.slice(0, 12));
		expect(reason).not.toContain(hash1);
		expect(reason).toContain(wrongPrev.slice(0, 12));
		expect(reason).not.toContain(wrongPrev);
	});

	// test-contract: public-api — same as N4 but for the hash-payload-mismatch
	// branch, a second independent return statement with its own line-number
	// and slicing logic.
	it("N5: a hash-payload mismatch reports the correct 1-indexed line number and truncated (not full) hashes", () => {
		const cwd = makeTmpCwd();
		const rec1: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		const hash1 = computeEntryHash(rec1);
		const rec2: RawRecord = { type: "guard_warn", previousHash: hash1, ts: "t2" };
		const expectedHash2 = computeEntryHash(rec2);
		const tamperedHash = "e".repeat(64);
		const content = `${JSON.stringify({ ...rec1, hash: hash1 })}\n${JSON.stringify({ ...rec2, hash: tamperedHash })}`;
		writeActivity(cwd, content);

		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(false);
		expect(result.first_bad_line_number).toBe(2);
		expect(result.first_bad_reason).toBeDefined();
		// SAFETY: just asserted defined above; the field is `string | undefined`.
		const reason = result.first_bad_reason as string;
		expect(reason).toContain(expectedHash2.slice(0, 12));
		expect(reason).not.toContain(expectedHash2);
		expect(reason).toContain(tamperedHash.slice(0, 12));
		expect(reason).not.toContain(tamperedHash);
	});
});

describe("verifyAuditChain — archived segments (must sort by seq and read them)", () => {
	// test-contract: invariant — readArchivedAuditLines's doc-comment states
	// segments are read "in manifest order" after being sorted by seq; the
	// full chain validity here depends on that sort actually running and on
	// manifest.json parsing as real utf-8 text.
	it("N6: archived segments are concatenated in ascending seq order regardless of manifest listing order, and manifest.json is read as utf-8", () => {
		const cwd = makeTmpCwd();
		const activityPath = getActivityPath(cwd);
		const archiveDir = join(dirname(activityPath), "archive");
		mkdirSync(archiveDir, { recursive: true });

		const rec1: RawRecord = { type: "guard_block", previousHash: GENESIS_HASH, ts: "t1" };
		const hash1 = computeEntryHash(rec1);
		const rec2: RawRecord = { type: "guard_warn", previousHash: hash1, ts: "t2" };
		const hash2 = computeEntryHash(rec2);
		const rec3: RawRecord = { type: "guard_allow", previousHash: hash2, ts: "t3" };
		const hash3 = computeEntryHash(rec3);

		writeFileSync(
			join(archiveDir, "seg-a.jsonl.gz"),
			gzipSync(Buffer.from(`${JSON.stringify({ ...rec1, hash: hash1 })}\n`, "utf-8")),
		);
		writeFileSync(
			join(archiveDir, "seg-b.jsonl.gz"),
			gzipSync(Buffer.from(`${JSON.stringify({ ...rec2, hash: hash2 })}\n`, "utf-8")),
		);
		writeFileSync(
			join(archiveDir, "seg-c.jsonl.gz"),
			gzipSync(Buffer.from(`${JSON.stringify({ ...rec3, hash: hash3 })}\n`, "utf-8")),
		);

		// Manifest deliberately lists segments OUT of seq order — correctness
		// depends on the sort actually running, and on manifest.json being
		// read as utf-8 text (not garbled/empty encoding).
		const manifest = {
			segments: [
				{ file: "seg-c.jsonl.gz", seq: 3 },
				{ file: "seg-a.jsonl.gz", seq: 1 },
				{ file: "seg-b.jsonl.gz", seq: 2 },
			],
		};
		writeFileSync(join(archiveDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

		const result = verifyAuditChain(cwd);
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(3);
		expect(result.guard_events).toBe(3);
		expect(result.last_hash).toBe(hash3);
	});
});
