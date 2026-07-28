import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { StructureConfig } from "../types.js";
import { evaluateStructureRules } from "./index.js";

function baseConfig(overrides: Partial<StructureConfig["builtins"]> = {}): StructureConfig {
	return {
		version: 1,
		mode: "minimal",
		artifacts: {},
		verify: {} as StructureConfig["verify"],
		posttooluse: {} as StructureConfig["posttooluse"],
		adoption: {} as StructureConfig["adoption"],
		builtins: {
			public_symbol_companions: false,
			env_key_companions: false,
			config_key_companions: false,
			layer_boundary_violations: false,
			package_boundary_violations: false,
			glossary_residue: false,
			...overrides,
		},
	};
}

describe("evaluateStructureRules", () => {
	it("returns empty when no built-ins are enabled", () => {
		const g = new ArtifactGraph();
		expect(evaluateStructureRules(g, baseConfig(), [])).toEqual([]);
	});

	it("runs public_symbol_companions when enabled + finds expected issue", () => {
		const g = new ArtifactGraph();
		const sym = {
			id: makeGlobalRef("public_symbol", "foo"),
			kind: "public_symbol" as const,
			label: "foo",
			file: "src/foo.ts",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		const doc = {
			id: makeGlobalRef("doc", "foo"),
			kind: "doc" as const,
			label: "foo",
			file: "docs/foo.md",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(sym.id, doc.id),
			kind: "documents",
			from: sym.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		const findings = evaluateStructureRules(g, baseConfig({ public_symbol_companions: true }), [
			"src/foo.ts",
		]);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).name).toBe("public_symbol_companion_untouched");
	});

	it("accepts the single-argument context form as well as positional args", () => {
		const g = new ArtifactGraph();
		expect(
			evaluateStructureRules({
				graph: g,
				config: baseConfig(),
				changedFiles: [],
			}),
		).toEqual([]);
	});
});
