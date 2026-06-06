// Tests for the Stop-event deterministic pattern rescan.
//
// These are BEHAVIORAL tests against the public surface of `stop-rescan.ts`
// (`rescanSessionFiles` + `buildPatternRescanWarnings`). The three module
// boundaries the rescan depends on — `node:fs` (file read), the check
// registry (`buildAgentSafetyChecks`), and `suppressions`
// (`scanInlineDeferrals`) — are mocked so every branch (including the
// best-effort error swallows that real detectors never hit) is reachable
// deterministically.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentSafetyChecks } from "./check-registry/index.js";
import type { InlineMatch } from "./check-registry/types.js";
import {
	buildPatternRescanWarnings,
	type PatternRescanFinding,
	rescanSessionFiles,
} from "./stop-rescan.js";
import { scanInlineDeferrals } from "./suppressions.js";
import type { SessionTrajectory } from "./types.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("./check-registry/index.js", () => ({ buildAgentSafetyChecks: vi.fn() }));
vi.mock("./suppressions.js", () => ({ scanInlineDeferrals: vi.fn() }));

const mockReadFileSync = vi.mocked(readFileSync);
const mockBuildChecks = vi.mocked(buildAgentSafetyChecks);
const mockScanDeferrals = vi.mocked(scanInlineDeferrals);

/** Static ISO timestamp — the rescan code never reads `started_at`, so a
 *  fixed value keeps date generation out of determinism entirely. */
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeSession(filesWritten: string[]): SessionTrajectory {
	// SessionTrajectory has many required fields; build a minimal shape with
	// just `files_written`, the only field the rescan reads.
	return {
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "tester",
		started_at: FIXED_TIMESTAMP,
		tdd_cycles: [],
		assertion_counts: new Map<string, number>(),
		files_written: new Set(filesWritten),
		commands_run: [],
		active_skills: new Map<string, unknown>(),
		verification_observed: new Set<string>(),
		stubs_introduced: [],
		fired_reminders: new Set<string>(),
		non_doc_files_edited_since_commit: new Set<string>(),
		doc_files_edited_since_commit: 0,
		stop_nudge_emitted: false,
	} as unknown as SessionTrajectory;
}

/** A single mocked detector returning a fixed match list. */
function detector(
	name: string,
	matches: InlineMatch[],
): { name: string; severity: "error" | "warning"; fn: () => InlineMatch[] } {
	return { name, severity: "warning", fn: () => matches };
}

/** A detector whose `fn()` throws — exercises the per-check try/catch. */
function throwingDetector(name: string): {
	name: string;
	severity: "error" | "warning";
	fn: () => InlineMatch[];
} {
	return {
		name,
		severity: "warning",
		fn: () => {
			throw new Error(`detector ${name} exploded`);
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default happy path: file reads succeed, no deferrals, no detectors.
	// Individual tests override per-case.
	mockReadFileSync.mockReturnValue("file body\n");
	mockScanDeferrals.mockReturnValue(new Map());
	mockBuildChecks.mockReturnValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("rescanSessionFiles", () => {
	it("returns an empty array when no files were written", () => {
		const out = rescanSessionFiles(makeSession([]), "/repo");
		expect(out).toEqual([]);
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});

	it("reads each written file relative to the resolved cwd and runs detectors", () => {
		mockBuildChecks.mockReturnValue([
			detector("ubs_pickle_untrusted_load", [{ line: 2, text: "pickle.load(f)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["src/a.py"]), "/repo");
		expect(mockReadFileSync).toHaveBeenCalledWith("/repo/src/a.py", "utf-8");
		expect(findings).toEqual<PatternRescanFinding[]>([
			{
				file: "src/a.py",
				checkId: "ubs_pickle_untrusted_load",
				line: 2,
				text: "pickle.load(f)",
				deferred: false,
				deferReason: null,
			},
		]);
	});

	it("keeps an already-absolute path as-is rather than re-resolving it", () => {
		mockBuildChecks.mockReturnValue([detector("c", [{ line: 1, text: "x" }])]);
		const findings = rescanSessionFiles(makeSession(["/abs/elsewhere/file.ts"]), "/repo");
		expect(mockReadFileSync).toHaveBeenCalledWith("/abs/elsewhere/file.ts", "utf-8");
		// `relative("/repo", "/abs/elsewhere/file.ts")` is a non-empty `../`
		// path, so it is used verbatim as the reported `file`.
		expect(findings[0]?.file).toBe("../abs/elsewhere/file.ts");
	});

	it("de-duplicates when the same file appears as both absolute and relative", () => {
		mockBuildChecks.mockReturnValue([detector("c", [{ line: 1, text: "x" }])]);
		const findings = rescanSessionFiles(
			makeSession(["/repo/dup.py", "dup.py"]),
			"/repo",
		);
		expect(mockReadFileSync).toHaveBeenCalledTimes(1);
		expect(findings).toHaveLength(1);
	});

	it("falls back to the absolute path when relative() returns empty (file IS cwd)", () => {
		mockBuildChecks.mockReturnValue([detector("c", [{ line: 1, text: "x" }])]);
		// `relative("/repo", "/repo")` === "" → the `|| absPath` fallback fires.
		const findings = rescanSessionFiles(makeSession(["/repo"]), "/repo");
		expect(findings[0]?.file).toBe("/repo");
	});

	it("silently skips a file whose read throws (deleted / permission denied)", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const findings = rescanSessionFiles(makeSession(["gone.py"]), "/repo");
		expect(findings).toEqual([]);
		// A read failure must not call the detector builder for that file.
		expect(mockBuildChecks).not.toHaveBeenCalled();
	});

	it("continues past a detector whose fn() throws, still collecting other findings", () => {
		mockBuildChecks.mockReturnValue([
			throwingDetector("boom"),
			detector("survivor", [{ line: 5, text: "still here" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings.map((f) => f.checkId)).toEqual(["survivor"]);
		expect(findings[0]?.line).toBe(5);
	});

	it("annotates a match as deferred with a reason when the line has a marker", () => {
		mockScanDeferrals.mockReturnValue(
			new Map([[2, new Map([["eval_usage", "sandboxed by callers"]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 2, text: "eval(code)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings[0]).toMatchObject({
			checkId: "eval_usage",
			deferred: true,
			deferReason: "sandboxed by callers",
		});
	});

	it("marks deferred true with a null reason when the marker carries no justification", () => {
		mockScanDeferrals.mockReturnValue(
			new Map<number, Map<string, string | null>>([[3, new Map([["eval_usage", null]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 3, text: "eval(code)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings[0]?.deferred).toBe(true);
		expect(findings[0]?.deferReason).toBeNull();
	});

	it("leaves deferred=false when the line has deferrals but not for THIS check", () => {
		// Line 2 defers a *different* check id — this check is still live.
		mockScanDeferrals.mockReturnValue(
			new Map([[2, new Map([["some_other_check", "reason"]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 2, text: "eval(code)" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings[0]?.deferred).toBe(false);
		expect(findings[0]?.deferReason).toBeNull();
	});

	it("emits one finding per match across multiple matches and checks", () => {
		mockBuildChecks.mockReturnValue([
			detector("c1", [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			]),
			detector("c2", [{ line: 3, text: "c" }]),
		]);
		const findings = rescanSessionFiles(makeSession(["x.ts"]), "/repo");
		expect(findings).toHaveLength(3);
		expect(findings.map((f) => `${f.checkId}:${f.line}`)).toEqual([
			"c1:1",
			"c1:2",
			"c2:3",
		]);
	});
});

describe("buildPatternRescanWarnings", () => {
	it("returns an empty array when the rescan produces no findings", () => {
		mockBuildChecks.mockReturnValue([]);
		expect(buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo")).toEqual([]);
	});

	it("emits a single unaddressed-warning block listing each finding", () => {
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [
				{ line: 4, text: "eval(a)" },
				{ line: 9, text: "eval(b)" },
			]),
		]);
		const warnings = buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo");
		expect(warnings).toHaveLength(1);
		const w = warnings[0] ?? "";
		expect(w).toContain("[interlinked:stop-rescan] x.ts has 2 unaddressed finding(s)");
		expect(w).toContain("  eval_usage:4 — eval(a)");
		expect(w).toContain("  eval_usage:9 — eval(b)");
		expect(w).toContain("// interlinked: defer <check-id>");
	});

	it("emits only a deferred block (no unaddressed block) when all findings are acknowledged", () => {
		mockScanDeferrals.mockReturnValue(
			new Map([[4, new Map([["eval_usage", "intentional"]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 4, text: "eval(a)" }]),
		]);
		const warnings = buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo");
		expect(warnings).toHaveLength(1);
		const w = warnings[0] ?? "";
		expect(w).toContain("1 acknowledged-deferred finding(s) (logged, not escalated)");
		expect(w).toContain("  eval_usage:4 — intentional");
		expect(w).not.toContain("unaddressed");
	});

	it("omits the reason suffix on a deferred line when no justification was supplied", () => {
		mockScanDeferrals.mockReturnValue(
			new Map<number, Map<string, string | null>>([[4, new Map([["eval_usage", null]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [{ line: 4, text: "eval(a)" }]),
		]);
		const warnings = buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo");
		const w = warnings[0] ?? "";
		expect(w).toContain("acknowledged-deferred");
		// The deferred line ends right after the `checkId:line` token — no
		// " — <reason>" suffix is appended when deferReason is null.
		expect(w).toMatch(/ {2}eval_usage:4$/);
		expect(w).not.toMatch(/eval_usage:4 —/);
	});

	it("emits BOTH an unaddressed and a deferred block for one file with mixed findings", () => {
		mockScanDeferrals.mockReturnValue(
			new Map([[7, new Map([["eval_usage", "ack"]])]]),
		);
		mockBuildChecks.mockReturnValue([
			detector("eval_usage", [
				{ line: 4, text: "eval(live)" }, // unaddressed
				{ line: 7, text: "eval(deferred)" }, // deferred
			]),
		]);
		const warnings = buildPatternRescanWarnings(makeSession(["x.ts"]), "/repo");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("1 unaddressed finding(s)");
		expect(warnings[0]).toContain("  eval_usage:4 — eval(live)");
		expect(warnings[1]).toContain("1 acknowledged-deferred finding(s)");
		expect(warnings[1]).toContain("  eval_usage:7 — ack");
	});

	it("groups findings per file (existing-list branch) and emits a block per file", () => {
		// Two distinct files, each returning one finding. Exercises both the
		// new-list and existing-list branches of the byFile grouping.
		mockBuildChecks.mockReturnValue([
			detector("c", [
				{ line: 1, text: "m1" },
				{ line: 2, text: "m2" },
			]),
		]);
		const warnings = buildPatternRescanWarnings(
			makeSession(["a.ts", "b.ts"]),
			"/repo",
		);
		// One unaddressed block per file (two findings each).
		expect(warnings).toHaveLength(2);
		expect(warnings.some((w) => w.includes("a.ts has 2 unaddressed"))).toBe(true);
		expect(warnings.some((w) => w.includes("b.ts has 2 unaddressed"))).toBe(true);
	});
});
