// ===========================================
// Extractors — barrel file and runner
// ===========================================

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
	moduleExtractor,
	packageExtractor,
	envExtractor,
	testExtractor,
	docsExtractor,
	examplesExtractor,
	configExtractor,
};

export interface Extractor {
	metadata: ExtractorMetadata;
	// Each extractor accepts an optional shared WalkBudget so runAllExtractors
	// can cap total filesystem work across all extractors (see bounded-walk.ts).
	// Standalone callers omit it and get a fresh per-call budget.
	extract: (repoRoot: string, budget?: WalkBudget) => ExtractorResult;
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
