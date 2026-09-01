// Pins the read-side survivor-diff helpers (extracted from manifest.ts) and
// the new priorStatuses transition baseline (review 2026-08-25, pass 6:
// killed→uncovered is a regression, always-uncovered is not — only the
// recorded prior status can tell them apart).

import { describe, expect, it } from "vitest";
import {
	acceptedSurvivors,
	computeNewSurvivors,
	hasFileBaseline,
	priorStatuses,
	toMutantRecord,
} from "./manifest-diff.js";
import type { MutantIdentity, MutantStatus, MutationManifest, SymbolRecord } from "./types.js";

const FILE = "src/x.ts";

function identity(mutantId: string): MutantIdentity {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		symbolId: "sym-1",
		qualifiedName: "f",
		mutator: "Eq",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
	};
}

function manifestWith(statuses: Record<string, MutantStatus>): MutationManifest {
	const mutants: Record<string, SymbolRecord["mutants"][string]> = {};
	for (const [id, status] of Object.entries(statuses)) {
		mutants[id] = toMutantRecord(identity(id), status, "t0");
	}
	return {
		version: 1,
		generation: 1,
		authoritativeAt: "t0",
		engine: "stryker",
		engineVersion: "0",
		dependencyGraphVersion: "0",
		environmentHash: "0",
		files: {
			[FILE]: {
				"sym-1": {
					symbolId: "sym-1",
					qualifiedName: "f",
					symbolHash: "h1",
					mutants,
					instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
				},
			},
		},
	};
}

describe("priorStatuses — positive (must fire)", () => {
	it("P1: returns each recorded mutant's prior status", () => {
		const prior = priorStatuses(manifestWith({ m1: "killed", m2: "uncovered" }), FILE);
		expect(prior.get("m1")).toBe("killed");
		expect(prior.get("m2")).toBe("uncovered");
	});
});

describe("priorStatuses — negative (must not fire)", () => {
	it("N1: an unmeasured file yields an empty map", () => {
		expect(priorStatuses(manifestWith({}), FILE).get("m1")).toBeUndefined();
	});
});

describe("re-exported read helpers stay behaviorally intact after extraction", () => {
	it("P2: acceptedSurvivors includes survived, excludes killed", () => {
		const accepted = acceptedSurvivors(manifestWith({ m1: "survived", m2: "killed" }), FILE);
		expect(accepted.has("m1")).toBe(true);
		expect(accepted.has("m2")).toBe(false);
	});

	it("P3: hasFileBaseline is true once records exist", () => {
		expect(hasFileBaseline(manifestWith({ m1: "killed" }), FILE)).toBe(true);
	});

	it("N2: computeNewSurvivors ignores an accepted survivor", () => {
		const out = computeNewSurvivors(
			[{ identity: identity("m1"), status: "survived" }],
			{ changed: new Set(["sym-1"]), accepted: new Set(["m1"]), quarantined: new Set() },
			"t1",
		);
		expect(out).toEqual([]);
	});
});
