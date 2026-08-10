// Sequence → outcome joining (trajectory program, step 2).
//
// The point is NOT to mine rules out of this repo's logs — one agent on one
// hardened codebase is a biased sample, and CLAUDE.md is explicit that fire
// rate measures the AGENT, not the check. Rules come from REASONING about how
// agent work goes wrong. This module supplies the other half: whether a rule
// that fired here was followed by trouble, so promotion is evidence-backed and
// a noisy rule is visible before it ever nudges anyone.
//
// The five labels below are derived from failure modes, not from the data:
//   blocked   — a gate refused a later call: the sequence led somewhere bad
//   errored   — a later call failed outright
//   reverted  — a file returned to a content hash it already had (thrash)
//   repair    — repeated edits to one file with a failing verifier, no green
//   none      — the horizon passed without any of the above
//
// Asymmetry that matters: a rule that never fires gets NO verdict. Silence is
// not evidence against a check (it may be the part of the standard this agent
// already clears), which is why the report can only ever support PROMOTION.

import { describe, expect, it } from "vitest";
import { joinRuleOutcomes, labelWindow, type OutcomeEvent } from "./outcomes.js";

function ev(over: Partial<OutcomeEvent>): OutcomeEvent {
	return { tool: "Edit", decision: "allow", outcome: "success", ...over };
}

describe("labelWindow — positive (must label)", () => {
	it("P1: a later blocked call labels the window `blocked`", () => {
		const events = [ev({}), ev({}), ev({ decision: "block" })];
		expect(labelWindow(events, 0, 3)).toContain("blocked");
	});

	it("P2: a later failed call labels the window `errored`", () => {
		const events = [ev({}), ev({ outcome: "error" })];
		expect(labelWindow(events, 0, 3)).toContain("errored");
	});

	it("P3: a file returning to a prior content hash labels `reverted`", () => {
		const events = [
			ev({ file: "a.ts", sha: "h1" }),
			ev({ file: "a.ts", sha: "h2" }),
			ev({ file: "a.ts", sha: "h1" }),
		];
		expect(labelWindow(events, 0, 3)).toContain("reverted");
	});

	it("P4: repeated edits to one file with a red verifier and no green labels `repair`", () => {
		const events = [
			ev({ file: "a.ts", sha: "h1" }),
			ev({ tool: "Bash", verifier: "red" }),
			ev({ file: "a.ts", sha: "h2" }),
			ev({ tool: "Bash", verifier: "red" }),
			ev({ file: "a.ts", sha: "h3" }),
		];
		expect(labelWindow(events, 0, 5)).toContain("repair");
	});
});

describe("labelWindow — negative (must NOT label)", () => {
	it("N1: a clean run of allowed, successful calls labels `none`", () => {
		const events = [ev({}), ev({}), ev({})];
		expect(labelWindow(events, 0, 3)).toEqual(["none"]);
	});

	it("N2: trouble BEYOND the horizon does not label the window", () => {
		const events = [ev({}), ev({}), ev({}), ev({ decision: "block" })];
		expect(labelWindow(events, 0, 2)).toEqual(["none"]);
	});

	it("N3: trouble BEFORE the index does not label the window", () => {
		const events = [ev({ decision: "block" }), ev({}), ev({})];
		expect(labelWindow(events, 1, 3)).toEqual(["none"]);
	});

	it("N4: a red verifier that later turns green is not a repair loop", () => {
		const events = [
			ev({ file: "a.ts", sha: "h1" }),
			ev({ tool: "Bash", verifier: "red" }),
			ev({ file: "a.ts", sha: "h2" }),
			ev({ tool: "Bash", verifier: "green" }),
		];
		expect(labelWindow(events, 0, 4)).not.toContain("repair");
	});

	it("N5: edits to DIFFERENT files are not thrash", () => {
		const events = [
			ev({ file: "a.ts", sha: "h1" }),
			ev({ file: "b.ts", sha: "h1" }),
			ev({ file: "c.ts", sha: "h1" }),
		];
		expect(labelWindow(events, 0, 3)).toEqual(["none"]);
	});
});

describe("joinRuleOutcomes — evidence for promotion, never demotion", () => {
	it("P5: a rule whose firings precede trouble scores lift above 1", () => {
		const events = [
			ev({}),
			ev({ decision: "block" }),
			ev({}),
			ev({}),
			ev({}),
			ev({}),
		];
		const stats = joinRuleOutcomes({ ruleId: "r1", firedAt: [0] }, events, 2);
		expect(stats.fires).toBe(1);
		expect(stats.hits).toBe(1);
		expect(stats.precision).toBe(1);
		expect(stats.lift).toBeGreaterThan(1);
	});

	it("P6: a rule firing only on clean stretches scores precision 0", () => {
		const events = [ev({}), ev({}), ev({}), ev({ decision: "block" })];
		const stats = joinRuleOutcomes({ ruleId: "r2", firedAt: [0] }, events, 1);
		expect(stats.precision).toBe(0);
	});

	it("N6: a rule that never fired here yields NO verdict — silence is not evidence", () => {
		const stats = joinRuleOutcomes({ ruleId: "r3", firedAt: [] }, [ev({})], 3);
		expect(stats.fires).toBe(0);
		expect(stats.precision).toBeNull();
		expect(stats.verdict).toBe("no_evidence");
	});

	it("N7: too few firings yields `insufficient` rather than a precision claim", () => {
		const events = [ev({}), ev({ decision: "block" })];
		const stats = joinRuleOutcomes({ ruleId: "r4", firedAt: [0] }, events, 2, { minFires: 5 });
		expect(stats.verdict).toBe("insufficient");
	});

	it("N8: a verdict is never `demote` — this report can only support promotion", () => {
		const events = [ev({}), ev({}), ev({}), ev({}), ev({}), ev({})];
		const stats = joinRuleOutcomes({ ruleId: "r5", firedAt: [0, 1, 2, 3, 4] }, events, 1, {
			minFires: 1,
		});
		expect(["promote", "hold", "insufficient", "no_evidence"]).toContain(stats.verdict);
	});
});
