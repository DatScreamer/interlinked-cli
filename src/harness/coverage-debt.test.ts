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
	relatedToDebt,
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

// ----- failure-evidence relatedness (the genomics/themes class, 2026-07) -----
// A red episode's ground truth is WHICH TESTS FAIL, not filename convention.
// The reported false block: editing genomics.ts broke server-counts.test.ts
// (non-colocated, imports both genomics.ts AND themes.ts); the fix genuinely
// lives in themes.ts, but the pair rule read that as a wander and the block
// message named a genomics.test.ts that does not exist.

/** A red debt carrying the failing tests its opening run reported. */
function redDebtWith(file: string, failing: string[]): Obligation {
	return { ...redDebt(file), failingTestFiles: failing };
}

/** A red-bar verdict carrying parsed failing-test files (the producer shape). */
function redBarWith(failing: string[]): HarnessDecision {
	return { ...redBar(), failing_test_files: failing };
}

const GENOMICS = "cf/server/lib/curated/genomics.ts";
const THEMES = "cf/src/lib/themes.ts";
const COUNTS_TEST = "cf/src/lib/server-counts.test.ts";

describe("relatedToDebt — pair ∨ failing-test identity ∨ affected-test cone", () => {
	const d = redDebtWith(GENOMICS, [COUNTS_TEST]);

	it("keeps the filename pair related (legacy, no evidence needed)", () => {
		expect(relatedToDebt("cf/server/lib/curated/genomics.test.ts", d)).toBe(true);
	});

	it("relates the failing test file itself — non-colocated, no graph needed", () => {
		expect(relatedToDebt(COUNTS_TEST, d)).toBe(true);
		expect(relatedToDebt(COUNTS_TEST, d, null)).toBe(true);
	});

	it("relates a file whose affected-test selection reaches a failing test (themes.ts)", () => {
		expect(relatedToDebt(THEMES, d, new Set([COUNTS_TEST]))).toBe(true);
	});

	it("does NOT relate when the affected set misses every failing test", () => {
		expect(relatedToDebt("cf/src/other/feature.ts", d, new Set(["cf/src/other/feature.test.ts"]))).toBe(false);
	});

	it("does NOT relate beyond the pair when selection is unknown (null) — unknown never widens", () => {
		expect(relatedToDebt(THEMES, d, null)).toBe(false);
		expect(relatedToDebt(THEMES, d)).toBe(false);
	});

	it("reduces to the pair rule for a debt without evidence (coverage debts)", () => {
		expect(relatedToDebt(THEMES, redDebt(GENOMICS), new Set([COUNTS_TEST]))).toBe(false);
		expect(relatedToDebt(THEMES, debt(GENOMICS), new Set([COUNTS_TEST]))).toBe(false);
	});
});

describe("decideCoverageDebt — the atomic cross-module change is not a wander", () => {
	const open = [redDebtWith(GENOMICS, [COUNTS_TEST])];

	it("allows the in-cone themes.ts edit while red (still-red verdict continues the episode)", () => {
		const out = run({
			editedFile: THEMES,
			baseDecision: redBarWith([COUNTS_TEST]),
			openDebts: open,
			affectedTests: new Set([COUNTS_TEST]),
		});
		expect(out.decision?.decision).toBe("allow");
		// Same episode continued: no second red debt stacked on themes.ts.
		expect(out.txns.filter((t) => t.op === "open")).toHaveLength(0);
	});

	it("discharges the red debt when the in-cone edit lands with a non-red verdict", () => {
		const out = run({
			editedFile: THEMES,
			baseDecision: null,
			openDebts: open,
			affectedTests: new Set([COUNTS_TEST]),
		});
		expect(out.decision).toBeNull();
		expect(out.txns).toEqual([
			{ op: "discharge", id: obligationId("red_suite", GENOMICS), source: "local", atMs: 1 },
		]);
	});

	it("allows editing the failing test file itself and discharges on its landing non-red verdict", () => {
		const out = run({ editedFile: COUNTS_TEST, baseDecision: null, openDebts: open });
		expect(out.decision).toBeNull();
		expect(out.txns[0]).toMatchObject({ op: "discharge", id: obligationId("red_suite", GENOMICS) });
	});

	it("still blocks a genuinely unrelated edit while red — and names the real failing test", () => {
		const out = run({
			editedFile: "cf/src/other/feature.ts",
			baseDecision: null,
			openDebts: open,
			affectedTests: new Set(["cf/src/other/feature.test.ts"]),
		});
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.reason).toContain(COUNTS_TEST);
		expect(out.decision?.reason).not.toContain("genomics.test.ts"); // no phantom companion
		expect(out.decision?.reason).toContain("debt_wip_limit"); // the recorded escape is discoverable
	});

	it("still blocks without a graph answer when nothing else relates (unknown never widens)", () => {
		const out = run({ editedFile: THEMES, baseDecision: null, openDebts: open, affectedTests: null });
		expect(out.decision?.decision).toBe("block");
	});
});

describe("decideCoverageDebt — red evidence lifecycle", () => {
	it("records failing test files on a fresh red debt", () => {
		const out = run({ editedFile: GENOMICS, baseDecision: redBarWith([COUNTS_TEST]) });
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain(COUNTS_TEST);
		expect(out.txns).toEqual([
			{
				op: "open",
				kind: "red_suite",
				file: GENOMICS,
				contentHash: "",
				sessionId: "s",
				atMs: 1,
				failingTestFiles: [COUNTS_TEST],
			},
		]);
	});

	it("refreshes the recorded set when a related red run reports different failures", () => {
		const out = run({
			editedFile: GENOMICS,
			baseDecision: redBarWith([COUNTS_TEST, "cf/src/lib/themes.test.ts"]),
			openDebts: [redDebtWith(GENOMICS, [COUNTS_TEST])],
		});
		expect(out.decision?.decision).toBe("allow");
		expect(out.txns).toEqual([
			{
				op: "open",
				kind: "red_suite",
				file: GENOMICS,
				contentHash: "",
				sessionId: "s",
				atMs: 1,
				failingTestFiles: [COUNTS_TEST, "cf/src/lib/themes.test.ts"],
			},
		]);
	});

	it("does NOT re-open when the failing set is unchanged (no ledger spam)", () => {
		const out = run({
			editedFile: GENOMICS,
			baseDecision: redBarWith([COUNTS_TEST]),
			openDebts: [redDebtWith(GENOMICS, [COUNTS_TEST])],
		});
		expect(out.txns).toHaveLength(0);
	});

	it("keeps the recorded set when the new red run parsed nothing (no evidence ≠ new evidence)", () => {
		const out = run({
			editedFile: GENOMICS,
			baseDecision: redBar(),
			openDebts: [redDebtWith(GENOMICS, [COUNTS_TEST])],
		});
		expect(out.txns).toHaveLength(0);
	});
});

describe("wander-block message — companion existence honesty", () => {
	it("omits a phantom companion and points at the suite output when the probe says missing", () => {
		const out = run({
			editedFile: "src/bar.ts",
			baseDecision: null,
			openDebts: [redDebt(GENOMICS)],
			fileExists: () => false,
		});
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.reason).toContain("no cf/server/lib/curated/genomics.test.ts exists");
		expect(out.decision?.reason).not.toContain("or its test (cf/server/lib/curated/genomics.test.ts)");
	});

	it("names the companion when it exists", () => {
		const out = run({
			editedFile: "src/bar.ts",
			baseDecision: null,
			openDebts: [redDebt(GENOMICS)],
			fileExists: () => true,
		});
		expect(out.decision?.reason).toContain("its test (cf/server/lib/curated/genomics.test.ts)");
	});

	it("keeps legacy naming when no probe is supplied (pure callers)", () => {
		const out = run({ editedFile: "src/bar.ts", baseDecision: null, openDebts: [redDebt(GENOMICS)] });
		expect(out.decision?.reason).toContain("its test (cf/server/lib/curated/genomics.test.ts)");
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

// ----- ownership-scoped wander (foreign sessions, 2026-07-17) -------------

/** A debt opened by some OTHER session — the fixture the ownership rule keys on. */
function foreignDebt(file: string): Obligation {
	return { ...debt(file), sessionId: "other-session" };
}

describe("decideCoverageDebt — ownership-scoped wander", () => {
	it("notes-not-blocks an unrelated edit when the only open debt is another session's", () => {
		const out = run({ editedFile: "src/unrelated.ts", openDebts: [foreignDebt("src/other.ts")] });
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain("another session");
		expect(out.decision?.warnings?.[0]).toContain("src/other.ts");
	});

	it("still blocks when the session's OWN debt is at the WIP limit", () => {
		const out = run({ editedFile: "src/unrelated.ts", openDebts: [debt("src/other.ts")] });
		expect(out.decision?.decision).toBe("block");
	});

	it("picks the oldest OWN debt for the block even when a foreign debt is older", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [foreignDebt("src/theirs.ts"), debt("src/mine.ts")],
			wipLimit: 1,
		});
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.reason).toContain("src/mine.ts");
		expect(out.decision?.reason).not.toContain("src/theirs.ts");
	});

	it("attaches the foreign note to an uncovered-open outcome", () => {
		const out = run({
			editedFile: "src/new.ts",
			baseDecision: uncovered("src/new.ts"),
			openDebts: [foreignDebt("src/other.ts")],
		});
		expect(out.decision?.decision).toBe("allow");
		const joined = (out.decision?.warnings ?? []).join("\n");
		expect(joined).toContain("Opened coverage debt");
		expect(joined).toContain("another session");
		expect(out.txns.some((t) => t.op === "open")).toBe(true);
	});

	it("treats an unattributable owner (empty sessionId) as foreign — warn, never block", () => {
		const legacy = { ...debt("src/legacy.ts"), sessionId: "" };
		const out = run({ editedFile: "src/unrelated.ts", openDebts: [legacy] });
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain("src/legacy.ts");
	});

	it("suppresses the note when shouldNoteForeignDebt returns false", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [foreignDebt("src/other.ts")],
			shouldNoteForeignDebt: () => false,
		});
		expect(out.decision).toBeNull();
	});

	it("keeps a related edit to a foreign debt free of both block and note", () => {
		const out = run({ editedFile: "src/other.test.ts", openDebts: [foreignDebt("src/other.ts")] });
		expect(out.decision).toBeNull();
	});

	it("foreign debts fill the total threshold but never the OWN budget (wipLimit 2)", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [foreignDebt("src/a.ts"), foreignDebt("src/b.ts")],
			wipLimit: 2,
		});
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain("another session");
	});

	it("a red foreign debt notes the RED phrasing", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [{ ...redDebt("src/red.ts"), sessionId: "other-session" }],
		});
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.warnings?.[0]).toContain("RED");
	});
});
