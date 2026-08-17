// Mutation-kill companion for src/harness/trigram-index-serialization.ts.
// Targets the 42 survivor mutants (of 57 total; the remaining 15 are
// equivalence candidates recorded in
// scratch/fleet-r3/receipts/src_harness_trigram-index-serialization.ts.jsonl)
// that the existing trigram-index-serialization.test.ts round-trip/corruption
// suite does not distinguish. Every hardcoded expected value below was
// verified against a live call to the pristine module before being written
// here (see scratch/fleet-r3/tis-occurrence-final.json and the shadow-verify
// / fuzz-equivalence scripts in the same directory for the full audit trail).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PostingList } from "./trigram-primitives.js";
import { computeIndexStats, loadIndex, loadIndexMeta, saveIndex } from "./trigram-index-serialization.js";

function posting(fileIds: number[], locMask = 0b011, nextMask = 0b101): PostingList {
	return {
		fileIds: Uint32Array.from(fileIds),
		locMasks: Uint8Array.from(fileIds.map(() => locMask)),
		nextMasks: Uint8Array.from(fileIds.map(() => nextMask)),
	};
}

describe("computeIndexStats — byte accounting", () => {
	// test-contract: invariant — computeIndexStats' byte-size fields are a
	// public contract (surfaced by `interlinked index status` and capacity
	// tooling); each additive term (28-byte header, 2+pathBytes per file,
	// 4 bytes per stop trigram, 16 bytes per lookup-table entry, 6 bytes per
	// posting fileId) must contribute exactly its documented amount, and
	// indexSizeBytes must be their sum.
	it("accounts every byte contributor exactly for a mixed files/postings/stopTrigrams input", () => {
		const postings = new Map<number, PostingList>([
			[100, posting([1, 2])],
			[200, posting([3, 4, 5])],
		]);
		const stats = computeIndexStats(["ab", "xyz"], postings, new Set([10, 20, 30]), "c1", "2026");
		// lookupSizeBytes = 28 (header) + (2+2) + (2+3) [files] + 3*4 [stops] + 2*16 [postings] = 81
		expect(stats.lookupSizeBytes).toBe(81);
		// postingsSizeBytes = 2*6 + 3*6 = 30
		expect(stats.postingsSizeBytes).toBe(30);
		// indexSizeBytes = lookupSizeBytes + postingsSizeBytes = 111
		expect(stats.indexSizeBytes).toBe(111);
	});
});

describe("saveIndex / loadIndex — boundary guards and on-disk byte layout", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "trigram-mkill-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — a commit-length byte that claims more bytes
	// than actually remain in the lookup file must fail closed (null); it
	// must not silently truncate-read and continue parsing from a corrupted
	// offset, which would surface downstream as garbage baseCommit/file data
	// instead of an honest "index unreadable" signal.
	it("returns null when the commit-length byte overclaims remaining bytes", () => {
		saveIndex([], new Map(), new Set(), "", "", tmp);
		const lookupPath = join(tmp, ".interlinked", "index", "trigram.lookup");
		const good = readFileSync(lookupPath); // 30 bytes: header(28)+commitLen(1,=0)+builtAtLen(1,=0)
		const corrupted = Buffer.from(good);
		corrupted.writeUInt8(200, 28); // claim commitLen=200; only 1 byte actually follows
		writeFileSync(lookupPath, corrupted);
		expect(loadIndex(tmp)).toBeNull();
	});

	// test-contract: boundary — the sibling guard for the builtAt-length
	// byte: an overclaim must leave builtAt at its documented live-timestamp
	// default, not a truncated/garbage string that fails to parse as a date.
	it("leaves builtAt at a valid-ISO default when the builtAt-length byte overclaims remaining bytes", () => {
		saveIndex([], new Map(), new Set(), "", "", tmp);
		const lookupPath = join(tmp, ".interlinked", "index", "trigram.lookup");
		const good = readFileSync(lookupPath);
		const corrupted = Buffer.from(good);
		corrupted.writeUInt8(200, 29); // claim builtAtLen=200; 0 bytes actually follow
		writeFileSync(lookupPath, corrupted);
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		// A truncated-read garbage builtAt ("") throws here; only a correctly
		// defaulted live ISO timestamp round-trips through toISOString().
		expect(() => new Date(loaded?.builtAt ?? "").toISOString()).not.toThrow();
	});

	// test-contract: boundary — an empty-string file path is a legal (if
	// degenerate) file-table entry. The exact-boundary case where only the
	// 2-byte pathLen field remains in the buffer (0 path bytes follow) must
	// still parse successfully, not false-block a legitimately-sized index.
	it("round-trips a file table entry whose path is the empty string, at the exact buffer-end boundary", () => {
		saveIndex([""], new Map(), new Set(), "", "", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		expect(loaded?.files).toEqual([""]);
	});

	// test-contract: boundary — a path-length field that overclaims remaining
	// bytes must fail closed (null), mirroring the commitLen/builtAtLen
	// guards above, rather than returning a silently-truncated file path.
	it("returns null when a file table entry's path-length overclaims remaining bytes", () => {
		saveIndex(["a"], new Map(), new Set(), "", "", tmp);
		const lookupPath = join(tmp, ".interlinked", "index", "trigram.lookup");
		const good = readFileSync(lookupPath); // header(28)+meta(2)+fileTable(pathLen=1@30-31,'a'@32)=33 bytes
		const corrupted = Buffer.from(good);
		corrupted.writeUInt16LE(100, 30); // claim pathLen=100; only 1 byte actually follows
		writeFileSync(lookupPath, corrupted);
		expect(loadIndex(tmp)).toBeNull();
	});

	// test-contract: boundary — a posting entry's byte-length (count*6),
	// read from the lookup table, that exceeds the actual postings file size
	// must fail closed (null) rather than performing an out-of-bounds
	// Buffer read (which throws RangeError and crashes the caller instead
	// of returning the documented "corrupt index" null signal).
	it("returns null (does not throw) when a posting entry's byte count exceeds the truncated postings file", () => {
		const postings = new Map<number, PostingList>([[1, posting([1, 2, 3, 4, 5, 6])]]); // count=6 -> 36 bytes required
		saveIndex([], postings, new Set(), "", "", tmp);
		const postingsPath = join(tmp, ".interlinked", "index", "trigram.postings");
		const goodPostings = readFileSync(postingsPath);
		writeFileSync(postingsPath, goodPostings.subarray(0, 5)); // truncate to 5 bytes (< 36 required)
		expect(() => loadIndex(tmp)).not.toThrow();
		expect(loadIndex(tmp)).toBeNull();
	});

	// test-contract: invariant — the file-format doc comment promises stop
	// trigrams are written "sorted for deterministic output"; the on-disk
	// section must be ascending numeric order regardless of Set insertion
	// order. loadIndex's returned Set preserves iteration = on-disk read
	// order, which reflects the on-disk write order, so this is directly
	// observable through the public round-trip API.
	it("writes stop trigrams to disk in ascending numeric order regardless of insertion order", () => {
		saveIndex([], new Map(), new Set([500, 100, 300]), "", "", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		expect([...(loaded?.stopTrigrams ?? [])]).toEqual([100, 300, 500]);
	});

	// test-contract: invariant — the file-format doc comment promises
	// "Sort trigrams by FNV-1a hash for lookup table"; the on-disk lookup
	// table must be ascending-by-hash order regardless of Map insertion
	// order. Expected order independently verified against the fnv1a
	// implementation in trigram-primitives.ts for this exact key set.
	it("writes posting entries to disk sorted by fnv1a hash ascending, not insertion order", () => {
		const postings = new Map<number, PostingList>([
			[5000, posting([1])],
			[1000, posting([2])],
			[9000, posting([3])],
			[3000, posting([4])],
			[7000, posting([5])],
		]);
		saveIndex([], postings, new Set(), "", "", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		expect([...(loaded?.postings.keys() ?? [])]).toEqual([5000, 7000, 9000, 1000, 3000]);
	});

	// test-contract: invariant — meta.json's average-mask-bit fields must be
	// exactly 0 (not NaN from a 0/0 division) when the index has no
	// postings; saveIndex computes this field independently of
	// computeIndexStats and both must honor the same zero-postings contract.
	it("meta.json reports exactly zero average mask bits when there are no postings", () => {
		saveIndex([], new Map(), new Set(), "c1", "2026", tmp);
		const meta = loadIndexMeta(tmp);
		expect(meta?.avgLocMaskBits).toBe(0);
		expect(meta?.avgNextMaskBits).toBe(0);
	});

	// test-contract: invariant — meta.json's byte-size and average-mask-bit
	// fields must reflect the ACTUAL constructed lookup/postings buffers and
	// the actual popcount of every posting's locMask/nextMask; saveIndex
	// computes these directly from lookupBuf.length/postingsBuf.length (not
	// the analytic estimate computeIndexStats uses), so this exercises a
	// separate code path than the computeIndexStats test above.
	it("meta.json reports exact byte sizes and average mask-bit counts across postings with nonzero masks", () => {
		const postings = new Map<number, PostingList>([
			[1, posting([1], 0xff, 0x0f)], // locMask 8 bits set, nextMask 4 bits set
			[2, posting([2], 0xff, 0x0f)],
		]);
		saveIndex([], postings, new Set(), "c1", "2026", tmp);
		const meta = loadIndexMeta(tmp);
		// totalPostings=2, totalLocBits=16, totalNextBits=8
		expect(meta?.avgLocMaskBits).toBe(8);
		expect(meta?.avgNextMaskBits).toBe(4);
		// header(28) + meta(2+"c1".length(2)+"2026".length(4)=8) + fileTable(0) + stopBuf(0) + lookupTable(2*16=32) = 68
		expect(meta?.lookupSizeBytes).toBe(68);
		// postingsSizeBytes = 1*6 + 1*6 = 12
		expect(meta?.postingsSizeBytes).toBe(12);
		// indexSizeBytes = 68 + 12 = 80
		expect(meta?.indexSizeBytes).toBe(80);
	});
});
