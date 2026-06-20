import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "./artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "./types.js";

// -------------------------------------------
// Fixtures
// -------------------------------------------

function makeNode(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
	return {
		id: "public_symbol:pkg-index#createClient",
		kind: "public_symbol",
		label: "createClient",
		file: "src/index.ts",
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
		...overrides,
	};
}

function makeEdge(overrides: Partial<ArtifactEdge> = {}): ArtifactEdge {
	return {
		id: "edge:module:pkg-index->public_symbol:pkg-index#createClient",
		kind: "exports",
		from: "module:pkg-index",
		to: "public_symbol:pkg-index#createClient",
		provenance: "declared",
		confidence: 1.0,
		...overrides,
	};
}

// -------------------------------------------
// Helper tests
// -------------------------------------------

describe("makeGlobalRef", () => {
	it("formats kind:localId", () => {
		expect(makeGlobalRef("public_symbol", "pkg-index#createClient")).toBe(
			"public_symbol:pkg-index#createClient",
		);
	});

	it("works for different kinds", () => {
		expect(makeGlobalRef("module", "pkg-index")).toBe("module:pkg-index");
		expect(makeGlobalRef("env_key", "DATABASE_URL")).toBe("env_key:DATABASE_URL");
	});
});

describe("makeEdgeId", () => {
	it("formats edge:from->to", () => {
		expect(makeEdgeId("module:pkg-index", "public_symbol:pkg-index#createClient")).toBe(
			"edge:module:pkg-index->public_symbol:pkg-index#createClient",
		);
	});
});

// -------------------------------------------
// ArtifactGraph tests
// -------------------------------------------

describe("ArtifactGraph", () => {
	describe("addNode / getNode", () => {
		it("stores and retrieves a node by global ref", () => {
			const graph = new ArtifactGraph();
			const node = makeNode();
			graph.addNode(node);
			expect(graph.getNode(node.id)).toEqual(node);
		});

		it("returns undefined for missing node", () => {
			const graph = new ArtifactGraph();
			expect(graph.getNode("nonexistent")).toBeUndefined();
		});

		it("replaces a node with the same id", () => {
			const graph = new ArtifactGraph();
			const original = makeNode({ label: "v1" });
			const updated = makeNode({ label: "v2" });
			graph.addNode(original);
			graph.addNode(updated);
			expect(graph.getNode(original.id)?.label).toBe("v2");
			expect(graph.nodeCount).toBe(1);
		});
	});

	describe("addEdge", () => {
		it("stores an edge", () => {
			const graph = new ArtifactGraph();
			graph.addEdge(makeEdge());
			expect(graph.edgeCount).toBe(1);
		});

		it("deduplicates edges by id", () => {
			const graph = new ArtifactGraph();
			const edge = makeEdge();
			graph.addEdge(edge);
			graph.addEdge(edge);
			expect(graph.edgeCount).toBe(1);
		});
	});

	describe("getNodesByKind", () => {
		it("filters nodes by kind", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "public_symbol:a", kind: "public_symbol" }));
			graph.addNode(makeNode({ id: "module:b", kind: "module" }));
			graph.addNode(makeNode({ id: "public_symbol:c", kind: "public_symbol" }));

			const symbols = graph.getNodesByKind("public_symbol");
			expect(symbols).toHaveLength(2);
			expect(symbols.map((n) => n.id)).toEqual(["public_symbol:a", "public_symbol:c"]);
		});

		it("returns empty array when no matches", () => {
			const graph = new ArtifactGraph();
			expect(graph.getNodesByKind("env_key")).toEqual([]);
		});
	});

	describe("getNodesByFile", () => {
		it("filters nodes by file path", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "a", file: "src/a.ts" }));
			graph.addNode(makeNode({ id: "b", file: "src/b.ts" }));
			graph.addNode(makeNode({ id: "c", file: "src/a.ts" }));

			const result = graph.getNodesByFile("src/a.ts");
			expect(result).toHaveLength(2);
			expect(result.map((n) => n.id)).toEqual(["a", "c"]);
		});
	});

	describe("edge queries", () => {
		it("getEdgesFrom returns outgoing edges", () => {
			const graph = new ArtifactGraph();
			graph.addEdge(makeEdge({ id: "e1", from: "A", to: "B" }));
			graph.addEdge(makeEdge({ id: "e2", from: "A", to: "C" }));
			graph.addEdge(makeEdge({ id: "e3", from: "B", to: "C" }));

			expect(graph.getEdgesFrom("A")).toHaveLength(2);
			expect(graph.getEdgesFrom("B")).toHaveLength(1);
			expect(graph.getEdgesFrom("C")).toHaveLength(0);
		});

		it("getEdgesTo returns incoming edges", () => {
			const graph = new ArtifactGraph();
			graph.addEdge(makeEdge({ id: "e1", from: "A", to: "C" }));
			graph.addEdge(makeEdge({ id: "e2", from: "B", to: "C" }));
			graph.addEdge(makeEdge({ id: "e3", from: "A", to: "B" }));

			expect(graph.getEdgesTo("C")).toHaveLength(2);
			expect(graph.getEdgesTo("B")).toHaveLength(1);
			expect(graph.getEdgesTo("A")).toHaveLength(0);
		});

		it("getEdgesByKind filters edges", () => {
			const graph = new ArtifactGraph();
			graph.addEdge(makeEdge({ id: "e1", kind: "exports" }));
			graph.addEdge(makeEdge({ id: "e2", kind: "imports" }));
			graph.addEdge(makeEdge({ id: "e3", kind: "exports" }));

			expect(graph.getEdgesByKind("exports")).toHaveLength(2);
			expect(graph.getEdgesByKind("imports")).toHaveLength(1);
			expect(graph.getEdgesByKind("tests")).toHaveLength(0);
		});
	});

	describe("removeNodesByFile", () => {
		it("removes nodes and their connected edges", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "A", file: "src/a.ts" }));
			graph.addNode(makeNode({ id: "B", file: "src/b.ts" }));
			graph.addNode(makeNode({ id: "C", file: "src/a.ts" }));
			graph.addEdge(makeEdge({ id: "e1", from: "A", to: "B" }));
			graph.addEdge(makeEdge({ id: "e2", from: "B", to: "C" }));
			graph.addEdge(makeEdge({ id: "e3", from: "B", to: "B" }));

			graph.removeNodesByFile("src/a.ts");

			expect(graph.nodeCount).toBe(1);
			expect(graph.getNode("A")).toBeUndefined();
			expect(graph.getNode("C")).toBeUndefined();
			expect(graph.getNode("B")).toBeDefined();
			// e1 (from A) and e2 (to C) removed; e3 (B->B) kept
			expect(graph.edgeCount).toBe(1);
			expect(graph.getEdgesFrom("B")).toHaveLength(1);
		});

		it("handles file with no nodes gracefully", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "A", file: "src/a.ts" }));
			graph.removeNodesByFile("src/nonexistent.ts");
			expect(graph.nodeCount).toBe(1);
		});
	});

	describe("getCompanions", () => {
		it("returns docs, tests, and examples for an artifact", () => {
			const graph = new ArtifactGraph();
			const target = makeNode({ id: "public_symbol:foo", kind: "public_symbol" });
			const doc = makeNode({ id: "doc:foo-ref", kind: "doc", file: "docs/foo.md" });
			const test = makeNode({ id: "test:foo-unit", kind: "test", file: "test/foo.test.ts" });
			const example = makeNode({
				id: "example:foo-ex",
				kind: "example",
				file: "examples/foo.ts",
			});

			graph.addNode(target);
			graph.addNode(doc);
			graph.addNode(test);
			graph.addNode(example);

			graph.addEdge({
				id: "e1",
				kind: "documents",
				from: "doc:foo-ref",
				to: "public_symbol:foo",
				provenance: "declared",
				confidence: 1.0,
			});
			graph.addEdge({
				id: "e2",
				kind: "tests",
				from: "test:foo-unit",
				to: "public_symbol:foo",
				provenance: "declared",
				confidence: 1.0,
			});
			graph.addEdge({
				id: "e3",
				kind: "illustrates",
				from: "example:foo-ex",
				to: "public_symbol:foo",
				provenance: "declared",
				confidence: 1.0,
			});

			const companions = graph.getCompanions("public_symbol:foo");
			expect(companions.docs).toHaveLength(1);
			expect(nonNull(companions.docs[0]).id).toBe("doc:foo-ref");
			expect(companions.tests).toHaveLength(1);
			expect(nonNull(companions.tests[0]).id).toBe("test:foo-unit");
			expect(companions.examples).toHaveLength(1);
			expect(nonNull(companions.examples[0]).id).toBe("example:foo-ex");
		});

		it("returns empty arrays when no companions exist", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "public_symbol:lonely" }));

			const companions = graph.getCompanions("public_symbol:lonely");
			expect(companions.docs).toEqual([]);
			expect(companions.tests).toEqual([]);
			expect(companions.examples).toEqual([]);
		});

		it("skips edges whose source node is missing", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "public_symbol:foo" }));
			graph.addEdge({
				id: "e1",
				kind: "documents",
				from: "doc:ghost",
				to: "public_symbol:foo",
				provenance: "declared",
				confidence: 1.0,
			});

			const companions = graph.getCompanions("public_symbol:foo");
			expect(companions.docs).toEqual([]);
		});
	});

	describe("serialization", () => {
		it("toNodesJson returns schema_version and nodes array", () => {
			const graph = new ArtifactGraph();
			graph.addNode(makeNode({ id: "A" }));
			graph.addNode(makeNode({ id: "B" }));

			const json = graph.toNodesJson();
			expect(json.schema_version).toBe(1);
			expect(json.nodes).toHaveLength(2);
		});

		it("toEdgesJson returns schema_version and edges array", () => {
			const graph = new ArtifactGraph();
			graph.addEdge(makeEdge({ id: "e1" }));

			const json = graph.toEdgesJson();
			expect(json.schema_version).toBe(1);
			expect(json.edges).toHaveLength(1);
		});

		it("fromJson round-trips correctly", () => {
			const graph = new ArtifactGraph();
			const nodeA = makeNode({ id: "A" });
			const nodeB = makeNode({ id: "B", file: "src/b.ts" });
			const edge = makeEdge({ id: "e1", from: "A", to: "B" });

			graph.addNode(nodeA);
			graph.addNode(nodeB);
			graph.addEdge(edge);

			const restored = ArtifactGraph.fromJson(graph.toNodesJson(), graph.toEdgesJson());

			expect(restored.nodeCount).toBe(2);
			expect(restored.edgeCount).toBe(1);
			expect(restored.getNode("A")).toEqual(nodeA);
			expect(restored.getNode("B")).toEqual(nodeB);
			expect(restored.getEdgesFrom("A")).toHaveLength(1);
		});
	});

	describe("counts", () => {
		it("nodeCount reflects current state", () => {
			const graph = new ArtifactGraph();
			expect(graph.nodeCount).toBe(0);
			graph.addNode(makeNode({ id: "A" }));
			expect(graph.nodeCount).toBe(1);
			graph.addNode(makeNode({ id: "B" }));
			expect(graph.nodeCount).toBe(2);
			graph.removeNodesByFile("src/index.ts");
			expect(graph.nodeCount).toBe(0);
		});

		it("edgeCount reflects current state", () => {
			const graph = new ArtifactGraph();
			expect(graph.edgeCount).toBe(0);
			graph.addEdge(makeEdge({ id: "e1" }));
			expect(graph.edgeCount).toBe(1);
			// Duplicate is not counted
			graph.addEdge(makeEdge({ id: "e1" }));
			expect(graph.edgeCount).toBe(1);
		});
	});
});
