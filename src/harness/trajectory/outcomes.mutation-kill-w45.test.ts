import { describe, expect, it } from "vitest";
import { joinRuleOutcomes, labelWindow, type OutcomeEvent } from "./outcomes.js";

function neutral(): OutcomeEvent {
	return { tool: "Read", decision: "allow", outcome: "success" };
}

function blockEvent(): OutcomeEvent {
	return { tool: "Bash", decision: "block", outcome: "success" };
}

describe("outcomes — hasRepairLoop green early-return (positive/negative)", () => {
	it("P1: a lone green verifier event ends the window with no repair label", () => {
		const events: OutcomeEvent[] = [{ tool: "Bash", decision: "allow", outcome: "success", verifier: "green" }];
		expect(labelWindow(events, -1, 1)).toEqual(["none"]);
	});

	it("P2: green BEFORE a red+double-edit sequence still yields no repair (early return short-circuits the rest)", () => {
		const events: OutcomeEvent[] = [
			{ tool: "Bash", decision: "allow", outcome: "success", verifier: "green" },
			{ tool: "Bash", decision: "allow", outcome: "success", verifier: "red" },
			{ tool: "Edit", decision: "allow", outcome: "success", file: "z" },
			{ tool: "Edit", decision: "allow", outcome: "success", file: "z" },
		];
		// The green event is first, so hasRepairLoop must return false immediately
		// regardless of what follows it. A broken comparison (StringLiteral "" or
		// ConditionalExpression false, or the BooleanLiteral false->true return
		// itself) would each let evaluation fall through to the red+double-edit
		// tail below and wrongly report "repair".
		expect(labelWindow(events, -1, 4)).toEqual(["none"]);
	});
});

describe("outcomes — hasRepairLoop sawRed guard (positive/negative)", () => {
	it("P1: two edits to the same file with NO red verifier yet is not a repair loop", () => {
		const events: OutcomeEvent[] = [
			{ tool: "Edit", decision: "allow", outcome: "success", file: "a" },
			{ tool: "Edit", decision: "allow", outcome: "success", file: "a" },
		];
		// `!sawRed || !e.file` must skip here because sawRed is still false.
		// The `&&` mutant only skips when BOTH sawRed is false AND file is
		// missing, so it would wrongly start counting edits before any red
		// verifier and report "repair" at the second edit.
		expect(labelWindow(events, -1, 2)).toEqual(["none"]);
	});

	it("N1: two edits to the same file AFTER a red verifier IS a repair loop", () => {
		const events: OutcomeEvent[] = [
			{ tool: "Bash", decision: "allow", outcome: "success", verifier: "red" },
			{ tool: "Edit", decision: "allow", outcome: "success", file: "a" },
			{ tool: "Edit", decision: "allow", outcome: "success", file: "a" },
		];
		expect(labelWindow(events, -1, 3)).toEqual(["repair"]);
	});
});

describe("outcomes — labelWindow errored detection uses .some, not .every", () => {
	it("P1: one error among several successes still labels the window errored", () => {
		const events: OutcomeEvent[] = [
			{ tool: "Bash", decision: "allow", outcome: "error" },
			{ tool: "Bash", decision: "allow", outcome: "success" },
		];
		// .every would require ALL events to be errors; here only one is.
		expect(labelWindow(events, -1, 2)).toEqual(["errored"]);
	});

	it("N1: no errors at all yields no errored label", () => {
		const events: OutcomeEvent[] = [
			{ tool: "Bash", decision: "allow", outcome: "success" },
			{ tool: "Bash", decision: "allow", outcome: "success" },
		];
		expect(labelWindow(events, -1, 2)).toEqual(["none"]);
	});
});

describe("outcomes — baseRateOf empty-events guard", () => {
	it("P1: an empty event log yields baseRate 0, not NaN from 0/0", () => {
		const result = joinRuleOutcomes({ ruleId: "r", firedAt: [] }, [], 5);
		expect(result.baseRate).toBe(0);
		expect(Number.isNaN(result.baseRate)).toBe(false);
	});
});

describe("outcomes — baseRateOf bad/good window classification is not inverted", () => {
	it("P1: exactly one bad window out of three yields baseRate 1/3, not 2/3", () => {
		// A: neutral placeholder. B: triggers "blocked" for whoever's window
		// contains it. C: neutral.
		const events: OutcomeEvent[] = [neutral(), blockEvent(), neutral()];
		// i=0 window=[B] -> blocked (bad). i=1 window=[C] -> none. i=2 window=[] -> none.
		expect(labelWindow(events, 0, 1)).toEqual(["blocked"]);
		expect(labelWindow(events, 1, 1)).toEqual(["none"]);
		expect(labelWindow(events, 2, 1)).toEqual(["none"]);
		const result = joinRuleOutcomes({ ruleId: "r", firedAt: [] }, events, 1);
		expect(result.baseRate).toBeCloseTo(1 / 3, 10);
	});
});

describe("outcomes — precision is hits / fires, not hits * fires", () => {
	it("P1: 2 hits out of 4 fires is precision 0.5", () => {
		const events: OutcomeEvent[] = [
			neutral(), // index 0 (own content unused)
			blockEvent(), // index 1 -> window content for fired index 0
			neutral(), // index 2 -> window content for fired index 1
			blockEvent(), // index 3 -> window content for fired index 2
			neutral(), // index 4 -> window content for fired index 3
		];
		const firings = { ruleId: "r", firedAt: [0, 1, 2, 3] };
		const result = joinRuleOutcomes(firings, events, 1);
		expect(result.fires).toBe(4);
		expect(result.hits).toBe(2);
		expect(result.precision).toBeCloseTo(0.5, 10);
	});
});

function buildTenFiredEvents(): { events: OutcomeEvent[]; firings: { ruleId: string; firedAt: number[] } } {
	// indices 0..10 are "block" (11 events); indices 11..19 are neutral (9 events).
	const events: OutcomeEvent[] = [];
	for (let i = 0; i <= 10; i++) events.push(blockEvent());
	for (let i = 11; i <= 19; i++) events.push(neutral());
	// fired at 0..9: window for fired index i is events[i+1], which lands in
	// the block range (1..10) for every one of them -> all 10 are hits.
	return { events, firings: { ruleId: "r", firedAt: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } };
}

describe("outcomes — verdictFor minFires boundary (fires === minFires must NOT be insufficient)", () => {
	it("P1: fires exactly equal to minFires (10) with strong lift promotes, not insufficient", () => {
		const { events, firings } = buildTenFiredEvents();
		const result = joinRuleOutcomes(firings, events, 1);
		expect(result.fires).toBe(10);
		expect(result.precision).toBeCloseTo(1, 10);
		expect(result.baseRate).toBeCloseTo(0.5, 10);
		expect(result.lift).toBeCloseTo(2, 10);
		expect(result.verdict).toBe("promote");
	});
});

describe("outcomes — verdictFor lift threshold (lift below minLift must hold, not promote)", () => {
	it("P1: lift 2 with a raised minLift of 3 must hold, not promote", () => {
		const { events, firings } = buildTenFiredEvents();
		const result = joinRuleOutcomes(firings, events, 1, { minLift: 3 });
		expect(result.lift).toBeCloseTo(2, 10);
		expect(result.verdict).toBe("hold");
	});
});

describe("outcomes — verdictFor / joinRuleOutcomes lift is null when baseRate is 0, not NaN", () => {
	it("P1: all-neutral events (baseRate 0, precision 0) yields lift null and verdict hold", () => {
		const events: OutcomeEvent[] = [];
		for (let i = 0; i < 20; i++) events.push(neutral());
		const firings = { ruleId: "r", firedAt: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] };
		const result = joinRuleOutcomes(firings, events, 1, { minLift: 0 });
		expect(result.fires).toBe(10);
		expect(result.precision).toBe(0);
		expect(result.baseRate).toBe(0);
		expect(result.lift).toBeNull();
		expect(result.verdict).toBe("hold");
	});
});

describe("outcomes — lift is null (not 0) when the rule never fired but the base rate is positive", () => {
	it("P1: fires 0 with a positive base rate elsewhere yields precision null and lift null", () => {
		const events: OutcomeEvent[] = [neutral(), blockEvent()];
		// i=0 window=[events[1]]=block -> bad. i=1 window=[] -> none. baseRate=0.5.
		const result = joinRuleOutcomes({ ruleId: "r", firedAt: [] }, events, 1);
		expect(result.fires).toBe(0);
		expect(result.precision).toBeNull();
		expect(result.baseRate).toBeCloseTo(0.5, 10);
		expect(result.lift).toBeNull();
		expect(result.verdict).toBe("no_evidence");
	});
});

describe("outcomes — options use ?? (nullish coalescing), not && (truthiness)", () => {
	it("P1: an explicit truthy minLift override (5) must be honored as-is, not replaced by the default", () => {
		const { events, firings } = buildTenFiredEvents();
		// lift is 2 here (see boundary test above). A custom minLift of 5 should
		// make this "hold" because 2 < 5. If `??` were `&&`, a truthy 5 would
		// evaluate the whole expression to DEFAULT_MIN_LIFT (1.5), and 2 >= 1.5
		// would wrongly promote.
		const result = joinRuleOutcomes(firings, events, 1, { minLift: 5 });
		expect(result.lift).toBeCloseTo(2, 10);
		expect(result.verdict).toBe("hold");
	});

	it("P2: an explicit truthy minFires override (3) must be honored as-is, not replaced by the default", () => {
		// Five fired indices, all hits, over a ten-event window -> lift 2.
		const events: OutcomeEvent[] = [];
		for (let i = 0; i <= 5; i++) events.push(blockEvent());
		for (let i = 6; i <= 9; i++) events.push(neutral());
		const firings = { ruleId: "r", firedAt: [0, 1, 2, 3, 4] };
		const result = joinRuleOutcomes(firings, events, 1, { minFires: 3 });
		expect(result.fires).toBe(5);
		// If `??` were `&&`, a truthy 3 would evaluate the whole expression to
		// DEFAULT_MIN_FIRES (10), and fires(5) < 10 would wrongly report
		// "insufficient" instead of proceeding to the lift check.
		expect(result.verdict).not.toBe("insufficient");
		expect(result.verdict).toBe("promote");
	});
});
