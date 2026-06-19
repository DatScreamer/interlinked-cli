// ===========================================
// Extractors — barrel file and runner
// ===========================================

import type { ArtifactGraph } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactKind, ExtractorMetadata, ExtractorResult } from "../types.js";
import { createWalkBudget, type WalkBudget } from "./bounded-walk.js";
import * as configExtractor from "./config-extractor.js";
import * as docsExtractor from "./docs-extractor.js";
import * as envExtractor from "./env-extractor.js";
import * as examplesExtractor from "./examples-extractor.js";
import * as moduleExtractor from "./module-extractor.js";
import * as packageExtractor from "./package-extractor.js";
import { linkModulesToPackages } from "./package-extractor.js";
import * as testExtractor from "./test-extractor.js";

export {
	configExtractor,
	docsExtractor,
	envExtractor,
	examplesExtractor,
	moduleExtractor,
	packageExtractor,
	testExtractor,
};

export interface Extractor {
	metadata: ExtractorMetadata;
	// Each extractor accepts an optional shared WalkBudget so runAllExtractors
	// can cap total filesystem work across all extractors (see bounded-walk.ts).
	// Standalone callers omit it and get a fresh per-call budget.
	extract: (repoRoot: string, budget?: WalkBudget) => ExtractorResult;
	/** Classify a SINGLE file into its nodes/edges (no walk) — drives the
	 *  per-edited-file incremental refresh (O(1) instead of re-walking the repo). */
	classifyFile: (repoRoot: string, relPath: string) => ExtractorResult;
}

export const allExtractors: Extractor[] = [
	moduleExtractor,
	packageExtractor,
	envExtractor,
	testExtractor,
	docsExtractor,
	examplesExtractor,
	configExtractor,
];

/** ArtifactKind constants used for cross-extractor edge linking. */
const MODULE_KIND: ArtifactKind = "module";
const PACKAGE_KIND: ArtifactKind = "package";

/**
 * Result of {@link runAllExtractors}. Structurally a superset of
 * `ExtractorResult` — the extra `truncated` flag is additive, so existing
 * callers that only read `.nodes` / `.edges` are unaffected. `truncated` is
 * true when the shared filesystem-walk budget was exhausted and the artifact
 * graph is therefore partial (see bounded-walk.ts). Callers must not treat a
 * truncated graph as a complete picture of the repo.
 */
export interface RunAllExtractorsResult extends ExtractorResult {
	truncated: boolean;
}

export function runAllExtractors(repoRoot: string): RunAllExtractorsResult {
	const allNodes: ExtractorResult["nodes"] = [];
	const allEdges: ArtifactEdge[] = [];

	// One shared budget across all extractors: caps total filesystem work for
	// the whole graph build, not 25K entries / 8s per extractor. Defense-in-
	// depth against a mis-resolved repoRoot (e.g. $HOME) — see bounded-walk.ts.
	const budget = createWalkBudget();

	for (const extractor of allExtractors) {
		const result = extractor.extract(repoRoot, budget);
		allNodes.push(...result.nodes);
		allEdges.push(...result.edges);
	}

	// Create cross-extractor edges: module -> package containment
	const moduleNodes = allNodes.filter((n) => n.kind === MODULE_KIND);
	const packageNodes = allNodes.filter((n) => n.kind === PACKAGE_KIND);
	if (moduleNodes.length > 0 && packageNodes.length > 0) {
		const packageEdges = linkModulesToPackages(moduleNodes, packageNodes);
		allEdges.push(...packageEdges);
	}

	return { nodes: allNodes, edges: allEdges, truncated: budget.truncated };
}

/** Run every extractor's per-file classifier on ONE file. The O(1) basis for
 *  the incremental refresh — replaces re-walking (and re-reading) the whole repo
 *  on every edit, which is what starved the daemon on large repos. */
export function extractSingleFile(repoRoot: string, relPath: string): ExtractorResult {
	const nodes: ExtractorResult["nodes"] = [];
	const edges: ArtifactEdge[] = [];
	for (const extractor of allExtractors) {
		const r = extractor.classifyFile(repoRoot, relPath);
		nodes.push(...r.nodes);
		edges.push(...r.edges);
	}
	return { nodes, edges };
}

/** Apply a per-file re-extract of `relPath` to `graph` in place: drop the file's
 *  old nodes/edges, add its fresh ones, then restore the two cross-file edge shapes
 *  a single-file classify cannot see on its own — module→package containment (needs
 *  the graph's package nodes) and inbound companion edges OWNED BY OTHER FILES (e.g.
 *  a test→module edge when the module itself is the edited file; removeNodesByFile
 *  drops it with the node, and a per-file re-extract of the module won't recreate an
 *  edge that belongs to the test file). */
export function relinkEditedFile(graph: ArtifactGraph, repoRoot: string, relPath: string): void {
	const inbound: ArtifactEdge[] = [];
	for (const node of graph.getNodesByFile(relPath)) {
		for (const edge of graph.getEdgesTo(node.id)) {
			const from = graph.getNode(edge.from);
			if (from && from.file !== relPath) inbound.push(edge);
		}
	}
	graph.removeNodesByFile(relPath);
	const fresh = extractSingleFile(repoRoot, relPath);
	for (const node of fresh.nodes) graph.addNode(node);
	for (const edge of fresh.edges) graph.addEdge(edge);
	const modules = fresh.nodes.filter((n) => n.kind === "module");
	if (modules.length > 0) {
		for (const edge of linkModulesToPackages(modules, graph.getNodesByKind("package"))) {
			graph.addEdge(edge);
		}
	}
	for (const edge of inbound) {
		if (graph.getNode(edge.to)) graph.addEdge(edge);
	}
}
