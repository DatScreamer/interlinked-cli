// Pins the review 2026-08-24 item-4 fix: every "could not measure" exit obeys
// `unavailable_behavior` through ONE choke point, and warn mode downgrades the
// fail-closed block like any other block.

import { describe, expect, it } from "vitest";
import {
	adoptionDecision,
	applyMode,
	decideAndPersist,
	failClosed,
	notMeasured,
	persistIfCleanMeasured,
	unavailableDecision,
} from "./gate-decision.js";
import type { MutationGateOutcome } from "./types.js";

describe("unavailableDecision — positive (must fire)", () => {
	it("P1: blocks under unavailable_behavior=block, naming the cause", () => {
		const d = unavailableDecision({ mode: "block", unavailable_behavior: "block" }, "the runner exploded");
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("the runner exploded");
		expect(d.reason).toContain("unavailable_behavior=block");
	});

	it("P2: warn mode downgrades the fail-closed block to allow + warning", () => {
		const d = unavailableDecision({ mode: "warn", unavailable_behavior: "block" }, "boom");
		expect(d.decision).toBe("allow");
		expect(d.warnings?.[0]).toContain("boom");
	});
});

describe("unavailableDecision — negative (must not fire)", () => {
	it("N1: allow_unmeasured yields an honest not-measured allow, never a block", () => {
		const d = unavailableDecision({ mode: "block", unavailable_behavior: "allow_unmeasured" }, "no runner");
		expect(d.decision).toBe("allow");
		expect(d.warnings?.[0]).toContain("[mutation:not-measured]");
		expect(d.warnings?.[0]).toContain("no runner");
	});
});

describe("applyMode / failClosed / notMeasured wire shapes", () => {
	it("P3: failClosed carries the rule id and category", () => {
		const d = failClosed("x");
		expect(d.rule_id).toBe("per-edit-mutation");
		expect(d.category).toBe("mutation");
	});

	it("N2: applyMode leaves an allow untouched in warn mode", () => {
		const d = applyMode({ decision: "allow" }, "warn");
		expect(d.decision).toBe("allow");
	});

	it("P4: notMeasured prefixes the warning with the not-measured tag", () => {
		expect(notMeasured("r")).toMatchObject({ kind: "unavailable", warning: "[mutation:not-measured] r" });
	});
});

describe("persistIfCleanMeasured", () => {
	const cleanOutcome = (refreshed: boolean): Extract<MutationGateOutcome, { kind: "measured" }> => ({
		kind: "measured",
		decision: "allow",
		receipt: {
			overlayHash: "h",
			generation: 0,
			sites: [],
			engine: "stryker",
			engineVersion: "0",
			measuredAt: "t",
			outcome: "measured_clean",
		},
		newSurvivors: [],
		uncoveredSites: [],
		changedSiteCount: 0,
		siteCountThreshold: 50,
		suiteRed: false,
		redWitnessFailed: false,
		...(refreshed
			? {
					refreshedManifest: {
						version: 1 as const,
						generation: 1,
						authoritativeAt: "t",
						engine: "stryker",
						engineVersion: "0",
						dependencyGraphVersion: "g",
						environmentHash: "e",
						files: {},
					},
				}
			: {}),
	});

	it("P5: persists on a measured-clean allow and returns null", () => {
		let calls = 0;
		expect(persistIfCleanMeasured(cleanOutcome(true), () => void calls++)).toBeNull();
		expect(calls).toBe(1);
	});

	it("N3: never persists without a refreshed manifest", () => {
		let calls = 0;
		expect(persistIfCleanMeasured(cleanOutcome(false), () => void calls++)).toBeNull();
		expect(calls).toBe(0);
	});

	it("P6: a throwing persist becomes a warning, not an exception", () => {
		const w = persistIfCleanMeasured(cleanOutcome(true), () => {
			throw new Error("disk full");
		});
		expect(w).toContain("disk full");
	});

	it("N4: a measured BLOCK still never persists, even with adoption in the union", () => {
		let calls = 0;
		// cleanOutcome returns the measured variant, so overriding `decision`
		// yields another valid measured outcome — no cast needed.
		const block: MutationGateOutcome = { ...cleanOutcome(true), decision: "block" };
		expect(persistIfCleanMeasured(block, () => void calls++)).toBeNull();
		expect(calls).toBe(0);
	});

	it("N5: adoption never persists through THIS function — adoptionDecision owns it", () => {
		let calls = 0;
		expect(persistIfCleanMeasured(adoptionReady(), () => void calls++)).toBeNull();
		expect(calls).toBe(0);
	});
});

// Review 2026-08-28 item 1: "adopted" is declared only after the persistence
// callback completes (not crash-durable; the sequence has no transaction) — it is
// declared only after persistence succeeds, and downgraded honestly otherwise.
function adoptionReady(redWitnessFailed = false): Extract<MutationGateOutcome, { kind: "baseline_adoption_ready" }> {
	return {
		kind: "baseline_adoption_ready",
		receipt: {
			overlayHash: "h",
			generation: 0,
			sites: [],
			engine: "stryker",
			engineVersion: "0",
			measuredAt: "t",
			outcome: "baseline_adopted",
		},
		refreshedManifest: {
			version: 1 as const,
			generation: 1,
			authoritativeAt: "t",
			engine: "stryker",
			engineVersion: "0",
			dependencyGraphVersion: "g",
			environmentHash: "e",
			files: {},
		},
		warning: "[interlinked:mutation] baseline adopted for src/x.ts — NOT certified clean",
		...(redWitnessFailed ? { redWitnessFailed: true } : {}),
	};
}

describe("adoptionDecision — adopted only after the persistence callback completes", () => {
	it("P1: persist succeeds → the ADOPTED warning, exactly one persist call", () => {
		let calls = 0;
		const d = adoptionDecision(adoptionReady(), () => void calls++);
		expect(calls).toBe(1);
		expect(d.decision).toBe("allow");
		expect(d.warnings?.[0]).toContain("baseline adopted");
		expect(d.warnings?.[0]).toContain("NOT certified clean");
	});

	it("N1: persist THROWS → 'measured but NOT adopted — persistence failed', never the adopted claim", () => {
		const d = adoptionDecision(adoptionReady(), () => {
			throw new Error("disk full");
		});
		expect(d.decision).toBe("allow");
		// The failure wording deliberately does NOT claim "no durable floor
		// exists" — a mid-sequence throw can leave a valid manifest behind
		// (review 2026-08-28 second pass, finding 2, reproduced live).
		expect(d.warnings?.[0]).toContain("NOT fully adopted");
		expect(d.warnings?.[0]).toContain("PARTIAL");
		expect(d.warnings?.[0]).toContain("disk full");
		expect(d.warnings?.[0]).not.toContain("baseline adopted for");
	});

	it("N2: NO persist callback → same NOT-adopted downgrade (nothing was persisted at all)", () => {
		const d = adoptionDecision(adoptionReady(), undefined);
		// The failure wording deliberately does NOT claim "no durable floor
		// exists" — a mid-sequence throw can leave a valid manifest behind
		// (review 2026-08-28 second pass, finding 2, reproduced live).
		expect(d.warnings?.[0]).toContain("NOT fully adopted");
		expect(d.warnings?.[0]).toContain("PARTIAL");
		expect(d.warnings?.[0]).toContain("no persistence configured");
	});

	// The one exit the gate actually calls: adoption routes to the
	// persist-then-declare path, everything else to the ordinary mapping.
	it("P4: decideAndPersist routes adoption through the persist-then-declare path", () => {
		let calls = 0;
		const d = decideAndPersist(adoptionReady(), () => void calls++, "block");
		expect(calls).toBe(1);
		expect(d.decision).toBe("allow");
		expect(d.warnings?.[0]).toContain("baseline adopted");
	});

	it("N3: decideAndPersist still maps a measured block to a block (and persists nothing)", () => {
		let calls = 0;
		const block: MutationGateOutcome = {
			kind: "measured",
			decision: "block",
			receipt: {
				overlayHash: "h",
				generation: 0,
				sites: [],
				engine: "stryker",
				engineVersion: "0",
				measuredAt: "t",
				outcome: "finding",
			},
			newSurvivors: [],
			uncoveredSites: ["site-1"],
			changedSiteCount: 1,
			siteCountThreshold: 50,
		};
		const d = decideAndPersist(block, () => void calls++, "block");
		expect(d.decision).toBe("block");
		expect(calls).toBe(0);
	});

	// Review item 3: the RED-witness warning survives adoption in BOTH branches.
	it("P2: RED-witness warning rides along with a successful adoption", () => {
		const d = adoptionDecision(adoptionReady(true), () => {});
		expect(d.warnings).toHaveLength(2);
		expect(d.warnings?.[1]).toContain("RED-witness");
	});

	it("P3: RED-witness warning also rides along with a FAILED adoption", () => {
		const d = adoptionDecision(adoptionReady(true), () => {
			throw new Error("boom");
		});
		expect(d.warnings).toHaveLength(2);
		// The failure wording deliberately does NOT claim "no durable floor
		// exists" — a mid-sequence throw can leave a valid manifest behind
		// (review 2026-08-28 second pass, finding 2, reproduced live).
		expect(d.warnings?.[0]).toContain("NOT fully adopted");
		expect(d.warnings?.[0]).toContain("PARTIAL");
		expect(d.warnings?.[1]).toContain("RED-witness");
	});
});
