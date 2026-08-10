import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	measureOneFile,
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


// ===========================================
// measureOneFile — the whole single-file pipeline (resolve, scope, overlay,
// pre-flight, measure, record) as ONE reusable step. `mutation measure` and
// `mutation sweep` both drive it, so the RED-suite pre-flight policy and the
// record rules exist in exactly one place.
// ===========================================
describe("measureOneFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "measure-one-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), CONTENT);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const base = () => ({
		file: "src/a.ts",
		cwd: dir,
		configDir: join(dir, ".interlinked"),
		runnerUrl: "http://runner.invalid",
		skipPreflight: true,
		quiet: true,
	});

	it("P1: returns the measured outcome's counts", async () => {
		const result = await measureOneFile({
			...base(),
			measure: async () => measuredOutcome(report("Survived")),
		});
		expect(result.status).toBe("measured");
		expect(result.survivors).toBe(1);
		expect(result.mutants).toBe(1);
	});

	it("P2: records into the manifest when asked, and not otherwise", async () => {
		const measure = async () => measuredOutcome(report("Killed"));
		const norecord = await measureOneFile({ ...base(), measure });
		expect(norecord.record).toBeNull();
		const recorded = await measureOneFile({ ...base(), record: true, measure });
		expect(recorded.record?.recorded).toBe(true);
		expect(loadManifest(join(dir, ".interlinked"))).not.toBeNull();
	});

	it("P3: runs the RED-suite pre-flight unless skipped, and refuses on red", async () => {
		let ran = 0;
		const result = await measureOneFile({
			...base(),
			skipPreflight: false,
			preflight: async () => {
				ran += 1;
				return "the scoped suite is RED";
			},
			measure: async () => {
				throw new Error("must not measure against a red suite");
			},
		});
		expect(ran).toBe(1);
		expect(result.status).toBe("red_suite");
		expect(result.reason).toContain("RED");
	});

	it("P4: passes the busy status through instead of flattening it to an error", async () => {
		const result = await measureOneFile({
			...base(),
			measure: async () => ({ status: "busy" as const, reason: "503", mutantCount: 0, survivorCount: 0, survivors: [] }),
		});
		expect(result.status).toBe("busy");
	});

	it("N1: an unreadable path never reaches the runner", async () => {
		let called = false;
		const result = await measureOneFile({
			...base(),
			file: "src/missing.ts",
			measure: async () => {
				called = true;
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("unreadable");
		expect(called).toBe(false);
	});

	it("N2: no configured runner is its own status, not a failed run", async () => {
		const result = await measureOneFile({
			...base(),
			runnerUrl: undefined,
			measure: async () => measuredOutcome(report("Killed")),
		});
		expect(result.status).toBe("no_runner");
	});

	it("N3: skipPreflight really skips it", async () => {
		let ran = 0;
		await measureOneFile({
			...base(),
			preflight: async () => {
				ran += 1;
				return null;
			},
			measure: async () => measuredOutcome(report("Killed")),
		});
		expect(ran).toBe(0);
	});

	it("P5: runnerUrls (plural, ordered) wins over a single runnerUrl when both are given", async () => {
		let seenEndpoints: string[] = [];
		await measureOneFile({
			...base(),
			runnerUrl: "http://single.invalid",
			runnerUrls: ["http://first.invalid", "http://second.invalid"],
			measure: async (a) => {
				seenEndpoints = a.endpoints;
				return measuredOutcome(report("Killed"));
			},
		});
		expect(seenEndpoints).toEqual(["http://first.invalid", "http://second.invalid"]);
	});

	it("P6: with no explicit runner, falls back to the repo's configured per_edit_mutation endpoint + token", async () => {
		writeFileSync(
			join(dir, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ per_edit_mutation: { runner_url: "http://configured.invalid", token: "shh" } }),
		);
		let seen: { endpoints: string[]; token: string | undefined } = { endpoints: [], token: undefined };
		const result = await measureOneFile({
			file: "src/a.ts",
			cwd: dir,
			configDir: join(dir, ".interlinked"),
			skipPreflight: true,
			quiet: true,
			measure: async (a) => {
				seen = { endpoints: a.endpoints, token: a.token };
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("measured");
		expect(seen.endpoints).toEqual(["http://configured.invalid"]);
		expect(seen.token).toBe("shh");
	});
});
