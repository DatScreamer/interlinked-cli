import { describe, expect, it } from "vitest";
import { calculateAdoption } from "./adoption.js";
import { ArtifactGraph, makeGlobalRef } from "./artifact-graph.js";
import type { ArtifactNode } from "./types.js";

function node(
	kind: ArtifactNode["kind"],
	id: string,
	provenance: "extracted" | "declared" | "inferred",
): ArtifactNode {
	return {
		id: makeGlobalRef(kind, id),
		kind,
		label: id,
		file: `${id}.ts`,
		provenance,
		determinism_ceiling: "fully_deterministic",
	};
}

describe("calculateAdoption", () => {
	it("returns 1.0 for every category on an empty graph", () => {
		const g = new ArtifactGraph();
		const a = calculateAdoption(g, null);
		expect(a.public_api).toBe(1.0);
		expect(a.env).toBe(1.0);
		expect(a.config).toBe(1.0);
	});

	it("returns 0.0 when artifacts exist but none are declared", () => {
		const g = new ArtifactGraph();
		g.addNode(node("public_symbol", "foo", "extracted"));
		g.addNode(node("public_symbol", "bar", "extracted"));
		const a = calculateAdoption(g, null);
		expect(a.public_api).toBe(0);
	});

	it("returns the ratio declared/extracted", () => {
		const g = new ArtifactGraph();
		g.addNode(node("public_symbol", "foo", "extracted"));
		g.addNode(node("public_symbol", "bar", "extracted"));
		g.addNode(node("public_symbol", "foo-dec", "declared"));
		const a = calculateAdoption(g, null);
		expect(a.public_api).toBe(0.5);
	});

	it("clamps values into [0, 1]", () => {
		const g = new ArtifactGraph();
		g.addNode(node("public_symbol", "a", "extracted"));
		// More declared than extracted — ratio would be 2.0, clamp to 1.0.
		g.addNode(node("public_symbol", "b", "declared"));
		g.addNode(node("public_symbol", "c", "declared"));
		const a = calculateAdoption(g, null);
		expect(a.public_api).toBeGreaterThanOrEqual(0);
		expect(a.public_api).toBeLessThanOrEqual(1);
	});

	it("glossary / layers use presence ratio (1.0 when declared, else 0)", () => {
		const g = new ArtifactGraph();
		g.addNode(node("term", "Workspace", "declared"));
		const a = calculateAdoption(g, null);
		expect(a.glossary).toBe(1);
		expect(a.layers).toBe(0);
	});

	it("packages category uses the same ratio logic", () => {
		const g = new ArtifactGraph();
		g.addNode(node("package", "a", "extracted"));
		g.addNode(node("package", "a-dec", "declared"));
		expect(calculateAdoption(g, null).packages).toBe(1);
	});
});
