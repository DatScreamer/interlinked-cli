import { describe, expect, it } from "vitest";
import {
	type CoverageDebtInput,
	decideCoverageDebt,
	expectedCompanionTest,
	isUncoveredBlock,
	pairStem,
} from "./coverage-debt.js";
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

/** A red-bar block — a DIFFERENT failure that must still pass through. */
function redBar(): HarnessDecision {
	return { decision: "block", reason: "[interlinked:coverage] BLOCKED: your edit leaves the test suite RED.", rule_id: "per-edit-coverage", severity: "medium", category: "coverage" };
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

describe("expectedCompanionTest", () => {
	it("names the conventional co-located test", () => {
		expect(expectedCompanionTest("src/foo.ts")).toBe("src/foo.test.ts");
		expect(expectedCompanionTest("src/util/clamp.mjs")).toBe("src/util/clamp.test.mjs");
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
});

describe("decideCoverageDebt — unrelated verdicts pass through", () => {
	it("a red-bar block is never downgraded to debt — passes through unchanged", () => {
		const base = redBar();
		const out = run({ editedFile: "src/foo.ts", baseDecision: base });
		expect(out.decision).toBe(base); // same object, untouched
		expect(out.txns).toHaveLength(0);
	});

	it("a clean edit with no open debt is a plain allow (null)", () => {
		const out = run({ editedFile: "src/foo.ts", baseDecision: null });
		expect(out.decision).toBeNull();
		expect(out.txns).toHaveLength(0);
	});
});
