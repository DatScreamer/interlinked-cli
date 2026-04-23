// ===========================================
// Extractors — barrel file and runner
// ===========================================

import type { ArtifactEdge, ExtractorMetadata, ExtractorResult } from "../types.js";
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
	extract: (repoRoot: string) => ExtractorResult;
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

export function runAllExtractors(repoRoot: string): ExtractorResult {
	const allNodes: ExtractorResult["nodes"] = [];
	const allEdges: ArtifactEdge[] = [];

	for (const extractor of allExtractors) {
		const result = extractor.extract(repoRoot);
		allNodes.push(...result.nodes);
		allEdges.push(...result.edges);
	}

	// Create cross-extractor edges: module -> package containment
	const moduleNodes = allNodes.filter((n) => n.kind === "module");
	const packageNodes = allNodes.filter((n) => n.kind === "package");
	if (moduleNodes.length > 0 && packageNodes.length > 0) {
		const packageEdges = linkModulesToPackages(moduleNodes, packageNodes);
		allEdges.push(...packageEdges);
	}

	return { nodes: allNodes, edges: allEdges };
}
