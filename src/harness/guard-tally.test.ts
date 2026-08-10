// Live guard tally — what the harness has actually DONE for you.
//
// The statusline's numbers today describe the HARNESS (rule count, check
// count). A human reads those once, learns the tool is installed, and never
// looks again — and a drifting count actively erodes trust. What a human
// cannot see today is the thing the product exists to do: refuse bad tool
// calls. This tally is the substrate for showing it.
//
// O(1) per decision and read on a 10s tick, so it costs nothing on the hook
// path. Counted since DAEMON START, and labeled that way — a restart honestly
// resets it rather than implying a longer history than the process has.

import { beforeEach, describe, expect, it } from "vitest";
import { guardTallySnapshot, recordGuardDecision, resetGuardTally } from "./guard-tally.js";

beforeEach(() => {
	resetGuardTally();
});

describe("recordGuardDecision — positive (must tally)", () => {
	it("P1: a block increments the block count", () => {
		recordGuardDecision({ decision: "block" });
		expect(guardTallySnapshot().blocked).toBe(1);
	});

	it("P2: warnings on an allowed call are tallied without counting as a block", () => {
		recordGuardDecision({ decision: "allow", warnings: ["a", "b"] });
		const t = guardTallySnapshot();
		expect(t.warned).toBe(2);
		expect(t.blocked).toBe(0);
	});

	it("P3: an `ask` is tallied separately — it is not a refusal", () => {
		recordGuardDecision({ decision: "ask" });
		const t = guardTallySnapshot();
		expect(t.asked).toBe(1);
		expect(t.blocked).toBe(0);
	});

	it("P4: the most recent blocking rule is remembered for display", () => {
		recordGuardDecision({ decision: "block", rule_id: "builtin-rm-rf-root" });
		expect(guardTallySnapshot().lastBlockRule).toBe("builtin-rm-rf-root");
	});

	it("P5: tallies accumulate across calls", () => {
		recordGuardDecision({ decision: "block" });
		recordGuardDecision({ decision: "block" });
		recordGuardDecision({ decision: "allow", warnings: ["w"] });
		const t = guardTallySnapshot();
		expect(t.blocked).toBe(2);
		expect(t.warned).toBe(1);
	});
});

describe("recordGuardDecision — negative (must not inflate)", () => {
	it("N1: a clean allow changes nothing", () => {
		recordGuardDecision({ decision: "allow" });
		expect(guardTallySnapshot()).toMatchObject({ blocked: 0, warned: 0, asked: 0 });
	});

	it("N2: an allow with an empty warnings array is still clean", () => {
		recordGuardDecision({ decision: "allow", warnings: [] });
		expect(guardTallySnapshot().warned).toBe(0);
	});

	it("N3: a block with no rule_id leaves the last-rule label unset", () => {
		recordGuardDecision({ decision: "block" });
		expect(guardTallySnapshot().lastBlockRule).toBeNull();
	});

	it("N4: a later block WITHOUT a rule id does not erase the remembered one", () => {
		recordGuardDecision({ decision: "block", rule_id: "builtin-git-force-push" });
		recordGuardDecision({ decision: "block" });
		expect(guardTallySnapshot().lastBlockRule).toBe("builtin-git-force-push");
	});

	it("N5: reset returns every counter to zero — a restart claims no history", () => {
		recordGuardDecision({ decision: "block", rule_id: "r" });
		resetGuardTally();
		expect(guardTallySnapshot()).toEqual({
			blocked: 0,
			warned: 0,
			asked: 0,
			lastBlockRule: null,
		});
	});
});
