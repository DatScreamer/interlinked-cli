import { describe, expect, it } from "vitest";
import { freshInstability, mutantIdsChurned, updateInstability } from "./instability.js";
import type { IdentityInstability, SymbolRecord } from "./types.js";

function symbolWithMutants(ids: string[]): SymbolRecord {
	const mutants: SymbolRecord["mutants"] = {};
	for (const id of ids) {
		mutants[id] = {
			mutantId: id,
			siteId: `${id}-s`,
			mutator: "Op",
			originalLexeme: ">",
			replacement: ">=",
			ordinalWithinSymbol: 0,
			status: "survived",
			firstSeen: "t",
		};
	}
	return { symbolId: "s", qualifiedName: "fn", symbolHash: "h", mutants, instability: freshInstability() };
}

describe("mutantIdsChurned", () => {
	it("is false when the recorded and fresh id sets match", () => {
		expect(mutantIdsChurned(symbolWithMutants(["a", "b"]), new Set(["a", "b"]))).toBe(false);
	});
	it("is true on a size difference", () => {
		expect(mutantIdsChurned(symbolWithMutants(["a", "b"]), new Set(["a"]))).toBe(true);
	});
	it("is true on a membership difference at equal size", () => {
		expect(mutantIdsChurned(symbolWithMutants(["a", "b"]), new Set(["a", "c"]))).toBe(true);
	});
	it("is true when recorded ids are a strict SUBSET of current (new ids appeared)", () => {
		// Every recorded id still present, but the fresh derivation minted extras.
		// Kills the size-guard mutant (condition → false falls through to the
		// membership loop, which sees no missing ids and wrongly reports stable) —
		// found live by Stryker 2026-07-02.
		expect(mutantIdsChurned(symbolWithMutants(["a"]), new Set(["a", "b"]))).toBe(true);
	});
});

describe("freshInstability", () => {
	it("starts un-quarantined with zero stable runs and no events", () => {
		// Pins the full initial shape — a fresh symbol must be BLOCK-capable
		// immediately (quarantined:false). Kills the `false→true` literal mutant
		// found live by Stryker 2026-07-02.
		expect(freshInstability()).toEqual({ events: [], consecutiveStableRuns: 0, quarantined: false });
	});
});

describe("updateInstability", () => {
	it("quarantines and resets on churn, recording an event", () => {
		const next = updateInstability(freshInstability(), { churned: true, at: "t1", threshold: 3 });
		expect(next.quarantined).toBe(true);
		expect(next.consecutiveStableRuns).toBe(0);
		expect(next.events).toEqual([{ at: "t1", kind: "id_churn" }]);
	});

	it("increments stable runs and clears quarantine at the threshold", () => {
		const q: IdentityInstability = { events: [], consecutiveStableRuns: 2, quarantined: true };
		const next = updateInstability(q, { churned: false, at: "t", threshold: 3 });
		expect(next.consecutiveStableRuns).toBe(3);
		expect(next.quarantined).toBe(false);
	});

	it("stays quarantined below the threshold", () => {
		const q: IdentityInstability = { events: [], consecutiveStableRuns: 0, quarantined: true };
		const next = updateInstability(q, { churned: false, at: "t", threshold: 3 });
		expect(next.consecutiveStableRuns).toBe(1);
		expect(next.quarantined).toBe(true);
	});

	it("caps the event log and keeps the newest", () => {
		const many = Array.from({ length: 25 }, (_, i) => ({ at: `t${i}`, kind: "id_churn" as const }));
		const prior: IdentityInstability = { events: many, consecutiveStableRuns: 0, quarantined: true };
		const next = updateInstability(prior, { churned: true, at: "new", threshold: 3 });
		expect(next.events.length).toBeLessThanOrEqual(20);
		expect(next.events.at(-1)).toEqual({ at: "new", kind: "id_churn" });
	});
});
