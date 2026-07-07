import { describe, expect, it } from "vitest";
import {
	type CoverageDebtInput,
	decideCoverageDebt,
	expectedCompanionTest,
	expectedSourceOfTest,
	inSamePair,
	isRedBarBlock,
	isUncoveredBlock,
	pairStem,
} from "./coverage-debt.js";
import type { PerFileCoverage } from "./coverage-final-reader.js";
import { blockForRedBar, decideFromCoverage } from "./evaluator/coverage-write-decision.js";
import {
	blockForCrossSuiteRedBar,
	blockForDeletionRedBar,
} from "./evaluator/coverage-write-guard-redbar.js";
import { type Obligation, obligationId } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

// ----- fixtures ----------------------------------------------------------

function debt(file: string): Obligation {
	return { id: obligationId("coverage", file), kind: "coverage", file, contentHash: "", status: "open", sessionId: "s", openedAtMs: 1 };
}

/** A first-edit "this added line is uncovered" block — the thing we downgrade. */
function uncovered(file: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:coverage] BLOCKED: ${file} line 5 is executable but uncovered by the test suite after this edit.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** A red-bar block — the SECOND verdict debt-mode downgrades (red_suite debt). */
function redBar(): HarnessDecision {
	return { decision: "block", reason: "[interlinked:coverage] BLOCKED: your edit leaves the test suite RED.", rule_id: "per-edit-coverage", severity: "medium", category: "coverage" };
}

function redDebt(file: string): Obligation {
	return { id: obligationId("red_suite", file), kind: "red_suite", file, contentHash: "", status: "open", sessionId: "s", openedAtMs: 1 };
}

/** A non-red, non-uncovered PASS-THROUGH block (the CRAP / drop / floor class):
 *  debt mode forwards it untouched, so the edit is refused and never lands. */
function crapBlock(file: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:coverage] BLOCKED: this edit leaves \`fn\` in ${file} with CRAP 42 (threshold 30). Reduce complexity or add coverage.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

function run(over: Partial<CoverageDebtInput>): ReturnType<typeof decideCoverageDebt> {
	return decideCoverageDebt({ baseDecision: null, editedFile: "src/foo.ts", openDebts: [], rechecks: new Map(), sessionId: "s", atMs: 1, ...over });
}

// ----- pairStem / companion ----------------------------------------------

describe("pairStem", () => {
	it("maps a source and its co-located test to the same stem", () => {
		expect(pairStem("src/foo.ts")).toBe("src/foo");
		expect(pairStem("src/foo.test.ts")).toBe("src/foo");
		expect(pairStem("src/foo.spec.tsx")).toBe("src/foo");
	});

	it("keeps unrelated files distinct", () => {
		expect(pairStem("src/bar.ts")).not.toBe(pairStem("src/foo.ts"));
	});
});

describe("inSamePair", () => {
	it("pairs a source with its co-located test (exact stem)", () => {
		expect(inSamePair("src/foo.ts", "src/foo.test.ts")).toBe(true);
		expect(inSamePair("src/a/b/foo.ts", "src/a/b/foo.spec.tsx")).toBe(true);
	});

	it("pairs a decomposed source with its same-dir umbrella test (order-independent)", () => {
		expect(inSamePair("src/foo.test.ts", "src/foo-bar.ts")).toBe(true);
		expect(inSamePair("src/foo-bar.ts", "src/foo.test.ts")).toBe(true);
	});

	it("pairs a decomposed source with an umbrella test under __tests__/ (the reported case)", () => {
		expect(
			inSamePair(
				"src/harness/evaluator/__tests__/write-content-guards.test.ts",
				"src/harness/evaluator/write-content-guards-content-quality.ts",
			),
		).toBe(true);
	});

	it("does NOT pair across different directories", () => {
		expect(inSamePair("src/a/__tests__/foo.test.ts", "src/b/foo-bar.ts")).toBe(false);
	});

	it("does NOT pair unrelated files", () => {
		expect(inSamePair("src/bar.ts", "src/foo.ts")).toBe(false);
	});

	it("requires a hyphen boundary — foo.test.ts does not cover foobar.ts", () => {
		expect(inSamePair("src/foo.test.ts", "src/foobar.ts")).toBe(false);
	});

	it("does NOT pair two sources via the umbrella rule (needs exactly one test side)", () => {
		expect(inSamePair("src/foo-a.ts", "src/foo-b.ts")).toBe(false);
	});
});

describe("expectedCompanionTest", () => {
	it("names the conventional co-located test", () => {
		expect(expectedCompanionTest("src/foo.ts")).toBe("src/foo.test.ts");
		expect(expectedCompanionTest("src/util/clamp.mjs")).toBe("src/util/clamp.test.mjs");
	});
});

describe("expectedSourceOfTest", () => {
	it("strips the test/spec infix to name the pair's source side", () => {
		expect(expectedSourceOfTest("src/foo.test.ts")).toBe("src/foo.ts");
		expect(expectedSourceOfTest("src/a/b.spec.tsx")).toBe("src/a/b.tsx");
	});
});

// ----- isUncoveredBlock ---------------------------------------------------

describe("isUncoveredBlock", () => {
	it("is true only for an uncovered-line block", () => {
		expect(isUncoveredBlock(uncovered("src/foo.ts"))).toBe(true);
	});
	it("is false for null, non-blocks, and other blocks", () => {
		expect(isUncoveredBlock(null)).toBe(false);
		expect(isUncoveredBlock({ decision: "allow" })).toBe(false);
		expect(isUncoveredBlock(redBar())).toBe(false);
		expect(isUncoveredBlock({ decision: "block" })).toBe(false); // no reason
	});
});

// ----- decideCoverageDebt: the pair rule ---------------------------------

describe("decideCoverageDebt — opening debt (first edit is never blocked)", () => {
	it("downgrades a first uncovered-source block to an opened debt + allow", () => {
		const out = run({ editedFile: "src/foo.ts", baseDecision: uncovered("src/foo.ts") });
		expect(out.decision?.decision).toBe("allow");
		expect(out.txns).toHaveLength(1);
		expect(out.txns[0]).toMatchObject({ op: "open", kind: "coverage", file: "src/foo.ts" });
	});

	it("lets the agent keep editing the SAME source while debt is open", () => {
		const out = run({ editedFile: "src/foo.ts", baseDecision: uncovered("src/foo.ts"), openDebts: [debt("src/foo.ts")] });
		expect(out.decision?.decision).toBe("allow"); // same pair — not a wander
	});
});

describe("decideCoverageDebt — staying in the pair discharges", () => {
	it("discharges when the companion test now covers the source", () => {
		const out = run({ editedFile: "src/foo.test.ts", baseDecision: null, openDebts: [debt("src/foo.ts")], rechecks: new Map([["src/foo.ts", true]]) });
		expect(out.decision).toBeNull(); // allowed, no warning needed
		expect(out.txns).toHaveLength(1);
		expect(out.txns[0]).toMatchObject({ op: "discharge", id: obligationId("coverage", "src/foo.ts") });
	});

	it("discharges when the source is re-edited and now reads as covered", () => {
		const out = run({ editedFile: "src/foo.ts", baseDecision: null, openDebts: [debt("src/foo.ts")] });
		expect(out.decision).toBeNull();
		expect(out.txns[0]).toMatchObject({ op: "discharge" });
	});

	it("a companion test that still covers nothing keeps the debt open (no discharge)", () => {
		const out = run({ editedFile: "src/foo.test.ts", baseDecision: null, openDebts: [debt("src/foo.ts")], rechecks: new Map() });
		expect(out.txns).toHaveLength(0); // introverted test — not rechecked-covered
		expect(out.decision).toBeNull(); // still in-pair, so allowed to keep trying
	});

	it("discharges a coverage debt AND a same-file red debt in ONE companion-test call (id-keyed)", () => {
		// Regression: the discharged set was keyed by FILE, so recheck-discharging
		// the coverage debt also filtered the same file's red debt out of
		// `stillOpen`, and foldRedBar could not discharge it in the same call.
		const out = run({
			editedFile: "src/foo.test.ts",
			baseDecision: null,
			openDebts: [debt("src/foo.ts"), redDebt("src/foo.ts")],
			rechecks: new Map([["src/foo.ts", true]]),
		});
		expect(out.decision).toBeNull();
		expect(out.txns).toEqual([
			{ op: "discharge", id: obligationId("coverage", "src/foo.ts"), source: "local", atMs: 1 },
			{ op: "discharge", id: obligationId("red_suite", "src/foo.ts"), source: "local", atMs: 1 },
		]);
	});
});

describe("decideCoverageDebt — wandering out of the pair blocks", () => {
	it("blocks an edit to an unrelated file while debt is open", () => {
		const out = run({ editedFile: "src/bar.ts", baseDecision: null, openDebts: [debt("src/foo.ts")], rechecks: new Map() });
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.reason).toContain("src/foo.ts");
		expect(out.decision?.reason).toContain("src/foo.test.ts"); // points at the companion to write
		expect(out.txns).toHaveLength(0);
	});

	it("does NOT block if that 'wander' edit's recheck shows the debt now covered", () => {
		const out = run({ editedFile: "src/bar.ts", baseDecision: null, openDebts: [debt("src/foo.ts")], rechecks: new Map([["src/foo.ts", true]]) });
		expect(out.decision).toBeNull(); // discharged first → no open debt → no wander block
		expect(out.txns[0]).toMatchObject({ op: "discharge" });
	});

	it("WIP > 1 lets the agent open a second pair without blocking", () => {
		const out = run({ editedFile: "src/bar.ts", baseDecision: uncovered("src/bar.ts"), openDebts: [debt("src/foo.ts")], wipLimit: 3 });
		expect(out.decision?.decision).toBe("allow"); // under the WIP limit — not a wander
		expect(out.txns[0]).toMatchObject({ op: "open", file: "src/bar.ts" });
	});

	it("does NOT block editing an UMBRELLA test for a decomposed-sibling debt (the reported case)", () => {
		// Debt on a decomposed sibling; the edit targets the umbrella test under
		// __tests__/. The umbrella-pair rule keeps this in-pair → no wander block.
		const out = run({
			editedFile: "src/harness/evaluator/__tests__/write-content-guards.test.ts",
			baseDecision: null,
			openDebts: [debt("src/harness/evaluator/write-content-guards-content-quality.ts")],
		});
		expect(out.decision).toBeNull(); // in-pair via umbrella → allowed
	});
});

describe("decideCoverageDebt — red-bar fold (the red→green loop)", () => {
	it("downgrades a red-bar block to allow + opens a red_suite debt (policy reversal, 2026-07)", () => {
		// The old rule ("red-bar passes through — write code + test together in one
		// batch") forced the scratchpad+batch dance for behavior changes. Red is
		// now the coverage debt's twin: progress allowed, wandering blocked.
		const out = run({ editedFile: "src/foo.ts", baseDecision: redBar() });
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain("red debt opened");
		expect(out.txns).toEqual([
			{ op: "open", kind: "red_suite", file: "src/foo.ts", contentHash: "", sessionId: "s", atMs: 1 },
		]);
	});

	it("does not double-open across same-pair red iterations", () => {
		const out = run({ editedFile: "src/foo.test.ts", baseDecision: redBar(), openDebts: [redDebt("src/foo.ts")] });
		expect(out.decision?.decision).toBe("allow");
		expect(out.txns).toHaveLength(0); // the pair's red debt already stands
	});

	it("discharges the pair's red debt on any non-red verdict", () => {
		const out = run({ editedFile: "src/foo.ts", baseDecision: null, openDebts: [redDebt("src/foo.ts")] });
		expect(out.decision).toBeNull();
		expect(out.txns).toEqual([
			{ op: "discharge", id: obligationId("red_suite", "src/foo.ts"), source: "local", atMs: 1 },
		]);
	});

	it("does NOT discharge the red debt on a pass-through block — that edit never lands", () => {
		// A CRAP / drop / floor block REFUSES the edit: disk is unchanged, so its
		// non-red overlay run proves nothing about the pair being green.
		const out = run({ editedFile: "src/foo.ts", baseDecision: crapBlock("src/foo.ts"), openDebts: [redDebt("src/foo.ts")] });
		expect(out.decision?.decision).toBe("block"); // the block passes through untouched
		expect(out.txns).toHaveLength(0); // and the red debt survives (no discharge txn)
	});
});

describe("decideCoverageDebt — a debt opened ON the test file names the pair correctly", () => {
	// The red→green loop's canonical FIRST edit is the failing test itself. A
	// debt whose file is a test path must name its SOURCE counterpart — not
	// derive `foo.test.test.ts` by appending another `.test` infix.
	it("red debt opened by the failing-TEST-first edit points at the source side", () => {
		const open = run({ editedFile: "src/foo.test.ts", baseDecision: redBar() });
		expect(open.decision?.decision).toBe("allow");
		expect(open.decision?.warnings?.[0]).toContain("its source (src/foo.ts)");
		expect(open.decision?.warnings?.[0]).not.toContain(".test.test.");
	});

	it("the wander block for a test-file RED debt names the pair's source side", () => {
		const out = run({ editedFile: "src/bar.ts", baseDecision: null, openDebts: [redDebt("src/foo.test.ts")] });
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.reason).toContain("src/foo.test.ts");
		expect(out.decision?.reason).toContain("its source (src/foo.ts)");
		expect(out.decision?.reason).not.toContain(".test.test.");
	});

	it("the wander block for a test-file COVERAGE debt names the pair's source side", () => {
		const out = run({ editedFile: "src/bar.ts", baseDecision: null, openDebts: [debt("src/foo.test.ts")] });
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.reason).toContain("cover its source (src/foo.ts)");
		expect(out.decision?.reason).not.toContain(".test.test.");
	});

	it("a coverage debt opened on a test file phrases the nudge around its source", () => {
		const out = run({ editedFile: "src/foo.test.ts", baseDecision: uncovered("src/foo.test.ts") });
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain("cover its source (src/foo.ts) next");
		expect(out.decision?.warnings?.[0]).not.toContain(".test.test.");
	});
});

describe("decideCoverageDebt — unrelated verdicts pass through", () => {
	it("a clean edit with no open debt is a plain allow (null)", () => {
		const out = run({ editedFile: "src/foo.ts", baseDecision: null });
		expect(out.decision).toBeNull();
		expect(out.txns).toHaveLength(0);
	});
});

// ----- verdict markers: the REAL producers and the matchers stay coupled -----
// The producers interpolate UNCOVERED_MARKER / RED_BAR_MARKER from this module,
// so this pin is structural — a reworded producer either keeps matching or
// fails here, never silently stops folding into debt.

describe("verdict markers — real producer reasons satisfy the debt-mode matchers", () => {
	it("the per-edit red-bar producer's reason satisfies isRedBarBlock", () => {
		expect(isRedBarBlock(blockForRedBar("src/m.ts", ["t1"]))).toBe(true);
	});

	it("the deletion red-bar producer's reason satisfies isRedBarBlock (deliberate: it folds too)", () => {
		// A landed deletion that breaks dependents is the same red→green loop —
		// under debt_mode it opens the pair's red debt instead of hard-blocking.
		expect(isRedBarBlock(blockForDeletionRedBar(["src/m.ts"], ["t1"]))).toBe(true);
	});

	it("both uncovered producers' reasons satisfy isUncoveredBlock", () => {
		const out: { now?: number } = {};
		// Per-function path (istanbul / JS): an uncovered function → blockForUncovered.
		const fnCov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [{ name: "f", line: 5, endLine: 9, hits: 0, statement_pct: 0 }],
		};
		expect(isUncoveredBlock(decideFromCoverage("/nonexistent", "src/m.ts", fnCov, undefined, out))).toBe(true);
		// Per-line path (coverage.py): an uncovered line → blockForUncoveredLine.
		const lineCov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [],
			coveredLines: new Set([1]),
			uncoveredLines: new Set([5]),
		};
		expect(isUncoveredBlock(decideFromCoverage("/nonexistent", "src/m.ts", lineCov, undefined, out))).toBe(true);
	});

	it("blockForCrossSuiteRedBar's reason does NOT satisfy isRedBarBlock — deliberately", () => {
		// Cross-ecosystem breakage ("leave the ${language} test suite RED") is not
		// the edited pair's red→green loop: debt-mode must NOT fold it into a
		// red_suite debt — it stays a hard block, backstopped by the commit gate.
		expect(isRedBarBlock(blockForCrossSuiteRedBar("python", ["x.py"], undefined))).toBe(false);
	});
});
