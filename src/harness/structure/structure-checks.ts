// ===========================================
// Generic Artifact Structure V1 — PostToolUse Structure Check Integration
// ===========================================
// Main entry point called from the harness server during PostToolUse
// evaluation. Runs the structure analysis pipeline for a single file edit.

import { isAbsolute, relative } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import type { CheckResultEntry } from "../types.js";
import { ArtifactGraph } from "./artifact-graph.js";
import { runAllExtractors } from "./extractors/index.js";
import { evaluateStructureRules } from "./rules/index.js";
import { getImplicitConfig, loadArtifactFile, loadStructureConfig } from "./structure-loader.js";
import type {
	ArtifactEdge,
	ArtifactFileKey,
	ArtifactNode,
	EdgeKind,
	StructureConfig,
	StructureFinding,
	StructurePendingCompletion,
} from "./types.js";

// -------------------------------------------
// Result type for the main entry point
// -------------------------------------------

export interface StructureCheckResult {
	results: CheckResultEntry[];
	findings: StructureFinding[];
	graph: ArtifactGraph;
	pendingCompletions: StructurePendingCompletion[];
}

// -------------------------------------------
// Convert a StructureFinding to a CheckResultEntry
// -------------------------------------------

export function structureFindingToCheckResult(finding: StructureFinding): CheckResultEntry {
	return {
		source: "structure",
		name: finding.name,
		severity: finding.severity,
		message: finding.message,
		file: finding.file,
		detail: finding.detail,
		line: finding.line,
		affected_files: finding.affected_files,
		determinism: finding.determinism,
		provenance: finding.provenance,
		artifact_kind: finding.artifact_kind,
		artifact_id: finding.artifact_id,
		required_updates: finding.required_updates,
		confidence: finding.confidence,
	};
}

// -------------------------------------------
// Main entry point
// -------------------------------------------

export function runStructureChecks(
	editedFilePath: string,
	repoRoot: string,
	graph: ArtifactGraph | null,
	config: StructureConfig | null,
	sessionTouchedFiles?: Set<string>,
): StructureCheckResult {
	// Normalize to repo-relative path (manifests use relative paths)
	const relPath = isAbsolute(editedFilePath)
		? relative(repoRoot, editedFilePath)
		: editedFilePath;

	// Step 1: Resolve config
	const resolvedConfig = config ?? resolveConfig(repoRoot);

	// Step 2: Build or refresh graph
	const resolvedGraph = graph ?? buildGraph(repoRoot, resolvedConfig);

	// Step 3: Incremental refresh for the edited file
	refreshFileInGraph(resolvedGraph, relPath, repoRoot, resolvedConfig);

	// Step 4: Evaluate rules
	// Include session-touched files so companion rules know which files were already edited
	const changedFiles = [relPath];
	if (sessionTouchedFiles) {
		for (const f of sessionTouchedFiles) {
			const relF = isAbsolute(f) ? relative(repoRoot, f) : f;
			if (relF !== relPath) changedFiles.push(relF);
		}
	}
	const findings = evaluateStructureRules(resolvedGraph, resolvedConfig, changedFiles, repoRoot);

	// Step 5: Apply PostToolUse emission filtering and convert
	const filteredFindings = filterByEmissionConfig(findings, resolvedConfig);
	const results = filteredFindings.map(structureFindingToCheckResult);

	// Step 6: Build pending completions from filtered findings
	const pendingCompletions = buildPendingCompletions(filteredFindings);

	return { results, findings: filteredFindings, graph: resolvedGraph, pendingCompletions };
}

// -------------------------------------------
// Config resolution
// -------------------------------------------

function resolveConfig(repoRoot: string): StructureConfig {
	const loaded = loadStructureConfig(repoRoot);
	return loaded.config ?? getImplicitConfig();
}

// -------------------------------------------
// Build graph from extractors + declared artifacts
// -------------------------------------------

function buildGraph(repoRoot: string, config: StructureConfig): ArtifactGraph {
	const extracted = runAllExtractors(repoRoot);
	const graph = new ArtifactGraph();

	for (const node of extracted.nodes) {
		graph.addNode(node);
	}
	for (const edge of extracted.edges) {
		graph.addEdge(edge);
	}

	layerDeclaredArtifacts(graph, repoRoot, config);
	return graph;
}

// -------------------------------------------
// Incremental file refresh in the graph
// -------------------------------------------

function refreshFileInGraph(
	graph: ArtifactGraph,
	editedFilePath: string,
	repoRoot: string,
	config: StructureConfig,
): void {
	graph.removeNodesByFile(editedFilePath);
	const freshExtracted = runAllExtractors(repoRoot);

	for (const node of freshExtracted.nodes) {
		if (node.file === editedFilePath) {
			graph.addNode(node);
		}
	}
	for (const edge of freshExtracted.edges) {
		const fromNode = graph.getNode(edge.from);
		const toNode = graph.getNode(edge.to);
		if (fromNode?.file === editedFilePath || toNode?.file === editedFilePath) {
			graph.addEdge(edge);
		}
	}
	// Re-layer declared artifacts so declared nodes for this file are not lost
	layerDeclaredArtifacts(graph, repoRoot, config);
}

// -------------------------------------------
// Layer declared artifacts from artifact files onto the graph
// -------------------------------------------

export function layerDeclaredArtifacts(
	graph: ArtifactGraph,
	repoRoot: string,
	config: StructureConfig,
): void {
	const artifactKeys = Object.keys(config.artifacts) as ArtifactFileKey[];

	for (const key of artifactKeys) {
		const relPath = config.artifacts[key];
		if (!relPath) continue;

		const { data } = loadArtifactFile(repoRoot, key, relPath);
		if (!data) continue;

		const contributions = extractDeclaredContributions(key, data);
		for (const { node, edges } of contributions) {
			graph.addNode(node);
			for (const edge of edges) {
				graph.addEdge(edge);
			}
		}
	}
}

// -------------------------------------------
// Extract declared graph contributions from artifact files
// -------------------------------------------

interface GraphContribution {
	node: ArtifactNode;
	edges: ArtifactEdge[];
}

function extractDeclaredContributions(key: ArtifactFileKey, data: JsonObject): GraphContribution[] {
	switch (key) {
		case "public_api":
			return extractPublicApiContributions(data);
		case "env":
			return extractSimpleKeyContributions(data, "keys", "env_key");
		case "config":
			return extractSimpleKeyContributions(data, "keys", "config_key");
		case "tests":
			return extractFileEntryContributions(data, "tests", "test");
		case "docs":
			return extractFileEntryContributions(data, "docs", "doc");
		case "examples":
			return extractFileEntryContributions(data, "examples", "example");
		case "glossary":
			return extractGlossaryContributions(data);
		case "layers":
			return extractLabelOnlyContributions(data, "layers", "layer");
		case "packages":
			return extractPackageContributions(data);
	}
}

// -------------------------------------------
// Artifact-specific extraction helpers
// -------------------------------------------

function declaredNode(
	kind: ArtifactNode["kind"],
	localId: string,
	label: string,
	file: string,
): ArtifactNode {
	return {
		id: `${kind}:${localId}`,
		kind,
		label,
		file,
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
	};
}

function extractModuleSymbols(
	moduleId: string,
	file: string,
	symbols: unknown[],
): GraphContribution[] {
	return symbols.map((sym) => {
		const s = sym as { name: string; docs?: string[]; tests?: string[]; examples?: string[] };
		const symbolLocalId = `${moduleId}#${s.name}`;
		const symbolRef = `public_symbol:${symbolLocalId}`;
		const edges: ArtifactEdge[] = [
			{
				id: `edge:module:${moduleId}->${symbolRef}`,
				kind: "exports",
				from: `module:${moduleId}`,
				to: symbolRef,
				provenance: "declared" as const,
				confidence: 1.0,
			},
		];
		// Create companion edges from declared docs/tests/examples arrays
		for (const docId of s.docs ?? []) {
			edges.push({
				id: `edge:${symbolRef}->doc:${docId}`,
				kind: "documents",
				from: symbolRef,
				to: `doc:${docId}`,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		for (const testId of s.tests ?? []) {
			edges.push({
				id: `edge:${symbolRef}->test:${testId}`,
				kind: "tests",
				from: symbolRef,
				to: `test:${testId}`,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		for (const exId of s.examples ?? []) {
			edges.push({
				id: `edge:${symbolRef}->example:${exId}`,
				kind: "illustrates",
				from: symbolRef,
				to: `example:${exId}`,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		return { node: declaredNode("public_symbol", symbolLocalId, symbolLocalId, file), edges };
	});
}

function extractPublicApiContributions(data: JsonObject): GraphContribution[] {
	const modules = (data as { modules?: unknown[] }).modules;
	if (!Array.isArray(modules)) return [];

	const results: GraphContribution[] = [];
	for (const mod of modules) {
		const m = mod as { id: string; file: string; symbols?: unknown[] };
		results.push({ node: declaredNode("module", m.id, m.id, m.file), edges: [] });

		if (Array.isArray(m.symbols)) {
			results.push(...extractModuleSymbols(m.id, m.file, m.symbols));
		}
	}
	return results;
}

function extractSimpleKeyContributions(
	data: JsonObject,
	arrayField: string,
	kind: ArtifactNode["kind"],
): GraphContribution[] {
	const items = (data as Record<string, unknown[]>)[arrayField];
	if (!Array.isArray(items)) return [];

	return items.map((item) => {
		const entry = item as {
			name: string;
			docs?: string[];
			tests?: string[];
			examples?: string[];
			default_sources?: string[];
			declared_in?: string[];
		};
		const ref = `${kind}:${entry.name}`;
		// Use the first declared source file so the changed-file gate can match
		const file = (entry.default_sources ?? entry.declared_in ?? [])[0] ?? "";
		const edges: ArtifactEdge[] = [];
		for (const docId of entry.docs ?? []) {
			edges.push({
				id: `edge:${ref}->doc:${docId}`,
				kind: "documents",
				from: ref,
				to: `doc:${docId}`,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		for (const testId of entry.tests ?? []) {
			edges.push({
				id: `edge:${ref}->test:${testId}`,
				kind: "tests",
				from: ref,
				to: `test:${testId}`,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		for (const exId of entry.examples ?? []) {
			edges.push({
				id: `edge:${ref}->example:${exId}`,
				kind: "illustrates",
				from: ref,
				to: `example:${exId}`,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		return { node: declaredNode(kind, entry.name, entry.name, file), edges };
	});
}

function extractFileEntryContributions(
	data: JsonObject,
	arrayField: string,
	kind: ArtifactNode["kind"],
): GraphContribution[] {
	const items = (data as Record<string, unknown[]>)[arrayField];
	if (!Array.isArray(items)) return [];

	const edgeKindMap: Record<string, EdgeKind> = {
		doc: "documents",
		test: "tests",
		example: "illustrates",
	};
	const edgeKind = edgeKindMap[kind] ?? "documents";

	return items.map((item) => {
		const entry = item as {
			id: string;
			file: string;
			covers?: Array<{ artifact_kind: string; artifact_id: string }>;
		};
		const ref = `${kind}:${entry.id}`;
		const edges: ArtifactEdge[] = [];
		// Create edges from covers entries back to the covered artifact
		for (const c of entry.covers ?? []) {
			const targetRef = `${c.artifact_kind}:${c.artifact_id}`;
			edges.push({
				id: `edge:${targetRef}->${ref}`,
				kind: edgeKind,
				from: targetRef,
				to: ref,
				provenance: "declared",
				confidence: 1.0,
			});
		}
		return { node: declaredNode(kind, entry.id, entry.id, entry.file), edges };
	});
}

function extractGlossaryContributions(data: JsonObject): GraphContribution[] {
	const terms = (data as { terms?: unknown[] }).terms;
	if (!Array.isArray(terms)) return [];

	return terms.map((item) => {
		const entry = item as {
			id: string;
			canonical: string;
			aliases?: string[];
			deprecated?: string[];
		};
		const node = declaredNode("term", entry.id, entry.canonical, "");
		// Preserve aliases and deprecated arrays as metadata so rules can access them
		if (entry.aliases?.length || entry.deprecated?.length) {
			node.metadata = {
				...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
				...(entry.deprecated?.length ? { deprecated: entry.deprecated } : {}),
			};
		}
		return { node, edges: [] };
	});
}

function extractLabelOnlyContributions(
	data: JsonObject,
	arrayField: string,
	kind: ArtifactNode["kind"],
): GraphContribution[] {
	const items = (data as Record<string, unknown[]>)[arrayField];
	if (!Array.isArray(items)) return [];

	return items.map((item) => {
		const entry = item as { id: string };
		return { node: declaredNode(kind, entry.id, entry.id, ""), edges: [] };
	});
}

function extractPackageContributions(data: JsonObject): GraphContribution[] {
	const packages = (data as { packages?: unknown[] }).packages;
	if (!Array.isArray(packages)) return [];

	return packages.map((item) => {
		const entry = item as { id: string; root: string };
		return { node: declaredNode("package", entry.id, entry.id, entry.root), edges: [] };
	});
}

// -------------------------------------------
// Filter findings by PostToolUse emission config
// -------------------------------------------

function filterByEmissionConfig(
	findings: StructureFinding[],
	config: StructureConfig,
): StructureFinding[] {
	const { posttooluse } = config;
	let heuristicCount = 0;

	return findings.filter((f) => {
		if (f.determinism === "fully_deterministic" && !posttooluse.emit_deterministic)
			return false;
		if (f.determinism === "partially_deterministic" && !posttooluse.emit_partial) return false;
		if (f.determinism === "heuristic") {
			if (!posttooluse.emit_heuristic) return false;
			heuristicCount++;
			if (heuristicCount > posttooluse.max_heuristics) return false;
		}
		return true;
	});
}

// -------------------------------------------
// Build pending completions from findings
// -------------------------------------------

function buildPendingCompletions(findings: StructureFinding[]): StructurePendingCompletion[] {
	return findings
		.filter((f) => f.required_updates.length > 0)
		.map((finding) => ({
			source_artifact_ref: `${finding.artifact_kind}:${finding.artifact_id}`,
			source_file: finding.file,
			finding_class: finding.name,
			required_companion_files: finding.required_updates.map((u) => u.file),
			resolved_companion_files: new Set<string>(),
			determinism: finding.determinism,
			provenance: finding.provenance,
			first_detected_tool_call: Date.now(),
		}));
}
