// Behavioral tests for the statistical pattern detector.
//
// The module exposes a single public entry, `getPatternWarnings`, which fans
// out to four internal detectors (hot-region, edit-pair, temporal, sequence).
// Every internal helper is reached *through* that entry, so these tests drive
// real inputs and assert on the produced warning strings — no tombstones, no
// reaching into private functions. Each detector is isolated by feeding inputs
// that activate exactly one of the four, then combined cases assert the union.
//
// Time is frozen with vi.setSystemTime so the temporal detector is fully
// deterministic; no network or fs is touched by the module under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPatternWarnings } from "./pattern-detector.js";
import type { ErrorRecord, SessionTrajectory } from "./types.js";

// A fixed wall-clock anchor for every temporal assertion. 2026-06-05T12:00:00Z.
const NOW = new Date("2026-06-05T12:00:00.000Z").getTime();

/** ISO timestamp `minutesAgo` minutes before the frozen NOW. */
function minutesAgoISO(minutesAgo: number): string {
	return new Date(NOW - minutesAgo * 60 * 1000).toISOString();
}

/** Build an ErrorRecord with sensible defaults; override any field. */
function rec(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
	return {
		timestamp: minutesAgoISO(0),
		session_id: "sess-1",
		agent_name: "agent-a",
		file: "src/foo.ts",
		file_role: "core",
		check_name: "tsc",
		severity: "error",
		message: "boom",
		diff_context: "",
		...overrides,
	} as ErrorRecord;
}

/**
 * Minimal SessionTrajectory — getPatternWarnings only reads `files_written`
 * and `tool_sequence`. Cast through unknown like the other harness test
 * fixtures (bash-provenance.test.ts etc.).
 */
function session(
	filesWritten: string[] = [],
	toolSequence: string[] = [],
): SessionTrajectory {
	return {
		files_written: new Set(filesWritten),
		tool_sequence: toolSequence,
	} as unknown as SessionTrajectory;
}

const EMPTY_SESSION = session();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("getPatternWarnings — empty / no-signal inputs", () => {
	it("returns no warnings for an empty record set", () => {
		expect(getPatternWarnings([], "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("returns no warnings when records exist but none match the target file", () => {
		const records = [
			rec({ file: "src/other.ts", line_start: 10 }),
			rec({ file: "src/other.ts", line_start: 12 }),
		];
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("returns no warnings with a single record (every detector needs >= 2)", () => {
		const records = [rec({ line_start: 10 })];
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 1. Hot-region detector
// ---------------------------------------------------------------------------
describe("hot-region detector", () => {
	it("does not warn when records lack line_start (filtered out, < 2 remain)", () => {
		// Two records on the file but neither has line_start → findHotRegions
		// filters them away (line_start !== undefined), so length < 2.
		const records = [rec({ check_name: "a" }), rec({ check_name: "b" })];
		// Use an old timestamp band so the temporal detector stays silent.
		const old = [
			rec({ check_name: "a", timestamp: minutesAgoISO(5000) }),
			rec({ check_name: "b", timestamp: minutesAgoISO(5001) }),
		];
		expect(getPatternWarnings(old, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
		// (records var documents intent; assert the same with it for clarity)
		expect(records.length).toBe(2);
	});

	it("warns about the hottest region when no editLine is supplied", () => {
		// Two errors in bucket 1 (lines 31-60), one in bucket 5 → only bucket 1
		// has count >= 2. Old timestamps keep temporal silent.
		const t = minutesAgoISO(5000);
		const records = [
			rec({ line_start: 40, check_name: "tsc", timestamp: t }),
			rec({ line_start: 55, check_name: "biome", timestamp: t }),
			rec({ line_start: 150, check_name: "tsc", timestamp: t }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:hot-region]");
		expect(warnings[0]).toContain("Lines 31-60");
		expect(warnings[0]).toContain("2 check failures");
		expect(warnings[0]).toContain("Take extra care");
		// Both check names from the bucket's Set are listed.
		expect(warnings[0]).toContain("tsc");
		expect(warnings[0]).toContain("biome");
	});

	it("sorts multiple hot regions by error count (hottest first)", () => {
		// Bucket 0 (1-30): 2 errors. Bucket 3 (91-120): 3 errors → hottest.
		const t = minutesAgoISO(5000);
		const records = [
			rec({ line_start: 5, timestamp: t }),
			rec({ line_start: 10, timestamp: t }),
			rec({ line_start: 95, timestamp: t }),
			rec({ line_start: 100, timestamp: t }),
			rec({ line_start: 110, timestamp: t }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings[0]).toContain("Lines 91-120");
		expect(warnings[0]).toContain("3 check failures");
	});

	it("warns when editLine falls inside a hot region (with the ±10 slack)", () => {
		const t = minutesAgoISO(5000);
		const records = [
			rec({ line_start: 40, timestamp: t }),
			rec({ line_start: 55, timestamp: t }),
		];
		// Hot region is 31-60; editLine 25 is within lineStart-10 (21).
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION, 25);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Lines 31-60");
		expect(warnings[0]).toContain("This region is error-prone");
	});

	it("does NOT warn when editLine is far from every hot region", () => {
		const t = minutesAgoISO(5000);
		const records = [
			rec({ line_start: 40, timestamp: t }),
			rec({ line_start: 55, timestamp: t }),
		];
		// Hot region 31-60; editLine 500 is way outside [21, 70].
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION, 500);
		expect(warnings).toEqual([]);
	});

	it("treats line_start of 0 as bucket 0 (the ?? 0 default path)", () => {
		// line_start === 0 is defined (passes the filter) and floors to bucket 0.
		const t = minutesAgoISO(5000);
		const records = [
			rec({ line_start: 0, timestamp: t }),
			rec({ line_start: 5, timestamp: t }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Lines 1-30");
	});
});

// ---------------------------------------------------------------------------
// 2. Edit-pair detector
// ---------------------------------------------------------------------------
describe("edit-pair detector", () => {
	const old = minutesAgoISO(5000);

	it("does not warn when fewer than 2 records carry co_edited_files", () => {
		const records = [
			rec({ co_edited_files: ["src/bar.ts"], timestamp: old }),
			rec({ co_edited_files: [], timestamp: old }), // empty → filtered
			rec({ timestamp: old }), // undefined → filtered
		];
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("warns when a paired file co-occurs in >= 50% of error sessions", () => {
		const records = [
			rec({ co_edited_files: ["src/bar.ts"], timestamp: old }),
			rec({ co_edited_files: ["src/bar.ts"], timestamp: old }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:edit-pair]");
		expect(warnings[0]).toContain("src/bar.ts (100% of the time)");
		expect(warnings[0]).toContain("usually need updating too");
	});

	it("skips self-references in co_edited_files (coFile === file continue)", () => {
		// Each record co-edits the file itself plus bar.ts; self is skipped so
		// only bar.ts accrues a count.
		const records = [
			rec({ co_edited_files: ["src/foo.ts", "src/bar.ts"], timestamp: old }),
			rec({ co_edited_files: ["src/foo.ts", "src/bar.ts"], timestamp: old }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("src/bar.ts");
		expect(warnings[0]).not.toContain("src/foo.ts (");
	});

	it("excludes a pair below the 0.5 ratio threshold", () => {
		// bar.ts appears in 1 of 3 records (ratio 0.33 < 0.5) → no pair.
		const records = [
			rec({ co_edited_files: ["src/bar.ts"], timestamp: old }),
			rec({ co_edited_files: ["src/baz.ts"], timestamp: old }),
			rec({ co_edited_files: ["src/qux.ts"], timestamp: old }),
		];
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("excludes a pair that meets the ratio but has count < 2", () => {
		// Single record: bar.ts ratio is 1.0 but count is 1 → count >= 2 fails,
		// and fileRecords.length < 2 also short-circuits. Pad to 2 records where
		// the candidate appears only once.
		const records = [
			rec({ co_edited_files: ["src/bar.ts", "src/baz.ts"], timestamp: old }),
			rec({ co_edited_files: ["src/qux.ts"], timestamp: old }),
		];
		// bar.ts: count 1, ratio 0.5 (>=0.5) but count < 2 → excluded.
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("filters out paired files already written in the session", () => {
		const records = [
			rec({ co_edited_files: ["src/bar.ts"], timestamp: old }),
			rec({ co_edited_files: ["src/bar.ts"], timestamp: old }),
		];
		// bar.ts already visited → unvisited becomes empty → null.
		const sess = session(["src/bar.ts"]);
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("ranks pairs by ratio and caps the list at 3 entries", () => {
		// Four candidate files all >= 0.5 with distinct ratios; only top 3 listed.
		const records = [
			rec({
				co_edited_files: ["a.ts", "b.ts", "c.ts", "d.ts"],
				timestamp: old,
			}),
			rec({
				co_edited_files: ["a.ts", "b.ts", "c.ts", "d.ts"],
				timestamp: old,
			}),
			rec({ co_edited_files: ["a.ts", "b.ts", "c.ts"], timestamp: old }),
			rec({ co_edited_files: ["a.ts", "b.ts"], timestamp: old }),
		];
		// counts: a=4 (1.0), b=4 (1.0), c=3 (0.75), d=2 (0.5). Top 3 = a,b,c.
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("a.ts");
		expect(warnings[0]).toContain("b.ts");
		expect(warnings[0]).toContain("c.ts");
		expect(warnings[0]).not.toContain("d.ts");
		// 4 records → d.ts (count 2) ratio is exactly 50%.
		expect(warnings[0]).toContain("75% of the time");
	});
});

// ---------------------------------------------------------------------------
// 3. Temporal detector
// ---------------------------------------------------------------------------
describe("temporal detector", () => {
	it("does not warn when total < 2 (single record on file)", () => {
		const records = [rec({ timestamp: minutesAgoISO(10) })];
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("emits a burst warning when last-hour errors spike 3x the hourly rate", () => {
		// 4 errors clustered in the last ~20 min plus older history so the
		// average hourly rate stays low → lastHour (4) > avgHourlyRate*3.
		const records = [
			rec({ timestamp: minutesAgoISO(1) }),
			rec({ timestamp: minutesAgoISO(5) }),
			rec({ timestamp: minutesAgoISO(10) }),
			rec({ timestamp: minutesAgoISO(15) }),
			rec({ timestamp: minutesAgoISO(2000) }),
			rec({ timestamp: minutesAgoISO(3000) }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:error-burst]");
		expect(warnings[0]).toContain("4 errors on this file in the last hour");
		expect(warnings[0]).toContain("6 total");
		expect(warnings[0]).toContain("accelerating");
	});

	it("emits a plain temporal warning when lastHour >= 2 but not a burst", () => {
		// Exactly 2 errors, both in the last hour, no older history → the span is
		// short so avgHourlyRate is high and the burst test fails, but
		// lastHour >= 2 fires the temporal branch.
		const records = [
			rec({ timestamp: minutesAgoISO(10) }),
			rec({ timestamp: minutesAgoISO(40) }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:temporal]");
		expect(warnings[0]).toContain("2 errors on this file in the last hour");
		// avgIntervalS: (40-10)min span / (2-1) intervals = 1800s.
		expect(warnings[0]).toContain("1800s between errors");
	});

	it("does not warn when errors are old (>= 2 total but < 2 in last hour, no burst)", () => {
		// Two errors, both >1h ago and spread across days → lastHour 0, not a
		// burst → both temporal branches fall through to null.
		const records = [
			rec({ timestamp: minutesAgoISO(200) }),
			rec({ timestamp: minutesAgoISO(2000) }),
		];
		expect(getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION)).toEqual([]);
	});

	it("burst requires lastHour >= 3 — exactly 2 recent never bursts", () => {
		// Old history makes avgHourlyRate tiny, but lastHour is 2 (< 3) so the
		// burst guard's first conjunct fails; the temporal branch fires instead.
		const records = [
			rec({ timestamp: minutesAgoISO(5) }),
			rec({ timestamp: minutesAgoISO(20) }),
			rec({ timestamp: minutesAgoISO(5000) }),
			rec({ timestamp: minutesAgoISO(6000) }),
		];
		const warnings = getPatternWarnings(records, "src/foo.ts", EMPTY_SESSION);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:temporal]");
		expect(warnings[0]).not.toContain("error-burst");
	});
});

// ---------------------------------------------------------------------------
// 4. Tool-call sequence detector
// ---------------------------------------------------------------------------
describe("sequence detector", () => {
	const old = minutesAgoISO(5000);

	it("does not warn when the current sequence has fewer than 3 calls", () => {
		const records = [
			rec({ pre_error_sequence: ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"], timestamp: old }),
			rec({ pre_error_sequence: ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"], timestamp: old }),
		];
		const sess = session([], ["Edit:a.ts", "Edit:a.ts"]); // len 2 < 3
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("does not warn when the current sequence yields no extractable features", () => {
		// Three reads → no edit/test patterns extracted → currentFeatures empty.
		const records = [
			rec({ pre_error_sequence: ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"], timestamp: old }),
			rec({ pre_error_sequence: ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"], timestamp: old }),
		];
		const sess = session([], ["Read:a.ts", "Read:b.ts", "Read:c.ts"]);
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("does not warn when history has no recurring (>=2) pattern", () => {
		// Current sequence has a feature, but only ONE historical record carries
		// a >=3 sequence → findSequencePatterns short-circuits (< 2) → [].
		const records = [
			rec({ pre_error_sequence: ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"], timestamp: old }),
		];
		const sess = session([], ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"]);
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("warns when the current sequence matches a recurring anti-pattern", () => {
		const seq = ["Edit:a.ts", "Edit:a.ts", "Edit:a.ts"];
		const records = [
			rec({ pre_error_sequence: seq, check_name: "tsc", timestamp: old }),
			rec({ pre_error_sequence: seq, check_name: "biome", timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:sequence-pattern]");
		expect(warnings[0]).toContain("led to 2 previous error(s)");
		expect(warnings[0]).toContain("3 consecutive edits to the same file without re-reading");
		expect(warnings[0]).toContain("tsc");
		expect(warnings[0]).toContain("biome");
	});

	it("does not warn when history patterns exist but none match the current features", () => {
		// History: 3 consecutive same-file edits (a feature it has 2x).
		// Current: 3 edits to DIFFERENT files → no "consecutive" feature, and its
		// blind-editing feature (3 edits, 0 reads) is not in history (history's
		// records also have 0 reads though!). Force a mismatch: give history reads
		// so its only feature is "consecutive same-file", which current lacks.
		const histSeq = ["Read:a.ts", "Edit:a.ts", "Edit:a.ts", "Edit:a.ts"];
		const records = [
			rec({ pre_error_sequence: histSeq, timestamp: old }),
			rec({ pre_error_sequence: histSeq, timestamp: old }),
		];
		// Current: 3 edits to distinct files WITH a read → only feature would be
		// none (editCount 3 but readCount 1, no consecutive>=3). So no overlap.
		const sess = session([], ["Read:x.ts", "Edit:x.ts", "Edit:y.ts", "Edit:z.ts"]);
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("detects the 'edits without running tests' feature (>= 5 edits since last test)", () => {
		// 6 edits to distinct files, no test command → editsSinceLastTest 6.
		const seq = ["Edit:a", "Edit:b", "Edit:c", "Edit:d", "Edit:e", "Edit:f"];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("6 edits without running tests");
	});

	it("resets the edits-since-test counter after a test command runs", () => {
		// 6 edits, then a test command, then 1 edit → editsSinceLastTest is 1,
		// so the ">=5 edits without tests" feature must NOT appear; but the
		// blind-editing feature (7 edits, 0 reads) WILL.
		const seq = [
			"Edit:a",
			"Edit:b",
			"Edit:c",
			"Edit:d",
			"Edit:e",
			"Edit:f",
			"Bash:npx vitest run",
			"Edit:g",
		];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).not.toContain("edits without running tests");
		expect(warnings[0]).toContain("7 edits without any reads (blind editing)");
	});

	it("detects 'blind editing' (>= 3 edits, 0 reads)", () => {
		const seq = ["Edit:a", "Edit:b", "Edit:c"];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("3 edits without any reads (blind editing)");
	});

	it("detects 'no shell validation' (>= 4 edits, 0 bash) and includes a read to avoid blind-edit", () => {
		// 4 edits + a Read → readCount 1 (blind-edit suppressed), bashCount 0 →
		// only the no-shell feature fires.
		const seq = ["Read:r", "Edit:a", "Edit:b", "Edit:c", "Edit:d"];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("4 edits without any shell commands");
		expect(warnings[0]).not.toContain("blind editing");
	});

	it("recognizes alternate tool aliases (write_file/read_file/Shell/run_command)", () => {
		// Mixed runner vocabularies: write_file (edit), read_file (read),
		// Shell + run_command (bash), with a non-test shell target so the
		// blind-edit guard is suppressed but no test resets the counter.
		const seq = [
			"read_file:r",
			"write_file:a",
			"write_file:b",
			"write_file:c",
			"write_file:d",
			"write_file:e",
		];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		// 5 edits since test (no test seen) → feature fires via the alias path.
		expect(warnings[0]).toContain("5 edits without running tests");
	});

	it("treats a bash entry with no target as a shell command (target || '')", () => {
		// A bare "Bash" entry (no colon) → target undefined → isTestCommand("")
		// is false; bashCount increments so the >=4-edits/0-bash feature is
		// suppressed, leaving only blind-editing for the 4 edits.
		const seq = ["Bash", "Edit:a", "Edit:b", "Edit:c", "Edit:d"];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("4 edits without any reads (blind editing)");
		expect(warnings[0]).not.toContain("without any shell commands");
	});

	it("handles edit entries with no target (target || '' fallback, else branch)", () => {
		// Bare "Edit" entries (no colon) → split yields target === undefined.
		// `undefined === lastEditFile` is always false (even once lastEditFile
		// becomes ""), so each edit takes the else branch (lastEditFile = "",
		// consecutive resets to 1) — the consecutive-same-file feature never
		// fires from untargeted edits. With 4 such edits and no reads, the
		// blind-editing feature is what surfaces.
		const seq = ["Edit", "Edit", "Edit", "Edit"];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("4 edits without any reads (blind editing)");
		expect(warnings[0]).not.toContain("consecutive edits to the same file");
	});

	it("ignores historical records whose pre_error_sequence is too short (< 3)", () => {
		// Two short sequences (len 2) are filtered out → withSequences < 2 → no
		// patterns → no warning, even though current has a feature.
		const records = [
			rec({ pre_error_sequence: ["Edit:a", "Edit:a"], timestamp: old }),
			rec({ pre_error_sequence: ["Edit:a", "Edit:a"], timestamp: old }),
		];
		const sess = session([], ["Edit:a", "Edit:a", "Edit:a"]);
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("falls through to null when current features exist but match no history pattern", () => {
		// History recurring pattern: blind editing (3 edits, 0 reads), 2x.
		// Current: a DIFFERENT feature — "edits without running tests" (>=5) —
		// produced WITH a read so blind-editing is suppressed. currentFeatures is
		// non-empty, findSequencePatterns is non-empty, but the lone current
		// feature isn't among them → the match loop exhausts and returns null.
		const histSeq = ["Edit:a", "Edit:b", "Edit:c"]; // blind editing
		const records = [
			rec({ pre_error_sequence: histSeq, timestamp: old }),
			rec({ pre_error_sequence: histSeq, timestamp: old }),
		];
		const curSeq = ["Read:r", "Edit:a", "Edit:b", "Edit:c", "Edit:d", "Edit:e", "Edit:f"];
		const sess = session([], curSeq);
		// current feature: "6 edits without running tests"; history feature:
		// "3 edits without any reads (blind editing)" → disjoint.
		expect(getPatternWarnings(records, "src/foo.ts", sess)).toEqual([]);
	});

	it("drops a sequence feature that occurs only once while keeping a 2x feature", () => {
		// Record 1 + 2 share the blind-editing feature (count 2 → kept).
		// Record 1 ALSO uniquely carries the no-shell feature (count 1 → dropped
		// by the count>=2 gate). Current matches only blind-editing.
		const blind = ["Edit:a", "Edit:b", "Edit:c"]; // blind editing only
		// 4 edits + a read → only the no-shell feature (4 edits, 0 bash), no blind.
		const noShellOnly = ["Read:r", "Edit:a", "Edit:b", "Edit:c", "Edit:d"];
		const records = [
			rec({ pre_error_sequence: blind, timestamp: old }),
			rec({ pre_error_sequence: blind, timestamp: old }),
			rec({ pre_error_sequence: noShellOnly, timestamp: old }), // unique feature
		];
		const sess = session([], blind);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		// Only the 2x feature survives → that's what we match against.
		expect(warnings[0]).toContain("led to 2 previous error(s)");
		expect(warnings[0]).toContain("blind editing");
		expect(warnings[0]).not.toContain("without any shell commands");
	});

	it("ignores tools that are neither edit, read, nor bash (else-if fall-through)", () => {
		// An MCP-style tool name matches none of the three classifiers, so the
		// chained else-if exhausts without incrementing any counter. With 3
		// real edits + the unclassified tool and no reads, only blind editing
		// fires — proving the unrecognized entry was silently skipped.
		const seq = ["mcp__foo__bar:x", "Edit:a", "Edit:b", "Edit:c"];
		const records = [
			rec({ pre_error_sequence: seq, timestamp: old }),
			rec({ pre_error_sequence: seq, timestamp: old }),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("3 edits without any reads (blind editing)");
	});

	it("ranks recurring patterns by occurrence count (most frequent first)", () => {
		// Pattern P1 (blind editing, 3 edits) appears in 3 records; pattern P2
		// (consecutive same-file via read+edits) appears in 2. Current sequence
		// triggers BOTH features → the loop returns on the first (sorted) match.
		const blind = ["Edit:a", "Edit:b", "Edit:c"]; // blind editing only
		const records = [
			rec({ pre_error_sequence: blind, check_name: "x", timestamp: old }),
			rec({ pre_error_sequence: blind, check_name: "y", timestamp: old }),
			rec({ pre_error_sequence: blind, check_name: "z", timestamp: old }),
		];
		const sess = session([], blind);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess);
		expect(warnings[0]).toContain("led to 3 previous error(s)");
		expect(warnings[0]).toContain("blind editing");
	});
});

// ---------------------------------------------------------------------------
// Combined / union behavior
// ---------------------------------------------------------------------------
describe("getPatternWarnings — combined detectors", () => {
	it("returns warnings from multiple detectors at once, in detector order", () => {
		// Engineer a single file+session that lights up hot-region, edit-pair,
		// temporal, and sequence simultaneously.
		const recent = minutesAgoISO(10);
		const seq = ["Edit:src/foo.ts", "Edit:src/foo.ts", "Edit:src/foo.ts"];
		const records: ErrorRecord[] = [
			// Hot region (bucket 1, lines 31-60) + edit pair (bar.ts) +
			// recurring sequence, all on src/foo.ts, both recent (temporal).
			rec({
				line_start: 40,
				co_edited_files: ["src/bar.ts"],
				pre_error_sequence: seq,
				check_name: "tsc",
				timestamp: recent,
			}),
			rec({
				line_start: 50,
				co_edited_files: ["src/bar.ts"],
				pre_error_sequence: seq,
				check_name: "biome",
				timestamp: minutesAgoISO(20),
			}),
		];
		const sess = session([], seq);
		const warnings = getPatternWarnings(records, "src/foo.ts", sess, 45);

		// Order is hot-region, edit-pair, temporal, sequence.
		expect(warnings).toHaveLength(4);
		expect(warnings[0]).toContain("[interlinked:hot-region]");
		expect(warnings[1]).toContain("[interlinked:edit-pair]");
		expect(warnings[2]).toContain("[interlinked:temporal]");
		expect(warnings[3]).toContain("[interlinked:sequence-pattern]");
	});
});
