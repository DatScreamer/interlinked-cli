import { describe, expect, it } from "vitest";
import type { MutantRecord, MutationGateOutcome, MutationReceipt, StableId } from "./types.js";
import { mutationOutcomeToDecision } from "./verdict.js";

const receipt: MutationReceipt = {
	overlayHash: "h",
	generation: 1,
	sites: [],
	engine: "stryker",
	engineVersion: "1",
	measuredAt: "t",
};

/** Build a measured outcome; site-count defaults keep oversize OFF unless overridden. */
function measured(f: {
	decision: "allow" | "block";
	newSurvivors?: MutantRecord[];
	uncoveredSites?: StableId[];
	changedSiteCount?: number;
	siteCountThreshold?: number;
	suiteRed?: boolean;
	redWitnessFailed?: boolean;
}): MutationGateOutcome {
	return {
		kind: "measured",
		decision: f.decision,
		receipt,
		newSurvivors: f.newSurvivors ?? [],
		uncoveredSites: f.uncoveredSites ?? [],
		changedSiteCount: f.changedSiteCount ?? 1,
		siteCountThreshold: f.siteCountThreshold ?? 50,
		suiteRed: f.suiteRed ?? false,
		redWitnessFailed: f.redWitnessFailed ?? false,
	};
}

function survivor(mutator: string): MutantRecord {
	return {
		mutantId: "m",
		siteId: "s",
		mutator,
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
		status: "survived",
		firstSeen: "t",
	};
}

describe("mutationOutcomeToDecision", () => {
	it("maps unavailable to allow + a not-measured warning, never a clean pass", () => {
		const d = mutationOutcomeToDecision({
			kind: "unavailable",
			reason: "cloud down",
			warning: "[mutation:not-measured] cloud down",
		});
		expect(d.decision).toBe("allow");
		expect(d.warnings).toEqual(["[mutation:not-measured] cloud down"]);
		expect(d.reason).toBeUndefined();
	});

	it("maps a measured-clean allow to a plain allow", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "allow" }));
		expect(d.decision).toBe("allow");
		expect(d.reason).toBeUndefined();
		expect(d.warnings).toBeUndefined();
	});

	it("maps a survivor block to a block carrying the work-list, no uncovered text", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", newSurvivors: [survivor("EqualityOperator")] }));
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("1 new surviving mutant(s)");
		expect(d.reason).toContain("EqualityOperator >→>=");
		expect(d.reason).not.toContain("uncovered");
		expect(d.rule_id).toBe("per-edit-mutation");
		expect(d.severity).toBe("medium");
	});

	it("maps an uncovered-only block without a survivor list", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", uncoveredSites: ["a", "b"] }));
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("2 uncovered changed mutation site(s)");
		expect(d.reason).not.toContain("Survivors:");
	});

	it("maps an oversize block to the 'split this patch' message, suppressing the survivor list", () => {
		// Oversize takes precedence: even with a survivor present, the actionable is "split".
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", newSurvivors: [survivor("EqualityOperator")], changedSiteCount: 51, siteCountThreshold: 50 }),
		);
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("51 mutation sites");
		expect(d.reason).toContain("50-site small-scope limit");
		expect(d.reason).not.toContain("Survivors:");
	});

	it("maps a red suite to the top-priority red/green block, over oversize and survivors", () => {
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", suiteRed: true, newSurvivors: [survivor("Eq")], changedSiteCount: 99, siteCountThreshold: 50 }),
		);
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("RED on this edit");
		expect(d.reason).not.toContain("mutation sites"); // not the oversize message
		expect(d.reason).not.toContain("Survivors:");
	});

	it("maps a failed RED-witness to allow + a non-blocking warning", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "allow", redWitnessFailed: true }));
		expect(d.decision).toBe("allow");
		expect(d.reason).toBeUndefined();
		expect(d.warnings?.[0]).toContain("RED-witness unmet");
	});
});
