import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyManifest, loadManifest } from "../harness/mutation/manifest.js";
import type { MeasureOutcome, SurvivorEntry } from "../harness/mutation/measure.js";
import type { MutationTestScopeResult } from "../harness/mutation/test-scope.js";
import { c, header, kvLine } from "../lib/formatter.js";
import {
	maybeRecordMeasurement,
	type MeasureRecordSummary,
	renderMeasureCommand,
	testScopeNote,
} from "./mutation-measure-support.js";

const FILE = "src/a.ts";
const CONTENT = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";

/** A Stryker-shaped report for CONTENT with one mutant at the `>` (mirrors
 *  measure.test.ts's own helper — kept local since that file isn't exported). */
function report(status: string): unknown {
	const line2 = CONTENT.split("\n")[1] ?? "";
	const col = line2.indexOf(">") + 1;
	return {
		files: {
			[FILE]: {
				source: CONTENT,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status,
						location: { start: { line: 2, column: col }, end: { line: 2, column: col + 1 } },
					},
				],
			},
		},
	};
}

function measuredOutcome(rawReport: unknown): MeasureOutcome {
	return { status: "measured", mutantCount: 1, survivorCount: 1, survivors: [], rawReport };
}

describe("testScopeNote", () => {
	it("reports the affected-test count when the graph resolved a scope", () => {
		const scope: MutationTestScopeResult = { tests: ["a.test.ts", "b.test.ts"] };
		expect(testScopeNote(scope)).toBe("test scope: 2 test(s) via the import graph\n");
	});

	it("reports the over-cap fallback with the true uncapped count", () => {
		const scope: MutationTestScopeResult = { tests: null, reason: "over_cap", uncappedCount: 500 };
		expect(testScopeNote(scope)).toBe(
			"test scope: graph selected 500 test(s), over cap — falling back to filename-glob scope\n",
		);
	});

	it("is silent for an unknown-file scope (no tests, no over_cap reason)", () => {
		const scope: MutationTestScopeResult = { tests: null, reason: "unknown_file" };
		expect(testScopeNote(scope)).toBe("");
	});

	it("is silent when tests is null and reason is absent entirely", () => {
		const scope: MutationTestScopeResult = { tests: null };
		expect(testScopeNote(scope)).toBe("");
	});
});

describe("renderMeasureCommand — outcome rendering", () => {
	it("renders a not_measurable outcome with its reason", () => {
		const outcome: MeasureOutcome = {
			status: "not_measurable",
			reason: "no_tests",
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.yellow("  NOT MEASURABLE: no_tests")].join("\n"),
		);
	});

	it("falls back to 'unknown reason' when not_measurable carries none", () => {
		const outcome: MeasureOutcome = { status: "not_measurable", mutantCount: 0, survivorCount: 0, survivors: [] };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.yellow("  NOT MEASURABLE: unknown reason")].join("\n"),
		);
	});

	it("renders a busy outcome distinctly from not_measurable, with its reason", () => {
		const outcome: MeasureOutcome = {
			status: "busy",
			reason: "runner_busy: all endpoints busy",
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				c.yellow("  RUNNER BUSY: runner_busy: all endpoints busy — not measured, retry later"),
			].join("\n"),
		);
	});

	it("falls back to 'all endpoints busy' when a busy outcome carries no reason", () => {
		const outcome: MeasureOutcome = { status: "busy", mutantCount: 0, survivorCount: 0, survivors: [] };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				c.yellow("  RUNNER BUSY: all endpoints busy — not measured, retry later"),
			].join("\n"),
		);
	});

	it("renders an error outcome with its reason", () => {
		const outcome: MeasureOutcome = {
			status: "error",
			reason: "connection refused",
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.red("  FAILED: connection refused")].join("\n"),
		);
	});

	it("falls back to 'unknown error' when an error outcome carries no reason", () => {
		const outcome: MeasureOutcome = { status: "error", mutantCount: 0, survivorCount: 0, survivors: [] };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.red("  FAILED: unknown error")].join("\n"),
		);
	});

	it("renders a measured outcome's mutant/survivor counts and each survivor line", () => {
		const survivors: SurvivorEntry[] = [{ line: 12, mutator: "EqualityOperator", replacement: ">=" }];
		const outcome: MeasureOutcome = { status: "measured", mutantCount: 3, survivorCount: 1, survivors };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "3"),
				kvLine("Survivors", "1"),
				`    L12  EqualityOperator -> ${JSON.stringify(">=").slice(0, 90)}`,
			].join("\n"),
		);
	});
});

describe("renderMeasureCommand — record-summary rendering", () => {
	const outcome: MeasureOutcome = { status: "measured", mutantCount: 0, survivorCount: 0, survivors: [] };

	it("renders nothing extra when record is null (no --record passed)", () => {
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), kvLine("Mutants", "0"), kvLine("Survivors", "0")].join("\n"),
		);
	});

	it("renders 'not recorded' with the reason when recording was attempted but declined", () => {
		const record: MeasureRecordSummary = { recorded: false, reason: "zero mutants for this file" };
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.yellow("  Not recorded: zero mutants for this file"),
			].join("\n"),
		);
	});

	it("falls back to 'unknown reason' when a declined record carries none", () => {
		const record: MeasureRecordSummary = { recorded: false };
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.yellow("  Not recorded: unknown reason"),
			].join("\n"),
		);
	});

	it("renders a real before/after delta when both are present", () => {
		const record: MeasureRecordSummary = {
			recorded: true,
			before: { mutants: 4, survivors: 2 },
			after: { mutants: 4, survivors: 1 },
		};
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.green("  ✓ Recorded: 2/4 → 1/4 survivors/mutants (survivors/mutants, before → after)"),
			].join("\n"),
		);
	});

	it("renders '?' for whichever side (before/after) is missing", () => {
		const record: MeasureRecordSummary = { recorded: true };
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.green("  ✓ Recorded: ? → ? survivors/mutants (survivors/mutants, before → after)"),
			].join("\n"),
		);
	});
});

describe("maybeRecordMeasurement", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-measure-support-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("no-ops (returns null) when --record was not passed", async () => {
		const result = await maybeRecordMeasurement({
			record: false,
			outcome: measuredOutcome(report("Survived")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toBeNull();
	});

	it("no-ops (returns null) when record is undefined", async () => {
		const result = await maybeRecordMeasurement({
			record: undefined,
			outcome: measuredOutcome(report("Survived")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toBeNull();
	});

	it("declines with a reason when the run was not measured, and folds in the outcome's own reason", () => {
		return maybeRecordMeasurement({
			record: true,
			outcome: { status: "error", reason: "connection refused", mutantCount: 0, survivorCount: 0, survivors: [] },
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		}).then((result) => {
			expect(result).toEqual({ recorded: false, reason: "run was error (connection refused) — nothing to record" });
		});
	});

	it("declines with a bare status when the non-measured outcome carries no reason", async () => {
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: { status: "busy", mutantCount: 0, survivorCount: 0, survivors: [] },
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toEqual({ recorded: false, reason: "run was busy — nothing to record" });
	});

	it("records a real measured-clean run into a fresh manifest on disk", async () => {
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Survived")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toEqual({
			recorded: true,
			before: { mutants: 0, survivors: 0 },
			after: { mutants: 1, survivors: 1 },
		});
		// The write actually landed — loadManifest sees the same file this
		// command's own configDir points at.
		expect(loadManifest(dir)?.files[FILE]).toBeDefined();
	});

	it("builds on an existing on-disk manifest rather than starting fresh", async () => {
		const { saveManifest, mutationManifestPath } = await import("../harness/mutation/manifest.js");
		void mutationManifestPath; // imported only for symmetry with manifest.test.ts's pattern
		saveManifest(dir, emptyManifest({
			engine: "stryker",
			engineVersion: "1",
			dependencyGraphVersion: "g",
			environmentHash: "e",
			authoritativeAt: "t0",
		}));
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Killed")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result?.recorded).toBe(true);
		expect(result?.after).toEqual({ mutants: 1, survivors: 0 });
	});

	it("declines without writing when the rawReport is not a recognizable report", async () => {
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome({ nonsense: true }),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result?.recorded).toBe(false);
		expect(result?.reason).toContain("not a recognizable mutation report");
		expect(loadManifest(dir)).toBeNull();
	});
});
