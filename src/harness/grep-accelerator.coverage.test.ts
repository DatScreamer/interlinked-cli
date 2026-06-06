// ===========================================
// Grep Accelerator — supplementary coverage suite
// ===========================================
// The primary behavioral suite for the accelerator lives in
// __tests__/trigram-index.test.ts; it exercises the early-return guards
// (null index, no candidates, broad-pattern warning, staleness / size
// gates). This file targets the branches that ONLY run once the
// never-worse-than-native gates are *opened* — i.e. the actual
// acceleration path: in-process matching, real ripgrep execution,
// block-and-answer formatting, the dirty-layer fallthrough, glob/path
// filtering, output compression, and the FileContentCache.
//
// All searches run against a real on-disk temp cwd so matchInProcess /
// runRipgrepOnCandidates read genuine file content. ripgrep is detected
// via findRipgrep() — the rg-path assertions skip gracefully if rg is
// absent so the suite stays green on a bare runner.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	_resetRgPathCache,
	checkGrepAcceleration,
	FileContentCache,
	findRipgrep,
} from "./grep-accelerator.js";
import { extractTrigrams, type PostingList, TrigramIndex } from "./trigram-index.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

// Whether a real ripgrep binary is reachable. The runRipgrepOnCandidates
// branch only does useful work when it is; gate those assertions on it so
// the file passes on a runner without rg installed.
const RG_AVAILABLE = findRipgrep() !== null;

// ===========================================
// On-disk fixture helpers
// ===========================================

interface Fixture {
	dir: string;
	index: TrigramIndex;
}

/**
 * Build a TrigramIndex over real files written to a fresh temp directory.
 * The index `cwd` is that directory, so the accelerator's disk reads and
 * rg spawn resolve against actual content.
 */
function buildDiskFixture(files: Record<string, string>): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "grep-accel-cov-"));
	const filePaths = Object.keys(files);
	const postingsBuilder = new Map<number, number[]>();
	const fileArray: string[] = [];

	for (let fileId = 0; fileId < filePaths.length; fileId++) {
		const relPath = filePaths[fileId];
		fileArray.push(relPath);
		// Write the real file so matchInProcess / rg can read it.
		const abs = join(dir, relPath);
		const lastSlash = relPath.lastIndexOf("/");
		if (lastSlash >= 0) mkdirSync(join(dir, relPath.slice(0, lastSlash)), { recursive: true });
		writeFileSync(abs, files[relPath]);

		for (const tri of extractTrigrams(files[relPath])) {
			let list = postingsBuilder.get(tri);
			if (!list) {
				list = [];
				postingsBuilder.set(tri, list);
			}
			list.push(fileId);
		}
	}

	const postings = new Map<number, PostingList>();
	for (const [tri, list] of postingsBuilder) {
		const fileIds = new Uint32Array(list);
		postings.set(tri, {
			fileIds,
			locMasks: new Uint8Array(fileIds.length),
			nextMasks: new Uint8Array(fileIds.length),
		});
	}

	const index = new TrigramIndex(fileArray, postings, new Set(), "abc123", dir);
	return { dir, index };
}

function grepEvent(
	pattern: string,
	opts?: { path?: string; glob?: string; caseInsensitive?: boolean; outputMode?: string },
): HarnessEvent {
	const toolInput: Record<string, unknown> = { pattern };
	if (opts?.path !== undefined) toolInput.path = opts.path;
	if (opts?.glob !== undefined) toolInput.glob = opts.glob;
	if (opts?.caseInsensitive !== undefined) toolInput["-i"] = opts.caseInsensitive;
	if (opts?.outputMode !== undefined) toolInput.output_mode = opts.outputMode;
	return {
		hook_event: "PreToolUse",
		session_id: "test",
		agent_source: "claude",
		tool_name: "Grep",
		tool_input: toolInput,
		timestamp: FIXED_TIMESTAMP,
	};
}

function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: FIXED_TIMESTAMP,
	};
}

// All accelerated tests opt past the never-worse-than-native gates:
// indexFresh:true + minFilesForAccel:1 so even a tiny index is eligible.
// The tiny fixtures here make a matched pattern hit a high candidate ratio,
// so maxCandidateRatio:1 + a generous maxCandidates keep the default path on
// the BLOCK branch rather than the broad-pattern allow-with-warning. The two
// broad-pattern tests override these back down to assert that branch.
const ACCEL = {
	indexFresh: true,
	minFilesForAccel: 1,
	maxCandidateRatio: 1,
	maxCandidates: 500,
} as const;

// Track every temp dir so we can clean them all up at the end.
const createdDirs: string[] = [];
function fixture(files: Record<string, string>): Fixture {
	const f = buildDiskFixture(files);
	createdDirs.push(f.dir);
	return f;
}

beforeEach(() => {
	_resetRgPathCache();
});

afterAll(() => {
	for (const d of createdDirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

// ===========================================
// FileContentCache
// ===========================================

describe("FileContentCache", () => {
	it("stores and returns fresh content", () => {
		const cache = new FileContentCache();
		cache.set("a.ts", "hello");
		expect(cache.get("a.ts")).toBe("hello");
		expect(cache.size).toBe(1);
	});

	it("returns null for a missing key", () => {
		const cache = new FileContentCache();
		expect(cache.get("nope.ts")).toBeNull();
	});

	it("expires and deletes entries past their TTL", () => {
		// ttlMs = -1 forces `Date.now() - entry.ts > ttlMs` (a non-negative delta
		// > -1) to be true on the very next read regardless of wall-clock — a
		// synthetic value chosen purely to exercise the expiry branch + delete
		// deterministically (no sleeping, no fake timers).
		const cache = new FileContentCache(10, -1);
		cache.set("a.ts", "stale");
		expect(cache.get("a.ts")).toBeNull();
		// The stale read also evicted it.
		expect(cache.size).toBe(0);
	});

	it("evicts the oldest entry when at capacity", () => {
		const cache = new FileContentCache(2, 60_000);
		cache.set("first.ts", "1");
		cache.set("second.ts", "2");
		expect(cache.size).toBe(2);
		// Third insert is at capacity → oldest ("first.ts") is evicted.
		cache.set("third.ts", "3");
		expect(cache.size).toBe(2);
		expect(cache.get("first.ts")).toBeNull();
		expect(cache.get("second.ts")).toBe("2");
		expect(cache.get("third.ts")).toBe("3");
	});

	it("invalidates a specific entry", () => {
		const cache = new FileContentCache();
		cache.set("a.ts", "x");
		cache.invalidate("a.ts");
		expect(cache.get("a.ts")).toBeNull();
	});

	it("clears the whole cache", () => {
		const cache = new FileContentCache();
		cache.set("a.ts", "x");
		cache.set("b.ts", "y");
		cache.clear();
		expect(cache.size).toBe(0);
	});
});

// ===========================================
// Gate combinations (the second half of each && in the gate chain)
// ===========================================

describe("never-worse-than-native gates", () => {
	it("declines when a glob is supplied (output-shape gate)", () => {
		const { index } = fixture({ "a.ts": "uniqueidentifierforsearch here" });
		const ev = grepEvent("uniqueidentifierforsearch", { glob: "*.ts" });
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("declines when a non-content output mode is supplied", () => {
		const { index } = fixture({ "a.ts": "uniqueidentifierforsearch here" });
		const ev = grepEvent("uniqueidentifierforsearch", { outputMode: "files_with_matches" });
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("declines a pure-wildcard pattern (no extractable literals)", () => {
		const { index } = fixture({ "a.ts": "content" });
		// `.+` is regex-only wildcard → hasLiterals false.
		const ev = grepEvent(".+");
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});
});

// ===========================================
// Candidate filtering: path + dirty-layer fallthrough
// ===========================================

describe("candidate filtering", () => {
	it("filters candidates by a relative path prefix and blocks with a match", () => {
		const { index } = fixture({
			"src/auth.ts": "function uniquePathToken() {}",
			"lib/auth.ts": "function uniquePathToken() {}",
		});
		// path: "src" → only src/auth.ts survives the prefix filter.
		const ev = grepEvent("uniquePathToken", { path: "src" });
		const result = checkGrepAcceleration(ev, index, ACCEL);
		expect(result).not.toBeNull();
		const decision = result as HarnessDecision;
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("src/auth.ts");
		expect(decision.reason).not.toContain("lib/auth.ts");
	});

	it("resolves an absolute path filter against index.cwd", () => {
		const { dir, index } = fixture({
			"src/deep.ts": "function absolutePathToken() {}",
			"other.ts": "function absolutePathToken() {}",
		});
		// Absolute path inside the fixture → relative("src") after resolution.
		const ev = grepEvent("absolutePathToken", { path: join(dir, "src") });
		const result = checkGrepAcceleration(ev, index, ACCEL);
		expect(result).not.toBeNull();
		const decision = result as HarnessDecision;
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("src/deep.ts");
		expect(decision.reason).not.toContain("other.ts");
	});

	it("treats a trailing-slash path the same as the bare prefix", () => {
		const { index } = fixture({
			"pkg/mod.ts": "const trailingSlashToken = 1;",
			"top.ts": "const trailingSlashToken = 1;",
		});
		const ev = grepEvent("trailingSlashToken", { path: "pkg/" });
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("pkg/mod.ts");
	});

	it("falls through to null when a path filter removes every candidate", () => {
		const { index } = fixture({ "src/a.ts": "function noMatchInDir() {}" });
		// Pattern exists, but only under src/ — filtering on a non-existent dir
		// empties the candidate set → the zero-candidates fallthrough returns null.
		const ev = grepEvent("noMatchInDir", { path: "nonexistent" });
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("drops dirty new files (unresolvable id) and falls through to native", () => {
		// A file added only to the dirty layer has an id >= files.length, so the
		// candidate resolver (index.files[id] || getFilePath) yields undefined and
		// the .filter removes it. With no base candidate left, the accelerator
		// declines so native rg can still find the on-disk file.
		const { index } = fixture({ "base.ts": "totally different content xyz" });
		index.updateFile("dirtyOnly.ts", "function dirtyLayerToken() {}");
		const ev = grepEvent("dirtyLayerToken");
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});
});

// ===========================================
// In-process matching path (fixed-string, small candidate set)
// ===========================================

describe("in-process matching (fixed-string)", () => {
	it("blocks with grouped block-and-answer output for a literal Bash match", () => {
		const { index } = fixture({
			"a.ts": "const literalNeedle = 1;\nconst other = 2;\nliteralNeedle again;",
		});
		// rg -F → isRegex:false → in-process matcher (candidates <= threshold).
		const ev = bashEvent("rg -F 'literalNeedle'");
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		// Compressed grouped format: file header then `lineNum:content` rows.
		expect(result.reason).toContain("a.ts");
		expect(result.reason).toContain("1:const literalNeedle = 1;");
		expect(result.grep_stats?.accelerated).toBe(true);
		expect(result.grep_stats?.match_count).toBe(2);
	});

	it("matches case-insensitively in-process via rg -i -F", () => {
		const { index } = fixture({ "a.ts": "const CamelNeedle = 1;" });
		const ev = bashEvent("rg -i -F 'camelneedle'");
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("1:const CamelNeedle = 1;");
	});

	it("declines (null) when the in-process matcher finds zero real matches", () => {
		// The index over-selects: every trigram of "abcdefgh" is present (split
		// across two disjoint spans of the file), so the candidate set is
		// non-empty — but the contiguous literal never appears on a line, so the
		// in-process matcher returns matchCount 0 → checkGrepAcceleration declines
		// (290 → 295) so the agent sees native rg's empty result.
		const { index } = fixture({ "a.ts": "abcdefQQ QQefgh more text here" });
		const ev = bashEvent("rg -F 'abcdefgh'");
		// Force in-process by keeping it fixed-string + a tiny candidate set.
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, inProcessThreshold: 50 })).toBeNull();
	});

	it("skips files that cannot be read on disk and continues", () => {
		// Build an index referencing a phantom path that was never written to
		// disk, sharing trigrams with one real matching file. The unreadable
		// candidate hits the readFileSync catch (continue); the real one matches.
		const f = fixture({ "real.ts": "function ghostReadToken() {}" });
		const phantomFiles = ["real.ts", "phantom.ts"];
		const postingsBuilder = new Map<number, number[]>();
		for (let id = 0; id < phantomFiles.length; id++) {
			for (const tri of extractTrigrams("function ghostReadToken() {}")) {
				let list = postingsBuilder.get(tri);
				if (!list) {
					list = [];
					postingsBuilder.set(tri, list);
				}
				list.push(id);
			}
		}
		const postings = new Map<number, PostingList>();
		for (const [tri, list] of postingsBuilder) {
			const fileIds = new Uint32Array(list);
			postings.set(tri, {
				fileIds,
				locMasks: new Uint8Array(fileIds.length),
				nextMasks: new Uint8Array(fileIds.length),
			});
		}
		const index = new TrigramIndex(phantomFiles, postings, new Set(), "abc", f.dir);
		const ev = bashEvent("rg -F 'ghostReadToken'");
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		// real.ts matched; phantom.ts was skipped (read failed) without crashing.
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("real.ts");
		expect(result.reason).not.toContain("phantom.ts");
	});

	it("declines when the in-process result would exceed the output cap (truncation)", () => {
		// maxOutputLines:1 with two matching lines → truncated → decline so the
		// native command returns the complete result.
		const { index } = fixture({
			"a.ts": "capNeedle one\ncapNeedle two\ncapNeedle three",
		});
		const ev = bashEvent("rg -F 'capNeedle'");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, maxOutputLines: 1 })).toBeNull();
	});

	it("falls back to rg when in-process regex compilation fails (pattern over length cap)", () => {
		if (!RG_AVAILABLE) return;
		// safeRegExp rejects sources longer than 1000 chars. A fixed-string
		// pattern of 1001 plain chars routes through the in-process branch
		// (isRegex false, small candidate set), safeRegExp returns null, and the
		// matcher falls back to runRipgrepOnCandidates — which finds the literal.
		const longLiteral = "z".repeat(1001);
		const { index } = fixture({ "long.ts": `prefix ${longLiteral} suffix` });
		const ev = bashEvent(`rg -F '${longLiteral}'`);
		const result = checkGrepAcceleration(ev, index, {
			...ACCEL,
			inProcessThreshold: 50,
		}) as HarnessDecision;
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("long.ts");
	});
});

// ===========================================
// Ripgrep execution path (regex / forced spawn)
// ===========================================

describe("ripgrep execution", () => {
	it("blocks via real rg for a regex Grep query with multiple files", () => {
		if (!RG_AVAILABLE) return;
		const { index } = fixture({
			"src/a.ts": "export function rgRegexToken() {}",
			"src/b.ts": "export function rgRegexToken() { return 1; }",
			"unrelated.ts": "nothing to see here",
		});
		// Grep tool → isRegex:true → always rg.
		const ev = grepEvent("rgRegexToken");
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("src/a.ts");
		expect(result.reason).toContain("src/b.ts");
		expect(result.grep_stats?.accelerated).toBe(true);
		expect(result.grep_stats?.match_count).toBeGreaterThanOrEqual(2);
	});

	it("uses rg even for a fixed string when inProcessThreshold is 0", () => {
		if (!RG_AVAILABLE) return;
		const { index } = fixture({ "a.ts": "forcedRgNeedle on a line" });
		// inProcessThreshold:0 → candidates.length (>=1) > 0 forces the rg branch.
		const ev = bashEvent("rg -F 'forcedRgNeedle'");
		const result = checkGrepAcceleration(ev, index, {
			...ACCEL,
			inProcessThreshold: 0,
		}) as HarnessDecision;
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("forcedRgNeedle");
	});

	it("declines (null) when rg finds zero matches (over-selected stale candidate)", () => {
		if (!RG_AVAILABLE) return;
		// All required trigrams (from the literal "rgZeroToken") are present so the
		// candidate set is non-empty, but the regex demands a trailing digit the
		// file never has → rg exits 1 (no matches) → runRipgrepOnCandidates returns
		// matchCount 0 → checkGrepAcceleration declines (524 → 290 → 295).
		const { index } = fixture({ "a.ts": "rgZeroToken without any digit suffix" });
		const ev = grepEvent("rgZeroToken\\d");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, inProcessThreshold: 0 })).toBeNull();
	});

	it("passes --ignore-case to rg for a case-insensitive regex query", () => {
		if (!RG_AVAILABLE) return;
		// Grep tool with -i + regex → rg branch with --ignore-case (line 507).
		const { index } = fixture({ "a.ts": "const RgCaseToken = compute();" });
		const ev = grepEvent("rgcasetoken", { caseInsensitive: true });
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("RgCaseToken");
	});

	it("declines (null) when rg output exceeds the line cap (truncation)", () => {
		if (!RG_AVAILABLE) return;
		const lines = Array.from({ length: 8 }, (_, i) => `rgCapToken line ${i}`).join("\n");
		const { index } = fixture({ "a.ts": lines });
		const ev = grepEvent("rgCapToken");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, maxOutputLines: 2 })).toBeNull();
	});

	it("declines (null) when rg errors on a malformed regex (exit >= 2)", () => {
		if (!RG_AVAILABLE) return;
		// "rgErrToken[" decomposes to the single literal "rgErrToken" (the unclosed
		// char class contributes no segment), so every required trigram is present
		// → candidates non-empty → rg runs. rg then rejects the unterminated class
		// with exit 2 → runRipgrepOnCandidates returns null (527-528) →
		// checkGrepAcceleration declines (281-283) so the native command surfaces
		// the real parse error.
		const { index } = fixture({ "a.ts": "rgErrToken appears here" });
		const ev = grepEvent("rgErrToken[");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, inProcessThreshold: 0 })).toBeNull();
	});

	it("emits complete grep_stats on a single-file rg block", () => {
		if (!RG_AVAILABLE) return;
		const { index } = fixture({ "solo.ts": "soloStatToken on one line" });
		const ev = grepEvent("soloStatToken");
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		// Single candidate, single match → stats fully populated, selectivity 100%.
		expect(result.grep_stats).toBeDefined();
		expect(result.grep_stats?.candidates).toBe(1);
		expect(result.grep_stats?.total_files).toBe(1);
		expect(result.grep_stats?.selectivity_pct).toBe(100);
		// rg omits the path for a lone file arg; --with-filename restores it.
		expect(result.reason).toContain("solo.ts");
	});
});

// ===========================================
// Broad-pattern allow-with-warning (ratio + maxCandidates branches)
// ===========================================

describe("broad-pattern handling", () => {
	it("allows with a warning when candidate ratio exceeds the cap", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 12; i++) {
			files[`file${i}.ts`] = `const broadShared${i} = sharedTokenHere;`;
		}
		const { index } = fixture(files);
		// "sharedTokenHere" is in every file → ratio 1.0 > 0.3.
		const ev = grepEvent("sharedTokenHere");
		const result = checkGrepAcceleration(ev, index, {
			...ACCEL,
			maxCandidateRatio: 0.3,
		}) as HarnessDecision;
		expect(result.decision).toBe("allow");
		expect(result.warnings?.some((w) => w.includes("broad pattern"))).toBe(true);
		expect(result.grep_stats?.accelerated).toBe(false);
	});

	it("allows with a warning when candidate count exceeds maxCandidates", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 6; i++) {
			files[`f${i}.ts`] = `const countShared${i} = countTokenHere;`;
		}
		const { index } = fixture(files);
		// maxCandidates:2 with 6 matching files → count cap trips first.
		const ev = grepEvent("countTokenHere");
		const result = checkGrepAcceleration(ev, index, {
			...ACCEL,
			maxCandidates: 2,
			maxCandidateRatio: 0.99,
		}) as HarnessDecision;
		expect(result.decision).toBe("allow");
		expect(result.warnings?.[0]).toContain("broad pattern");
	});
});

// ===========================================
// Output compression (content-mode grouping across files + separators)
// ===========================================

describe("output compression", () => {
	it("groups matches from multiple files under per-file headers", () => {
		const { index } = fixture({
			"foo.ts": "compressGroupTok a\ncompressGroupTok b",
			"bar.ts": "compressGroupTok c",
		});
		const ev = bashEvent("rg -F 'compressGroupTok'");
		const result = checkGrepAcceleration(ev, index, ACCEL) as HarnessDecision;
		expect(result.decision).toBe("block");
		const reason = result.reason ?? "";
		// Both file headers present, with a blank line separating groups.
		expect(reason).toContain("foo.ts");
		expect(reason).toContain("bar.ts");
		expect(reason).toContain("1:compressGroupTok a");
		expect(reason).toContain("2:compressGroupTok b");
		// A blank line appears between the two file groups.
		expect(reason).toMatch(/\n\n/);
	});
});

// ===========================================
// findRipgrep + cache reset
// ===========================================

describe("findRipgrep", () => {
	it("memoizes the resolved path across calls", () => {
		_resetRgPathCache();
		const first = findRipgrep();
		const second = findRipgrep();
		// Second call hits the `_rgPath !== undefined` early return → same value.
		expect(second).toBe(first);
	});

	it("re-resolves to the same value after a cache reset", () => {
		const before = findRipgrep();
		_resetRgPathCache();
		const after = findRipgrep();
		// On any given machine resolution is stable, so the value matches, but the
		// reset forced the lookup to run again (cache-miss path re-executed).
		expect(after).toBe(before);
	});
});
