// ===========================================
// Reconciliation — explicit severity predicates
// ===========================================
// The reviewer's call: aggregate score is telemetry only. Load-bearing
// decisions come from explicit predicates:
//   - risk underestimated (med→high or low→high)
//   - direct count off by more than one bucket class with prediction <= 3
//     and oracle >= 10
//   - imported_by recall < 0.3 with oracle >= 5 importers
//   - callers recall < 0.3 with oracle >= 5 callers
//   - domains recall < 0.5 with oracle >= 3 domains
// Plus: full abstention against an oracle reporting high impact requires
// acknowledgment.

import { describe, expect, it } from "vitest";
import type { PerSectionScore } from "../graph-prediction-cache.js";
import type { ParsedGraphPrediction } from "../graph-prediction-parser.js";
import {
	type ReconcileInputs,
	reconcile,
	type SeverityResult,
} from "../graph-prediction-reconcile.js";
import type { SupermodelGraph } from "../supermodel-graph.js";

function oracle(overrides: Partial<SupermodelGraph> = {}): SupermodelGraph {
	return {
		shardPath: "/abs/foo.graph.ts",
		sourcePath: "/abs/foo.ts",
		impact: {
			risk: "MEDIUM",
			domains: ["Server"],
			direct: 5,
			transitive: 12,
			affects: ["src/index.ts"],
		},
		deps: {
			imports: ["node:net", "./evaluator"],
			importedBy: ["src/index.ts"],
		},
		calls: {
			callers: [{ fn: "main", caller: "init", file: "cmd/foo.ts", line: 10 }],
			callees: [
				{ fn: "evaluatePostToolUse", callee: "fileExists", file: "src/foo.ts", line: 50 },
			],
		},
		...overrides,
	};
}

function pred(overrides: Partial<ParsedGraphPrediction> = {}): ParsedGraphPrediction {
	return {
		file: "src/foo.ts",
		deps: { imports: ["node:net"], imported_by: ["src/index.ts"] },
		calls: { callers: ["main ← init"], callees: [] },
		impact: {
			risk: "medium",
			domains: ["Server"],
			direct: 5,
			transitive: 12,
			affects: ["src/index.ts"],
		},
		parse_status: "ok",
		...overrides,
	};
}

const baseInputs = (overrides: Partial<ReconcileInputs> = {}): ReconcileInputs => ({
	prediction: pred(),
	oracle: oracle(),
	...overrides,
});

describe("reconcile — risk severity predicates", () => {
	it("flags HIGH severity when predicted low and actual is HIGH", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: { risk: "low", domains: [], direct: 1, transitive: 1, affects: [] },
				}),
				oracle: oracle({
					impact: {
						risk: "HIGH",
						domains: ["X"],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
			}),
		);
		expect(r.severity).toBe("high");
		expect(r.triggers).toContain("risk_underestimated_low_to_high");
	});

	it("flags HIGH severity when predicted medium and actual is HIGH", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: {
						risk: "medium",
						domains: ["X"],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
				oracle: oracle({
					impact: {
						risk: "HIGH",
						domains: ["X"],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
			}),
		);
		expect(r.severity).toBe("high");
		expect(r.triggers).toContain("risk_underestimated_medium_to_high");
	});

	it("does NOT flag HIGH when predicted high and actual is high (correct)", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: { risk: "high", domains: ["X"], direct: 1, transitive: 1, affects: [] },
				}),
				oracle: oracle({
					impact: {
						risk: "HIGH",
						domains: ["X"],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
			}),
		);
		expect(r.severity).not.toBe("high");
	});
});

describe("reconcile — direct count severity predicate", () => {
	it("flags HIGH when predicted direct ≤ 3 and oracle direct ≥ 10", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: {
						risk: "low",
						domains: [],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
				oracle: oracle({
					impact: {
						risk: "MEDIUM",
						domains: [],
						direct: 12,
						transitive: 50,
						affects: [],
					},
				}),
			}),
		);
		expect(r.severity).toBe("high");
		expect(r.triggers).toContain("direct_count_underestimated");
	});

	it("does NOT flag HIGH when predicted direct = 4 (above threshold)", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: {
						risk: "medium",
						domains: ["X"],
						direct: 4,
						transitive: 12,
						affects: ["src/index.ts"],
					},
				}),
				oracle: oracle({
					impact: {
						risk: "MEDIUM",
						domains: ["X"],
						direct: 12,
						transitive: 50,
						affects: ["src/index.ts"],
					},
				}),
			}),
		);
		expect(r.triggers).not.toContain("direct_count_underestimated");
	});
});

describe("reconcile — recall-based predicates (imported_by, callers, domains)", () => {
	it("flags HIGH when imported_by recall < 0.3 and oracle has ≥ 5 importers", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: [], imported_by: ["a.ts"] },
				}),
				oracle: oracle({
					deps: {
						imports: [],
						importedBy: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"],
					},
				}),
			}),
		);
		expect(r.severity).toBe("high");
		expect(r.triggers).toContain("imported_by_recall_low");
	});

	it("does NOT flag HIGH when oracle has only 3 importers (under threshold)", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: [], imported_by: [] },
				}),
				oracle: oracle({
					deps: { imports: [], importedBy: ["a.ts", "b.ts", "c.ts"] },
				}),
			}),
		);
		expect(r.triggers).not.toContain("imported_by_recall_low");
	});

	it("flags HIGH when callers recall < 0.3 and oracle has ≥ 5 callers", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					calls: { callers: ["a ← b"], callees: [] },
				}),
				oracle: oracle({
					calls: {
						callers: Array.from({ length: 7 }, (_, i) => ({
							fn: `f${i}`,
							caller: `c${i}`,
							file: "x",
							line: 1,
						})),
						callees: [],
					},
				}),
			}),
		);
		expect(r.severity).toBe("high");
		expect(r.triggers).toContain("callers_recall_low");
	});

	it("flags HIGH when domains recall < 0.5 and oracle has ≥ 3 domains", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: {
						risk: "medium",
						domains: ["A"],
						direct: 5,
						transitive: 12,
						affects: ["src/index.ts"],
					},
				}),
				oracle: oracle({
					impact: {
						risk: "MEDIUM",
						domains: ["A", "B", "C", "D"],
						direct: 5,
						transitive: 12,
						affects: ["src/index.ts"],
					},
				}),
			}),
		);
		expect(r.severity).toBe("high");
		expect(r.triggers).toContain("domains_recall_low");
	});
});

describe("reconcile — full abstention", () => {
	it("flags severity full_abstention when all sections are unknown", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: "unknown", imported_by: "unknown" },
					calls: { callers: "unknown", callees: "unknown" },
					impact: {
						risk: "unknown",
						domains: "unknown",
						direct: "unknown",
						transitive: "unknown",
						affects: "unknown",
					},
				}),
			}),
		);
		expect(r.severity).toBe("full_abstention");
	});

	it("requires ack when full abstention AND oracle reports high-impact (HIGH risk)", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: "unknown", imported_by: "unknown" },
					calls: { callers: "unknown", callees: "unknown" },
					impact: {
						risk: "unknown",
						domains: "unknown",
						direct: "unknown",
						transitive: "unknown",
						affects: "unknown",
					},
				}),
				oracle: oracle({
					impact: {
						risk: "HIGH",
						domains: ["X"],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
			}),
		);
		expect(r.high_impact_oracle).toBe(true);
		expect(r.decision).toBe("ack_required");
		expect(r.triggers).toContain("full_abstention_against_high_impact");
	});

	it("requires ack when full abstention AND oracle has direct ≥ 10", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: "unknown", imported_by: "unknown" },
					calls: { callers: "unknown", callees: "unknown" },
					impact: {
						risk: "unknown",
						domains: "unknown",
						direct: "unknown",
						transitive: "unknown",
						affects: "unknown",
					},
				}),
				oracle: oracle({
					impact: {
						risk: "MEDIUM",
						domains: ["X"],
						direct: 15,
						transitive: 30,
						affects: [],
					},
				}),
			}),
		);
		expect(r.high_impact_oracle).toBe(true);
		expect(r.decision).toBe("ack_required");
	});

	it("does NOT require ack on full abstention against low-impact oracle", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: "unknown", imported_by: "unknown" },
					calls: { callers: "unknown", callees: "unknown" },
					impact: {
						risk: "unknown",
						domains: "unknown",
						direct: "unknown",
						transitive: "unknown",
						affects: "unknown",
					},
				}),
				oracle: oracle({
					impact: {
						risk: "LOW",
						domains: ["X"],
						direct: 1,
						transitive: 2,
						affects: [],
					},
				}),
			}),
		);
		expect(r.high_impact_oracle).toBe(false);
		expect(r.decision).toBe("reveal_and_allow");
	});
});

describe("reconcile — telemetry (weighted_avg) is non-load-bearing", () => {
	it("low weighted_avg alone does NOT trigger ack when no severity predicate fires", () => {
		// Predicted matches oracle on each predicate but we artificially
		// drag the average down by abstaining everywhere except matching
		// risk + matching direct. The aggregate score is low; severity
		// triggers don't fire; decision is reveal_and_allow.
		const r = reconcile(
			baseInputs({
				prediction: pred({
					deps: { imports: "unknown", imported_by: "unknown" },
					calls: { callers: "unknown", callees: "unknown" },
					impact: {
						risk: "medium",
						domains: ["Server"],
						direct: 5,
						transitive: 12,
						affects: ["src/index.ts"],
					},
				}),
			}),
		);
		expect(r.severity).not.toBe("high");
		expect(r.decision).toBe("reveal_and_allow");
	});

	it("populates per_section_score and weighted_avg (telemetry fields)", () => {
		const r = reconcile(baseInputs());
		expect(r.weighted_avg).toBeGreaterThanOrEqual(0);
		expect(r.weighted_avg).toBeLessThanOrEqual(1);
		expect(Object.keys(r.per_section_score).length).toBeGreaterThan(0);
	});
});

describe("reconcile — bucket-tolerance scoring on counts", () => {
	it("counts in same bucket score 0.7 (per design §7.2)", () => {
		// Both predicted and oracle in bucket "10+"
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: {
						risk: "medium",
						domains: ["Server"],
						direct: 15,
						transitive: 80,
						affects: ["src/index.ts"],
					},
				}),
				oracle: oracle({
					impact: {
						risk: "MEDIUM",
						domains: ["Server"],
						direct: 25,
						transitive: 100,
						affects: ["src/index.ts"],
					},
				}),
			}),
		);
		expect(r.per_section_score["impact.direct"]).toBeCloseTo(0.7, 2);
		expect(r.per_section_score["impact.transitive"]).toBeCloseTo(0.7, 2);
	});

	it("exact equality scores 1.0 on counts", () => {
		const r = reconcile(baseInputs()); // pred and oracle both direct=5, transitive=12
		expect(r.per_section_score["impact.direct"]).toBeCloseTo(1.0, 2);
		expect(r.per_section_score["impact.transitive"]).toBeCloseTo(1.0, 2);
	});

	it("unknown (abstention) on counts scores 0.5", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: {
						risk: "medium",
						domains: ["Server"],
						direct: "unknown",
						transitive: "unknown",
						affects: ["src/index.ts"],
					},
				}),
			}),
		);
		expect(r.per_section_score["impact.direct"]).toBeCloseTo(0.5, 2);
		expect(r.per_section_score["impact.transitive"]).toBeCloseTo(0.5, 2);
	});
});

describe("reconcile — decision matrix", () => {
	it("decision = reveal_and_allow when no triggers fire and not full abstention", () => {
		const r = reconcile(baseInputs());
		expect(r.decision).toBe("reveal_and_allow");
	});

	it("decision = ack_required when any high-severity trigger fires", () => {
		const r = reconcile(
			baseInputs({
				prediction: pred({
					impact: { risk: "low", domains: [], direct: 1, transitive: 1, affects: [] },
				}),
				oracle: oracle({
					impact: {
						risk: "HIGH",
						domains: ["X"],
						direct: 1,
						transitive: 1,
						affects: [],
					},
				}),
			}),
		);
		expect(r.decision).toBe("ack_required");
	});
});

describe("reconcile — return type contract", () => {
	it("returns severity, decision, triggers, per_section_score, weighted_avg, miss_set", () => {
		const r: SeverityResult = reconcile(baseInputs());
		expect(["low", "medium", "high", "full_abstention"]).toContain(r.severity);
		expect(["reveal_and_allow", "ack_required"]).toContain(r.decision);
		expect(Array.isArray(r.triggers)).toBe(true);
		expect(typeof r.per_section_score).toBe("object");
		expect(typeof r.weighted_avg).toBe("number");
		expect(typeof r.high_impact_oracle).toBe("boolean");
		expect(typeof r.miss_set).toBe("object");
	});
});

describe("reconcile — unavailable sections (internal / thin oracle)", () => {
	// The internal regex graph cannot answer call edges, domains, or a real
	// transitive count. Those sections are marked unavailable so the
	// reconciler EXCLUDES them rather than scoring an unanswerable section as
	// empty-set — which would reward shared blindness and penalize seeing past
	// the oracle. Mirrors dependency-view's INTERNAL_UNAVAILABLE.
	const INTERNAL_UNAVAILABLE: ReadonlySet<keyof PerSectionScore> = new Set([
		"calls.callers",
		"calls.callees",
		"impact.domains",
		"impact.transitive",
	]);

	// An internal-graph-shaped oracle: no call edges, no domains, transitive
	// equals direct.
	const internalOracle = (): SupermodelGraph =>
		oracle({
			calls: null,
			impact: { risk: "MEDIUM", domains: [], direct: 5, transitive: 5, affects: ["src/index.ts"] },
		});

	it("excludes unanswerable sections from per_section_score entirely", () => {
		const r = reconcile({
			prediction: pred(),
			oracle: internalOracle(),
			unavailable: INTERNAL_UNAVAILABLE,
		});
		expect(r.per_section_score["calls.callers"]).toBeUndefined();
		expect(r.per_section_score["calls.callees"]).toBeUndefined();
		expect(r.per_section_score["impact.domains"]).toBeUndefined();
		expect(r.per_section_score["impact.transitive"]).toBeUndefined();
		// Answerable sections are still scored.
		expect(r.per_section_score["deps.imported_by"]).toBeDefined();
		expect(r.per_section_score["impact.direct"]).toBeDefined();
		expect(r.per_section_score["impact.risk"]).toBeDefined();
	});

	it("does NOT penalize an agent for predicting callers the oracle cannot see", () => {
		// Confidently names real callers; the internal oracle has none. Without
		// the exclusion this scores precision 0 → 0.0 and could drag severity.
		const r = reconcile({
			prediction: pred({ calls: { callers: ["foo ← bar", "baz ← qux"], callees: [] } }),
			oracle: internalOracle(),
			unavailable: INTERNAL_UNAVAILABLE,
		});
		expect(r.per_section_score["calls.callers"]).toBeUndefined();
		expect(r.triggers).not.toContain("callers_recall_low");
	});

	it("does NOT reward an agent for sharing the oracle's blindness", () => {
		// Predicts no callers; the internal oracle also has none. Without the
		// exclusion, empty-vs-empty scores a free 1.0.
		const r = reconcile({
			prediction: pred({ calls: { callers: [], callees: [] } }),
			oracle: internalOracle(),
			unavailable: INTERNAL_UNAVAILABLE,
		});
		expect(r.per_section_score["calls.callers"]).toBeUndefined();
	});

	it("still scores call/domain sections when the oracle CAN answer them", () => {
		// No `unavailable` set → full Supermodel-shard behaviour, unchanged.
		const r = reconcile(baseInputs());
		expect(r.per_section_score["calls.callers"]).toBeDefined();
		expect(r.per_section_score["impact.domains"]).toBeDefined();
	});

	it("still flags a hub the agent underestimated, using only answerable sections", () => {
		// The coarse danger signal survives on a thin oracle: risk is derived
		// from fan-in, which the regex graph knows. Agent says LOW; hub is HIGH.
		const r = reconcile({
			prediction: pred({
				impact: { risk: "low", domains: [], direct: 1, transitive: 1, affects: [] },
			}),
			oracle: oracle({
				calls: null,
				impact: { risk: "HIGH", domains: [], direct: 8, transitive: 8, affects: [] },
			}),
			unavailable: INTERNAL_UNAVAILABLE,
		});
		expect(r.triggers).toContain("risk_underestimated_low_to_high");
		expect(r.severity).toBe("high");
	});
});
