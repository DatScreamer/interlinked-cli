// Mutation-directed tests for src/harness/graph-prediction-reconcile.ts.
//
// reconcile() is the ONLY exported symbol from the target module; every
// internal helper (calleeSetFromOracle, collectSeverityTriggers,
// computeFullAbstention, classifySeverity, isHighImpactOracle, recordSection,
// scoreListSections, scoreScalarSections) is unexported and is exercised
// exclusively through reconcile()'s observable SeverityResult fields
// (per_section_score / miss_set / triggers / severity / decision /
// high_impact_oracle / weighted_avg). Every fixture below was cross-checked
// against the pristine build before being pinned as an assertion (see
// scratch/gpr-fixture-probe.mts).
//
// unavailableExcept(...) isolates ONE section's scoring so a boundary value
// chosen for that section can't be diluted by the other 8 sections' scores
// inside weighted_avg.

import { describe, expect, it } from "vitest";
import type { PerSectionScore } from "./graph-prediction-cache.js";
import type { ParsedGraphPrediction } from "./graph-prediction-parser.js";
import { reconcile } from "./graph-prediction-reconcile.js";
import type { SupermodelGraph } from "./supermodel-graph.js";

const ALL_SECTION_KEYS: Array<keyof PerSectionScore> = [
	"deps.imports",
	"deps.imported_by",
	"calls.callers",
	"calls.callees",
	"impact.risk",
	"impact.domains",
	"impact.direct",
	"impact.transitive",
	"impact.affects",
];

function unavailableExcept(...keep: Array<keyof PerSectionScore>): Set<keyof PerSectionScore> {
	return new Set(ALL_SECTION_KEYS.filter((k) => !keep.includes(k)));
}

function makePrediction(overrides: Partial<ParsedGraphPrediction> = {}): ParsedGraphPrediction {
	return {
		file: "src/example.ts",
		deps: { imports: [], imported_by: [] },
		calls: { callers: [], callees: [] },
		impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] },
		parse_status: "ok",
		...overrides,
	};
}

function makeOracle(overrides: Partial<SupermodelGraph> = {}): SupermodelGraph {
	return {
		shardPath: "/shard",
		sourcePath: "/source.ts",
		impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: [] },
		calls: { callers: [], callees: [] },
		deps: { imports: [], importedBy: [] },
		...overrides,
	};
}

describe("reconcile — calleeSetFromOracle / callerSetFromOracle", () => {
	// test-contract: invariant — a real oracle call edge formats to "fn → callee" and scores 1.0 against a matching prediction
	it("formats a real oracle callee edge and scores an exact prediction match as 1.0", () => {
		const prediction = makePrediction({ calls: { callers: [], callees: ["F → G"] } });
		const oracle = makeOracle({
			calls: { callers: [], callees: [{ fn: "F", callee: "G", file: "f.ts", line: 3 }] },
		});
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("calls.callees") });
		expect(r.per_section_score["calls.callees"]).toBe(1);
		expect(r.miss_set["calls.callees"]).toBeUndefined();
	});

	// test-contract: invariant — a real oracle caller edge formats to "fn ← caller" and scores 1.0 against a matching prediction
	it("formats a real oracle caller edge and scores an exact prediction match as 1.0", () => {
		const prediction = makePrediction({ calls: { callers: ["F ← C"], callees: [] } });
		const oracle = makeOracle({
			calls: { callers: [{ fn: "F", caller: "C", file: "f.ts", line: 1 }], callees: [] },
		});
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("calls.callers") });
		expect(r.per_section_score["calls.callers"]).toBe(1);
	});

	// test-contract: boundary — oracle.calls entirely absent maps both caller and callee sets to [], matching an explicit-empty prediction
	it("maps an absent oracle.calls to empty caller and callee sets", () => {
		const prediction = makePrediction({ calls: { callers: [], callees: [] } });
		const oracle = makeOracle({ calls: null });
		const r = reconcile({
			prediction,
			oracle,
			unavailable: unavailableExcept("calls.callers", "calls.callees"),
		});
		expect(r.per_section_score["calls.callers"]).toBe(1);
		expect(r.per_section_score["calls.callees"]).toBe(1);
	});
});

describe("reconcile — classifySeverity thresholding", () => {
	// test-contract: boundary — weighted_avg exactly at MEDIUM_SEVERITY_AVG_FLOOR (0.6) is NOT "medium" (< is strict)
	it("classifies weighted_avg exactly 0.6 as low, not medium", () => {
		const prediction = makePrediction({
			impact: { risk: "low", domains: [], direct: 2, transitive: "unknown", affects: [] },
		});
		const oracle = makeOracle({
			impact: { risk: "LOW", domains: [], direct: 3, transitive: 5, affects: [] },
		});
		const r = reconcile({
			prediction,
			oracle,
			unavailable: unavailableExcept("impact.direct", "impact.transitive"),
		});
		expect(r.weighted_avg).toBe(0.6);
		expect(r.triggers).toEqual([]);
		expect(r.severity).toBe("low");
	});

	// test-contract: boundary — weighted_avg strictly below the floor (0.5) classifies as "medium"
	it("classifies weighted_avg 0.5 as medium", () => {
		const prediction = makePrediction({
			impact: { risk: "low", domains: [], direct: "unknown", transitive: "unknown", affects: [] },
		});
		const oracle = makeOracle({
			impact: { risk: "LOW", domains: [], direct: 3, transitive: 5, affects: [] },
		});
		const r = reconcile({
			prediction,
			oracle,
			unavailable: unavailableExcept("impact.direct", "impact.transitive"),
		});
		expect(r.weighted_avg).toBe(0.5);
		expect(r.severity).toBe("medium");
	});
});

describe("reconcile — collectSeverityTriggers: direct_count_underestimated", () => {
	// test-contract: boundary — predictedDirect exactly at DIRECT_PRED_MAX_FOR_TRIGGER (3) still counts as "underestimated"
	it("fires direct_count_underestimated when predictedDirect is exactly 3 and oracleDirect is far above the floor", () => {
		const prediction = makePrediction({
			impact: { risk: "low", domains: [], direct: 3, transitive: 0, affects: [] },
		});
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 15, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual(["direct_count_underestimated"]);
	});

	// test-contract: boundary — oracleDirect exactly at DIRECT_ORACLE_MIN_FOR_TRIGGER (10) still counts as "the oracle has enough"
	it("fires direct_count_underestimated when oracleDirect is exactly 10", () => {
		const prediction = makePrediction({
			impact: { risk: "low", domains: [], direct: 1, transitive: 0, affects: [] },
		});
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 10, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual(["direct_count_underestimated"]);
	});
});

describe("reconcile — collectSeverityTriggers: imported_by_recall_low", () => {
	// test-contract: invariant — an unavailable deps.imported_by section never fires the recall trigger, even with a high oracle count
	it("does not fire imported_by_recall_low when the section is marked unavailable", () => {
		const prediction = makePrediction();
		const oracle = makeOracle({ deps: { imports: [], importedBy: ["i1", "i2", "i3", "i4", "i5"] } });
		const r = reconcile({ prediction, oracle, unavailable: new Set(["deps.imported_by"]) });
		expect(r.triggers).toEqual([]);
	});

	// test-contract: invariant — a full-recall (1.0) imported_by prediction never fires the low-recall trigger
	it("does not fire imported_by_recall_low when predicted imports match the oracle exactly", () => {
		const importers = ["i1", "i2", "i3", "i4", "i5"];
		const prediction = makePrediction({ deps: { imports: [], imported_by: importers } });
		const oracle = makeOracle({ deps: { imports: [], importedBy: importers } });
		const r = reconcile({ prediction, oracle });
		expect(r.per_section_score["deps.imported_by"]).toBe(1);
		expect(r.triggers).toEqual([]);
	});

	// test-contract: boundary — recall exactly at IMPORTED_BY_RECALL_FLOOR (0.3) does NOT fire (< is strict)
	it("does not fire imported_by_recall_low when recall is exactly 0.3", () => {
		const oracleImporters = ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10"];
		const predicted = oracleImporters.slice(0, 3);
		const prediction = makePrediction({ deps: { imports: [], imported_by: predicted } });
		const oracle = makeOracle({ deps: { imports: [], importedBy: oracleImporters } });
		const r = reconcile({ prediction, oracle });
		expect(r.per_section_score["deps.imported_by"]).toBe(0.3);
		expect(r.triggers).toEqual([]);
	});

	// test-contract: boundary — oracleImporters.length exactly at IMPORTED_BY_ORACLE_MIN (5) still counts as "enough"
	it("fires imported_by_recall_low when the oracle has exactly 5 importers and recall is 0", () => {
		const oracleImporters = ["i1", "i2", "i3", "i4", "i5"];
		const prediction = makePrediction({ deps: { imports: [], imported_by: [] } });
		const oracle = makeOracle({ deps: { imports: [], importedBy: oracleImporters } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual(["imported_by_recall_low"]);
	});
});

describe("reconcile — collectSeverityTriggers: callers_recall_low", () => {
	function callerRecords(n: number) {
		return Array.from({ length: n }, (_, i) => ({ fn: "f", caller: `c${i}`, file: "x.ts", line: i }));
	}

	// test-contract: invariant — an unavailable calls.callers section never fires the recall trigger
	it("does not fire callers_recall_low when the section is marked unavailable", () => {
		const prediction = makePrediction();
		const oracle = makeOracle({ calls: { callers: callerRecords(5), callees: [] } });
		const r = reconcile({ prediction, oracle, unavailable: new Set(["calls.callers"]) });
		expect(r.triggers).toEqual([]);
	});

	// test-contract: invariant — a full-recall (1.0) callers prediction never fires the low-recall trigger
	it("does not fire callers_recall_low when predicted callers match the oracle exactly", () => {
		const records = callerRecords(5);
		const predicted = records.map((c) => `${c.fn} ← ${c.caller}`);
		const prediction = makePrediction({ calls: { callers: predicted, callees: [] } });
		const oracle = makeOracle({ calls: { callers: records, callees: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual([]);
	});

	// test-contract: boundary — recall exactly at CALLERS_RECALL_FLOOR (0.3) does NOT fire (< is strict)
	it("does not fire callers_recall_low when recall is exactly 0.3", () => {
		const records = callerRecords(10);
		const predicted = records.slice(0, 3).map((c) => `${c.fn} ← ${c.caller}`);
		const prediction = makePrediction({ calls: { callers: predicted, callees: [] } });
		const oracle = makeOracle({ calls: { callers: records, callees: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.per_section_score["calls.callers"]).toBe(0.3);
		expect(r.triggers).toEqual([]);
	});

	// test-contract: boundary — oracleCallers.length exactly at CALLERS_ORACLE_MIN (5) still counts as "enough"
	it("fires callers_recall_low when the oracle has exactly 5 callers and recall is 0", () => {
		const records = callerRecords(5);
		const prediction = makePrediction({ calls: { callers: [], callees: [] } });
		const oracle = makeOracle({ calls: { callers: records, callees: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual(["callers_recall_low"]);
	});
});

describe("reconcile — collectSeverityTriggers: domains_recall_low", () => {
	// test-contract: invariant — an unavailable impact.domains section never fires the recall trigger
	it("does not fire domains_recall_low when the section is marked unavailable", () => {
		const prediction = makePrediction();
		const oracle = makeOracle({ impact: { risk: "LOW", domains: ["d1", "d2", "d3"], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: new Set(["impact.domains"]) });
		expect(r.triggers).toEqual([]);
	});

	// test-contract: invariant — a full-recall (1.0) domains prediction never fires the low-recall trigger
	it("does not fire domains_recall_low when predicted domains match the oracle exactly", () => {
		const domains = ["d1", "d2", "d3"];
		const prediction = makePrediction({ impact: { risk: "low", domains, direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains, direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual([]);
	});

	// test-contract: boundary — recall exactly at DOMAINS_RECALL_FLOOR (0.5) does NOT fire (< is strict)
	it("does not fire domains_recall_low when recall is exactly 0.5", () => {
		const domains = ["d1", "d2", "d3", "d4"];
		const prediction = makePrediction({
			impact: { risk: "low", domains: domains.slice(0, 2), direct: 0, transitive: 0, affects: [] },
		});
		const oracle = makeOracle({ impact: { risk: "LOW", domains, direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.per_section_score["impact.domains"]).toBe(0.5);
		expect(r.triggers).toEqual([]);
	});

	// test-contract: boundary — oracleDomains.length exactly at DOMAINS_ORACLE_MIN (3) still counts as "enough"
	it("fires domains_recall_low when the oracle has exactly 3 domains and recall is 0", () => {
		const domains = ["d1", "d2", "d3"];
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains, direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.triggers).toEqual(["domains_recall_low"]);
	});
});

describe("reconcile — computeFullAbstention", () => {
	// test-contract: invariant — every prediction section entirely absent (undefined via optional chaining) is full abstention
	it("classifies a prediction with every section absent as full_abstention", () => {
		const prediction: ParsedGraphPrediction = {
			file: "x.ts",
			deps: null,
			calls: null,
			impact: null,
			parse_status: "ok",
		};
		const oracle: SupermodelGraph = { shardPath: "", sourcePath: "", impact: null, calls: null, deps: null };
		const r = reconcile({ prediction, oracle });
		expect(r.severity).toBe("full_abstention");
		expect(r.triggers).toEqual([]);
	});

	// test-contract: invariant — full abstention requires EVERY field abstained (AND semantics); one real field among nine breaks it
	it("does not classify as full_abstention when only one of nine fields is unknown", () => {
		const prediction = makePrediction({
			deps: { imports: ["a"], imported_by: ["b"] },
			calls: { callers: ["c"], callees: ["d"] },
			impact: { risk: "low", domains: ["e"], direct: 1, transitive: "unknown", affects: ["f"] },
		});
		const oracle = makeOracle({
			impact: { risk: "LOW", domains: [], direct: 1, transitive: 0, affects: [] },
			calls: null,
			deps: null,
		});
		const r = reconcile({ prediction, oracle, unavailable: new Set(ALL_SECTION_KEYS) });
		expect(r.weighted_avg).toBe(0);
		expect(r.triggers).toEqual([]);
		expect(r.severity).toBe("medium");
	});
});

describe("reconcile — isHighImpactOracle", () => {
	// test-contract: invariant — low risk, zero direct, zero transitive is definitively not high-impact
	it("is not high-impact when risk is LOW and direct/transitive are both 0", () => {
		const prediction = makePrediction();
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.high_impact_oracle).toBe(false);
	});

	// test-contract: boundary — direct exactly at HIGH_IMPACT_DIRECT_THRESHOLD (10) counts as high-impact
	it("is high-impact when oracle direct is exactly 10", () => {
		const prediction = makePrediction();
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 10, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.high_impact_oracle).toBe(true);
	});

	// test-contract: boundary — transitive exactly at HIGH_IMPACT_TRANSITIVE_THRESHOLD (50) counts as high-impact
	it("is high-impact when oracle transitive is exactly 50", () => {
		const prediction = makePrediction();
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 0, transitive: 50, affects: [] } });
		const r = reconcile({ prediction, oracle });
		expect(r.high_impact_oracle).toBe(true);
	});
});

describe("reconcile — weighted_avg zero-weight guard", () => {
	// test-contract: boundary — weightSum exactly 0 (every section unavailable) falls back to weighted_avg 0, never NaN from a 0/0 division
	it("reports weighted_avg 0, not NaN, when every section is unavailable", () => {
		const prediction = makePrediction();
		const oracle = makeOracle();
		const r = reconcile({ prediction, oracle, unavailable: new Set(ALL_SECTION_KEYS) });
		expect(r.weighted_avg).toBe(0);
	});
});

describe("reconcile — recordSection accumulation", () => {
	// test-contract: invariant — a section's weighted contribution is score * weight (impact.risk carries weight 2.0), not score / weight
	it("weights a perfect impact.risk match (weight 2.0) into weighted_avg 1.0", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.risk") });
		expect(r.weighted_avg).toBe(1);
		expect(r.per_section_score["impact.risk"]).toBe(1);
	});

	// test-contract: invariant — a null missDetail (perfect match) leaves the key absent from miss_set, never present-as-null
	it("leaves miss_set['impact.risk'] absent on a perfect risk match", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.risk") });
		expect(Object.prototype.hasOwnProperty.call(r.miss_set, "impact.risk")).toBe(false);
	});

	// test-contract: invariant — a real missDetail (risk mismatch) is recorded verbatim in miss_set under its section key
	it("records the exact missDetail object on a risk mismatch", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "MEDIUM", domains: [], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.risk") });
		expect(r.per_section_score["impact.risk"]).toBe(0);
		expect(r.miss_set["impact.risk"]).toEqual({ predicted: "low", oracle: "MEDIUM" });
	});
});

describe("reconcile — scoreListSections: section key routing", () => {
	// test-contract: invariant — a deps.imports score is recorded under the literal key "deps.imports"
	it("records a perfect deps.imports match under its own key", () => {
		const prediction = makePrediction({ deps: { imports: [], imported_by: [] } });
		const oracle = makeOracle({ deps: { imports: [], importedBy: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("deps.imports") });
		expect(r.per_section_score["deps.imports"]).toBe(1);
	});

	// test-contract: invariant — a calls.callees score is recorded under the literal key "calls.callees"
	it("records a perfect calls.callees match under its own key", () => {
		const prediction = makePrediction({ calls: { callers: [], callees: [] } });
		const oracle = makeOracle({ calls: { callers: [], callees: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("calls.callees") });
		expect(r.per_section_score["calls.callees"]).toBe(1);
	});

	// test-contract: invariant — an impact.affects score is recorded under the literal key "impact.affects"
	it("records a perfect impact.affects match under its own key", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.affects") });
		expect(r.per_section_score["impact.affects"]).toBe(1);
	});
});

describe("reconcile — scoreListSections: predicted ?? null fallback (abstained scoring)", () => {
	// test-contract: invariant — an absent deps section maps predicted to null (abstained, score 0.5 against a real oracle set), not undefined (score 0)
	it("scores an absent deps.imports prediction as abstained (0.5) against a real oracle set", () => {
		const prediction = makePrediction({ deps: null });
		const oracle = makeOracle({ deps: { imports: ["a", "b", "c", "d", "e"], importedBy: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("deps.imports") });
		expect(r.per_section_score["deps.imports"]).toBe(0.5);
	});

	// test-contract: invariant — an absent deps section maps predicted imported_by to null (abstained, 0.5), not undefined (0)
	it("scores an absent deps.imported_by prediction as abstained (0.5) against a real oracle set", () => {
		const prediction = makePrediction({ deps: null });
		const oracle = makeOracle({ deps: { imports: [], importedBy: ["a", "b", "c", "d", "e"] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("deps.imported_by") });
		expect(r.per_section_score["deps.imported_by"]).toBe(0.5);
	});

	// test-contract: invariant — an absent calls section maps predicted callers to null (abstained, 0.5), not undefined (0)
	it("scores an absent calls.callers prediction as abstained (0.5) against a real oracle set", () => {
		const prediction = makePrediction({ calls: null });
		const oracle = makeOracle({ calls: { callers: [{ fn: "f", caller: "c", file: "x", line: 1 }], callees: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("calls.callers") });
		expect(r.per_section_score["calls.callers"]).toBe(0.5);
	});

	// test-contract: invariant — an absent calls section maps predicted callees to null (abstained, 0.5), not undefined (0)
	it("scores an absent calls.callees prediction as abstained (0.5) against a real oracle set", () => {
		const prediction = makePrediction({ calls: null });
		const oracle = makeOracle({ calls: { callers: [], callees: [{ fn: "f", callee: "c", file: "x", line: 1 }] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("calls.callees") });
		expect(r.per_section_score["calls.callees"]).toBe(0.5);
	});

	// test-contract: invariant — an absent impact section maps predicted domains to null (abstained, 0.5), not undefined (0)
	it("scores an absent impact.domains prediction as abstained (0.5) against a real oracle set", () => {
		const prediction = makePrediction({ impact: null });
		const oracle = makeOracle({
			impact: { risk: "LOW", domains: ["a", "b", "c", "d", "e"], direct: 0, transitive: 0, affects: [] },
		});
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.domains") });
		expect(r.per_section_score["impact.domains"]).toBe(0.5);
	});

	// test-contract: invariant — an absent impact section maps predicted affects to null (abstained, 0.5), not undefined (0)
	it("scores an absent impact.affects prediction as abstained (0.5) against a real oracle set", () => {
		const prediction = makePrediction({ impact: null });
		const oracle = makeOracle({
			impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: ["a", "b", "c", "d", "e"] },
		});
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.affects") });
		expect(r.per_section_score["impact.affects"]).toBe(0.5);
	});
});

describe("reconcile — scoreListSections: oracleSet ?? [] fallback", () => {
	// test-contract: invariant — an absent oracle.deps falls back its imports set to [], scoring a matching empty prediction as 1.0
	it("scores a matching empty deps.imports prediction as 1.0 against an absent oracle.deps", () => {
		const prediction = makePrediction({ deps: { imports: [], imported_by: [] } });
		const oracle = makeOracle({ deps: null });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("deps.imports") });
		expect(r.per_section_score["deps.imports"]).toBe(1);
	});

	// test-contract: invariant — an absent oracle.deps falls back its importedBy set to [], scoring a matching empty prediction as 1.0
	it("scores a matching empty deps.imported_by prediction as 1.0 against an absent oracle.deps", () => {
		const prediction = makePrediction({ deps: { imports: [], imported_by: [] } });
		const oracle = makeOracle({ deps: null });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("deps.imported_by") });
		expect(r.per_section_score["deps.imported_by"]).toBe(1);
	});

	// test-contract: invariant — an absent oracle.impact falls back its domains set to [], scoring a matching empty prediction as 1.0
	it("scores a matching empty impact.domains prediction as 1.0 against an absent oracle.impact", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: null });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.domains") });
		expect(r.per_section_score["impact.domains"]).toBe(1);
	});

	// test-contract: invariant — an absent oracle.impact falls back its affects set to [], scoring a matching empty prediction as 1.0
	it("scores a matching empty impact.affects prediction as 1.0 against an absent oracle.impact", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: null });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.affects") });
		expect(r.per_section_score["impact.affects"]).toBe(1);
	});
});

describe("reconcile — scoreScalarSections: unavailable gating", () => {
	// test-contract: invariant — a section marked unavailable is never recorded into per_section_score, even when oracle.impact is present
	it("leaves per_section_score['impact.direct'] absent when the section is unavailable", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 5, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 5, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: new Set(["impact.direct"]) });
		expect(r.per_section_score["impact.direct"]).toBeUndefined();
	});

	// test-contract: invariant — a section marked unavailable is never recorded into per_section_score, even when oracle.impact is present
	it("leaves per_section_score['impact.risk'] absent when the section is unavailable", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 5, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 5, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: new Set(["impact.risk"]) });
		expect(r.per_section_score["impact.risk"]).toBeUndefined();
	});
});

describe("reconcile — scoreScalarSections: section key routing", () => {
	// test-contract: invariant — an impact.direct score is recorded under the literal key "impact.direct"
	it("records a perfect impact.direct match under its own key", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 7, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 7, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.direct") });
		expect(r.per_section_score["impact.direct"]).toBe(1);
	});

	// test-contract: invariant — an impact.risk score is recorded under the literal key "impact.risk"
	it("records a perfect impact.risk match under its own key", () => {
		const prediction = makePrediction({ impact: { risk: "low", domains: [], direct: 0, transitive: 0, affects: [] } });
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 0, transitive: 0, affects: [] } });
		const r = reconcile({ prediction, oracle, unavailable: unavailableExcept("impact.risk") });
		expect(r.per_section_score["impact.risk"]).toBe(1);
	});
});

describe("reconcile — scoreScalarSections: predicted ?? UNKNOWN_SENTINEL fallback", () => {
	// test-contract: invariant — an absent impact section maps predicted direct/transitive/risk to the "unknown" sentinel (score 0.5), never crashing and never scoring 0
	it("scores all three scalar sections as abstained (0.5) when prediction.impact is entirely absent", () => {
		const prediction: ParsedGraphPrediction = { file: "x", deps: null, calls: null, impact: null, parse_status: "ok" };
		const oracle = makeOracle({ impact: { risk: "LOW", domains: [], direct: 3, transitive: 7, affects: [] } });
		const unavailable = new Set<keyof PerSectionScore>([
			"deps.imports",
			"deps.imported_by",
			"calls.callers",
			"calls.callees",
			"impact.domains",
			"impact.affects",
		]);
		const r = reconcile({ prediction, oracle, unavailable });
		expect(r.per_section_score["impact.direct"]).toBe(0.5);
		expect(r.per_section_score["impact.transitive"]).toBe(0.5);
		expect(r.per_section_score["impact.risk"]).toBe(0.5);
	});
});
