// ===========================================================================
// Mutation-kill companion for src/commands/check-output.ts.
//
// Targets the 50 surviving mutants recorded against this file in
// .interlinked/mutation-manifest.json (generation authoritative at
// 2026-08-11T07:27:59.861Z). Every exported function is driven directly;
// the four unexported helpers (structuralRowMarks, emitStructuralSummary,
// emitEngineToolRow, emitEngineSummary) are only reachable through the
// exported `emitFullSummary`, so their survivors are killed by hand-traced
// exact-stderr assertions on calls into that entry point instead.
//
// stdout/stderr are captured by replacing `process.stdout.write` /
// `process.stderr.write` with an accumulating spy (mirrors the proven
// pattern in src/commands/check.test.ts's `captureIO`). Every assertion
// compares the FULL captured text (or FULL parsed JSON object) against a
// hand-computed expected value — a change to any single literal, operator,
// or branch anywhere in the traced call path fails the comparison.
// ===========================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../harness/check-engine/index.js";
import {
	emitEngineOnly,
	emitFullSummary,
	emitJsonOutput,
	emitStructuralOnly,
	type StructuralCheckResult,
} from "./check-output.js";

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function captureIO(): { stdout: () => string; stderr: () => string } {
	let stdout = "";
	let stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	});
	return { stdout: () => stdout, stderr: () => stderr };
}

function emptyReport(): CheckReport {
	return {
		results: [],
		toolsRun: [],
		toolsSkipped: [],
		skipped: [],
		elapsedMs: 0,
		metrics: [],
		deduplicatedCount: 0,
	};
}

function report(partial: Partial<CheckReport>): CheckReport {
	return { ...emptyReport(), ...partial };
}

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// -------------------------------------------------------------------
// emitJsonOutput
// -------------------------------------------------------------------

describe("emitJsonOutput (mutation-kill)", () => {
	// test-contract: invariant — each tool's JSON entry must only contain that
	// tool's own findings. Replacing the `.filter((r) => r.tool === tool.id)`
	// call with the raw unfiltered array (MethodExpression), or forcing the
	// predicate itself to `true` (ConditionalExpression), both leak the other
	// tool's finding into this tool's `count`/`findings`, which the exact
	// per-tool object below catches.
	// test-contract: invariant — filtering engine results by tool.id must not leak another tool's findings into this tool's JSON entry.
	it("scopes each engine tool's findings to its own tool.id, never the whole results array", () => {
		const results: StructuralCheckResult[] = [{ name: "cycles", files: new Set(["a.ts"]) }];
		const engineReport = report({
			toolsRun: [
				{ id: "tsc", available: true, version: "5.0.0" },
				{ id: "biome", available: true, version: "1.0.0" },
			],
			results: [
				{ tool: "tsc", severity: "error", file: "x.ts", line: 10, message: "boom", ruleId: "TS1" },
				{
					tool: "biome",
					severity: "warning",
					file: "y.ts",
					line: 20,
					message: "warn",
					ruleId: "lint/x",
				},
			],
		});

		const io = captureIO();
		emitJsonOutput(results, engineReport);

		expect(JSON.parse(io.stdout())).toEqual({
			cycles: { count: 1, files: ["a.ts"] },
			tsc: {
				count: 1,
				findings: [{ file: "x.ts", line: 10, severity: "error", message: "boom", ruleId: "TS1" }],
			},
			biome: {
				count: 1,
				findings: [
					{ file: "y.ts", line: 20, severity: "warning", message: "warn", ruleId: "lint/x" },
				],
			},
		});
	});
});

// -------------------------------------------------------------------
// emitStructuralOnly
// -------------------------------------------------------------------

describe("emitStructuralOnly (mutation-kill)", () => {
	// test-contract: boundary — when no check matches `onlyCheck`, `result` is
	// `undefined` and the original short-circuits safely to the else branch.
	// Forcing the whole guard to `true` (ConditionalExpression) or swapping
	// `&&` for `||` (LogicalOperator) both then evaluate `result.files.size`
	// on `undefined` and throw, so a call that must complete cleanly is itself
	// the assertion.
	// test-contract: boundary — result is undefined when no check matches onlyCheck; the call must reach the else branch without throwing.
	it("takes the else branch with no stdout when no check matches onlyCheck", () => {
		const io = captureIO();
		emitStructuralOnly([{ name: "cycles", files: new Set(["a.ts"]) }], "missing-check");
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe("0 files\n");
	});

	// test-contract: boundary — a matched check with a EMPTY file set must also
	// take the else branch (`size > 0` is false). Forcing `size > 0` to `true`
	// (ConditionalExpression) or to `size >= 0` (EqualityOperator, always true
	// for a non-negative size) both flip into the if-branch, which shows up as
	// a leading "\n" before "0 files" instead of the bare else-branch line.
	// test-contract: boundary — a matched check with zero files must take the else branch, not the leading-newline if-branch text.
	it("takes the else branch with no leading newline when the matched check has zero files", () => {
		const io = captureIO();
		emitStructuralOnly([{ name: "cycles", files: new Set() }], "cycles");
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe("0 files\n");
	});

	// test-contract: invariant — with a decoy first entry whose name does NOT
	// match `onlyCheck`, forcing the `.find()` predicate to `true`
	// (ConditionalExpression) returns the decoy instead of the real match; and
	// inserting the matched check's files out of alphabetical order exposes a
	// removed `.sort()` (MethodExpression) as an unsorted stdout listing.
	// test-contract: invariant — .find() must return the exact name match, and its files must print in sorted, not insertion, order.
	it("finds the exact-name match and sorts its files regardless of insertion order", () => {
		const results: StructuralCheckResult[] = [
			{ name: "orphans", files: new Set(["decoy.ts"]) },
			{ name: "cycles", files: new Set(["z.ts", "a.ts", "m.ts"]) },
		];
		const io = captureIO();
		emitStructuralOnly(results, "cycles");
		expect(io.stdout()).toBe("a.ts\nm.ts\nz.ts\n");
		expect(io.stderr()).toBe("\n3 files\n");
	});
});

// -------------------------------------------------------------------
// emitEngineOnly
// -------------------------------------------------------------------

describe("emitEngineOnly (mutation-kill)", () => {
	// test-contract: boundary — with zero results for `onlyCheck`, forcing
	// `toolResults.length > 0` to `true` (ConditionalExpression) or to
	// `>= 0` (EqualityOperator, always true for a non-negative length) both
	// flip into the if-branch over an empty array, observable as a leading
	// "\n" before "0 findings" instead of the bare else-branch line.
	// test-contract: boundary — zero matching findings for onlyCheck must take the else branch, not the leading-newline if-branch text.
	it("takes the else branch with no leading newline when no findings match onlyCheck", () => {
		const engineReport = report({
			toolsRun: [{ id: "tsc", available: true, version: "5.0.0" }],
			results: [{ tool: "tsc", severity: "error", file: "x.ts", line: 1, message: "m" }],
		});
		const io = captureIO();
		emitEngineOnly(engineReport, "eslint");
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe("0 findings\n");
	});
});

// -------------------------------------------------------------------
// emitFullSummary — also the only reachable path to the unexported
// structuralRowMarks / emitStructuralSummary / emitEngineToolRow /
// emitEngineSummary helpers, and to the module-level SEVERITY_CHECK_ERRORS
// Set literal.
// -------------------------------------------------------------------

describe("emitFullSummary (mutation-kill)", () => {
	// test-contract: boundary — with an empty structural-results array,
	// emitStructuralSummary must return early WITHOUT writing the "Structural
	// checks:" header. Forcing `results.length === 0` to `false`
	// (ConditionalExpression) skips the early return and writes the header
	// anyway even though there is nothing to report, which the exact full
	// stderr transcript below catches; exitCode must stay unset.
	// test-contract: boundary — an empty structural-results array must skip the "Structural checks:" header entirely and leave exitCode at 0.
	it("omits the structural-checks header and stays exitCode 0 for empty results and a null engine report", () => {
		process.exitCode = 0;
		const io = captureIO();
		emitFullSummary([], null, 0);
		expect(io.stderr()).toBe(
			"\n  Interlinked project check (0 files indexed)\n\n" + "\n  total unique: 0 / 0 files\n\n",
		);
		expect(process.exitCode).toBe(0);
	});

	// test-contract: invariant — five structural rows drive every
	// structuralRowMarks() branch (zero-size vs. non-zero-size, error vs.
	// non-error) and every SEVERITY_CHECK_ERRORS membership survivor
	// ("cycles" / "dead-imports" / "secrets" — replacing any one of those
	// StringLiteral set members with "" drops that check out of the error
	// classification for its own row only). Each row's exact icon/count/
	// severity text pins the ANSI-literal and size/isError boundary mutants;
	// the trailing exitCode 1 pins the `isError && files.size > 0` ->
	// hasErrors accumulation mutants (both the whole-condition
	// ConditionalExpression->false and the BooleanLiteral true->false on the
	// assignment itself).
	// test-contract: invariant — every structuralRowMarks icon/count/severity combination and SEVERITY_CHECK_ERRORS member must render exactly, setting exitCode 1.
	it("renders every structural row's exact icon/count/severity and exits 1 when an error check is flagged", () => {
		process.exitCode = 0;
		const results: StructuralCheckResult[] = [
			{ name: "cycles", files: new Set(["c1.ts"]) },
			{ name: "dead-imports", files: new Set(["d1.ts", "d2.ts"]) },
			{ name: "secrets", files: new Set(["s1.ts"]) },
			{ name: "orphan-exports", files: new Set(["x1.ts", "x2.ts", "x3.ts"]) },
			{ name: "clean-check", files: new Set() },
		];
		const io = captureIO();
		emitFullSummary(results, null, 10);
		expect(io.stderr()).toBe(
			"\n  Interlinked project check (10 files indexed)\n\n" +
				"  Structural checks:\n\n" +
				"  \x1b[31m✗\x1b[0m cycles [error]: \x1b[31m1\x1b[0m files\n" +
				"  \x1b[31m✗\x1b[0m dead-imports [error]: \x1b[31m2\x1b[0m files\n" +
				"  \x1b[31m✗\x1b[0m secrets [error]: \x1b[31m1\x1b[0m files\n" +
				"  \x1b[33m!\x1b[0m orphan-exports [info]: \x1b[33m3\x1b[0m files\n" +
				"  \x1b[32m✓\x1b[0m clean-check [info]: \x1b[32m0\x1b[0m files\n" +
				"\n  total unique: 7 / 10 files\n\n",
		);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: invariant — two engine tools with genuinely different
	// tool.id/severity populations (tsc: 1 error; biome: 2 warnings; eslint: 0
	// findings) pin the tool-filter and severity-filter EqualityOperator
	// mutants in the inner `(r) => r.tool === tool.id` / `(r) => r.severity
	// === "error"` predicates — cross-tool contamination shows up as wrong
	// counts/icons on a specific row — and pin the `errorCount > 0`
	// ConditionalExpression/EqualityOperator mutants at both the icon and
	// count-string positions (tsc's row must read RED/errors, biome's row
	// must read YELLOW/warnings). The trailing exitCode 1 additionally pins
	// the `false`-forcing direction of the boolean-return and
	// hasErrors-accumulation mutants (tsc's genuine error must survive
	// propagation through emitEngineToolRow -> emitEngineSummary ->
	// emitFullSummary).
	// test-contract: invariant — each engine tool row must reflect only its own tool.id/severity-filtered findings, and a genuine error must set exitCode 1.
	it("renders each engine tool row from its own filtered results and exits 1 when any tool has errors", () => {
		process.exitCode = 0;
		const engineReport = report({
			toolsRun: [
				{ id: "tsc", available: true, version: "5.4.0" },
				{ id: "biome", available: true, version: "1.8.0" },
				{ id: "eslint", available: true, version: "9.0.0" },
			],
			results: [
				{ tool: "tsc", severity: "error", file: "a.ts", line: 3, message: "type error" },
				{ tool: "biome", severity: "warning", file: "b.ts", line: 7, message: "warn one" },
				{ tool: "biome", severity: "warning", file: "c.ts", line: 9, message: "warn two" },
			],
			elapsedMs: 2500,
		});
		const io = captureIO();
		emitFullSummary([], engineReport, 42);
		expect(io.stderr()).toBe(
			"\n  Interlinked project check (42 files indexed)\n\n" +
				"\n  External tool checks:\n\n" +
				"  \x1b[31m✗\x1b[0m tsc [5.4.0]: \x1b[31m1\x1b[0m findings (1 errors, 0 warnings)\n" +
				"  \x1b[33m!\x1b[0m biome [1.8.0]: \x1b[33m2\x1b[0m findings (0 errors, 2 warnings)\n" +
				"  \x1b[32m✓\x1b[0m eslint [9.0.0]: \x1b[32m0\x1b[0m findings\n" +
				"\x1b[2m  completed in 2.5s\x1b[0m\n" +
				"\n  total unique: 3 / 42 files\n\n",
		);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — a single tool with findings but ZERO errors
	// isolates the `return errorCount > 0` occurrence from OR-masking by any
	// other tool in the same run: with only one contributor, forcing that
	// return (or its `>= 0`/`<= 0` EqualityOperator siblings) toward "true"
	// flips exitCode from the expected 0 to 1. A multi-tool test cannot catch
	// this direction once a genuinely-erroring tool already contributes
	// `true` to the same accumulator.
	// test-contract: boundary — a lone all-warning tool isolates the boolean return from OR-masking by other tools; exitCode must stay 0.
	it("stays exitCode 0 for a single all-warning tool, isolating the boolean return from OR-masking", () => {
		process.exitCode = 0;
		const engineReport = report({
			toolsRun: [{ id: "ruff", available: true, version: "0.5.0" }],
			results: [{ tool: "ruff", severity: "warning", file: "m.py", line: 4, message: "style" }],
			elapsedMs: 400,
		});
		const io = captureIO();
		emitFullSummary([], engineReport, 5);
		expect(io.stderr()).toBe(
			"\n  Interlinked project check (5 files indexed)\n\n" +
				"\n  External tool checks:\n\n" +
				"  \x1b[33m!\x1b[0m ruff [0.5.0]: \x1b[33m1\x1b[0m findings (0 errors, 1 warnings)\n" +
				"\x1b[2m  completed in 0.4s\x1b[0m\n" +
				"\n  total unique: 1 / 5 files\n\n",
		);
		expect(process.exitCode).toBe(0);
	});
});
