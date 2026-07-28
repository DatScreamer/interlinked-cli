import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "../types.js";
import { checkPublicSymbolCompanions } from "./public-symbol-companions.js";

function symbolNode(
	id: string,
	file: string,
	provenance: "declared" | "inferred" = "declared",
): ArtifactNode {
	return {
		id: makeGlobalRef("public_symbol", id),
		kind: "public_symbol",
		label: id,
		file,
		provenance,
		determinism_ceiling: "partially_deterministic",
	};
}

function docNode(id: string, file: string): ArtifactNode {
	return {
		id: makeGlobalRef("doc", id),
		kind: "doc",
		label: id,
		file,
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
	};
}

function companionEdge(
	from: string,
	to: string,
	kind: "documents" | "tests" | "illustrates",
): ArtifactEdge {
	return {
		id: makeEdgeId(from, to),
		kind,
		from,
		to,
		provenance: "declared",
		confidence: 1,
	};
}

describe("checkPublicSymbolCompanions", () => {
	it("returns empty when no public symbols are in changedFiles", () => {
		const g = new ArtifactGraph();
		g.addNode(symbolNode("foo", "src/foo.ts"));
		expect(checkPublicSymbolCompanions(g, ["src/other.ts"])).toEqual([]);
	});

	it("returns empty when the changed symbol has no companions", () => {
		const g = new ArtifactGraph();
		g.addNode(symbolNode("foo", "src/foo.ts"));
		expect(checkPublicSymbolCompanions(g, ["src/foo.ts"])).toEqual([]);
	});

	it("returns empty when every companion is ALSO in changedFiles", () => {
		const g = new ArtifactGraph();
		const sym = symbolNode("foo", "src/foo.ts");
		const doc = docNode("foo-doc", "docs/foo.md");
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge(companionEdge(sym.id, doc.id, "documents"));
		expect(checkPublicSymbolCompanions(g, ["src/foo.ts", "docs/foo.md"])).toEqual([]);
	});

	it("flags untouched companions when the symbol's file is changed", () => {
		const g = new ArtifactGraph();
		const sym = symbolNode("foo", "src/foo.ts");
		const doc = docNode("foo-doc", "docs/foo.md");
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge(companionEdge(sym.id, doc.id, "documents"));

		const findings = checkPublicSymbolCompanions(g, ["src/foo.ts"]);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("public_symbol_companion_untouched");
		expect(nonNull(findings[0]).affected_files).toEqual(["docs/foo.md"]);
	});

	it("determinism is fully_deterministic when every node is declared", () => {
		const g = new ArtifactGraph();
		const sym = symbolNode("foo", "src/foo.ts", "declared");
		const doc = docNode("foo-doc", "docs/foo.md");
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge(companionEdge(sym.id, doc.id, "documents"));

		const finding = checkPublicSymbolCompanions(g, ["src/foo.ts"])[0];
		expect(nonNull(finding).determinism).toBe("fully_deterministic");
		expect(nonNull(finding).confidence).toBe(1.0);
	});

	it("determinism falls back to partially_deterministic when any node is inferred", () => {
		const g = new ArtifactGraph();
		const sym = symbolNode("foo", "src/foo.ts", "inferred");
		const doc = docNode("foo-doc", "docs/foo.md");
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge(companionEdge(sym.id, doc.id, "documents"));

		const finding = checkPublicSymbolCompanions(g, ["src/foo.ts"])[0];
		expect(nonNull(finding).determinism).toBe("partially_deterministic");
		expect(nonNull(finding).confidence).toBe(0.8);
	});
});
