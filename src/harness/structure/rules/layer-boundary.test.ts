import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "../types.js";
import { checkLayerBoundaryViolations } from "./layer-boundary.js";
import { nonNull } from "../../../lib/non-null.js";

function moduleNode(id: string, file: string): ArtifactNode {
	return {
		id: makeGlobalRef("module", id),
		kind: "module",
		label: id,
		file,
		provenance: "extracted",
		determinism_ceiling: "partially_deterministic",
	};
}

function layerNode(id: string): ArtifactNode {
	return {
		id: makeGlobalRef("layer", id),
		kind: "layer",
		label: id,
		file: ".",
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
	};
}

function edge(from: string, to: string, kind: "imports" | "belongs_to_layer"): ArtifactEdge {
	return {
		id: makeEdgeId(from, to),
		kind,
		from,
		to,
		provenance: "extracted",
		confidence: 0.9,
	};
}

describe("checkLayerBoundaryViolations", () => {
	it("returns empty when no layerRules are declared", () => {
		const g = new ArtifactGraph();
		expect(checkLayerBoundaryViolations(g, [])).toEqual([]);
	});

	it("flags an import that crosses a forbidden layer boundary", () => {
		const g = new ArtifactGraph();
		const uiLayer = layerNode("ui");
		const dbLayer = layerNode("db");
		const uiMod = moduleNode("ui-file", "src/ui/a.ts");
		const dbMod = moduleNode("db-file", "src/db/b.ts");
		for (const n of [uiLayer, dbLayer, uiMod, dbMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, uiLayer.id, "belongs_to_layer"));
		g.addEdge(edge(dbMod.id, dbLayer.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, dbMod.id, "imports"));

		const findings = checkLayerBoundaryViolations(g, [
			{ from: uiLayer.id, cannot_import: [dbLayer.id] },
		]);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("layer_boundary_violation");
		expect(nonNull(findings[0]).affected_files).toEqual(["src/db/b.ts"]);
	});

	it("does not flag an import when no forbidden relationship matches", () => {
		const g = new ArtifactGraph();
		const uiLayer = layerNode("ui");
		const libLayer = layerNode("lib");
		const uiMod = moduleNode("ui-file", "src/ui/a.ts");
		const libMod = moduleNode("lib-file", "src/lib/b.ts");
		for (const n of [uiLayer, libLayer, uiMod, libMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, uiLayer.id, "belongs_to_layer"));
		g.addEdge(edge(libMod.id, libLayer.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, libMod.id, "imports"));

		const findings = checkLayerBoundaryViolations(g, [
			{ from: uiLayer.id, cannot_import: [makeGlobalRef("layer", "db")] },
		]);
		expect(findings).toEqual([]);
	});
});
