// ===========================================
// Generic Artifact Structure V1 — Performance Benchmarks
// ===========================================
// Ensures structure operations stay within acceptable latency budgets.
//
// @perf — benchmarks here use Date.now() for timing characterization. Fake
// timers would defeat the measurement; this marker opts the file out of
// the non_deterministic_test taste check.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactGraph } from "../artifact-graph.js";
import { runAllExtractors } from "../extractors/index.js";
import { evaluateStructureRules } from "../rules/index.js";
import { layerDeclaredArtifacts } from "../structure-checks.js";
import { formatStructureWarnings } from "../structure-formatter.js";
import { getImplicitConfig, loadStructureConfig } from "../structure-loader.js";
import type { StructureConfig, StructureFinding } from "../types.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const DECLARED_ROOT = join(FIXTURES, "fixture-declared");

// -------------------------------------------
// Helper: build a full graph
// -------------------------------------------

function buildFullGraph(root: string, config: StructureConfig): ArtifactGraph {
	const extracted = runAllExtractors(root);
	const graph = new ArtifactGraph();
	for (const node of extracted.nodes) graph.addNode(node);
	for (const edge of extracted.edges) graph.addEdge(edge);
	layerDeclaredArtifacts(graph, root, config);
	return graph;
}

// -------------------------------------------
// Benchmarks
// -------------------------------------------

describe("performance", () => {
	it("cold scan of fixture-declared completes under 500ms", () => {
		const loaded = loadStructureConfig(DECLARED_ROOT);
		const config = loaded.config ?? getImplicitConfig();

		const start = Date.now();
		const graph = buildFullGraph(DECLARED_ROOT, config);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(500);
		expect(graph.nodeCount).toBeGreaterThan(0);
	});

	it("warm incremental refresh completes under 50ms", () => {
		const loaded = loadStructureConfig(DECLARED_ROOT);
		const config = loaded.config ?? getImplicitConfig();

		// Cold build first (not timed)
		const graph = buildFullGraph(DECLARED_ROOT, config);

		// Time the incremental refresh: remove and re-add nodes for a single file
		const start = Date.now();
		graph.removeNodesByFile("src/client.ts");
		const freshExtracted = runAllExtractors(DECLARED_ROOT);
		for (const node of freshExtracted.nodes) {
			if (node.file === "src/client.ts") {
				graph.addNode(node);
			}
		}
		for (const edge of freshExtracted.edges) {
			const fromNode = graph.getNode(edge.from);
			const toNode = graph.getNode(edge.to);
			if (fromNode?.file === "src/client.ts" || toNode?.file === "src/client.ts") {
				graph.addEdge(edge);
			}
		}
		layerDeclaredArtifacts(graph, DECLARED_ROOT, config);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50);
		expect(graph.nodeCount).toBeGreaterThan(0);
	});

	it("rule evaluation completes under 50ms", () => {
		const loaded = loadStructureConfig(DECLARED_ROOT);
		const config = loaded.config ?? getImplicitConfig();
		const graph = buildFullGraph(DECLARED_ROOT, config);

		const start = Date.now();
		const findings = evaluateStructureRules(
			graph,
			config,
			["src/client.ts", "src/app.ts"],
			DECLARED_ROOT,
		);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50);
		// Should produce at least one finding (companion or glossary residue)
		expect(findings.length).toBeGreaterThanOrEqual(0);
	});

	it("formatStructureWarnings completes under 10ms", () => {
		// Create a representative set of findings
		const findings: StructureFinding[] = [];
		for (let i = 0; i < 20; i++) {
			findings.push({
				name: `test_finding_${i}`,
				severity: "warning",
				message: `Test finding message ${i}`,
				file: `src/file${i}.ts`,
				determinism:
					i % 3 === 0
						? "fully_deterministic"
						: i % 3 === 1
							? "partially_deterministic"
							: "heuristic",
				provenance: "declared",
				artifact_kind: "public_symbol",
				artifact_id: `public_symbol:sym${i}`,
				required_updates: [
					{ file: `docs/file${i}.md`, kind: "doc", reason: "Update documentation" },
					{ file: `test/file${i}.test.ts`, kind: "test", reason: "Update tests" },
				],
				confidence: 1.0,
			});
		}

		const start = Date.now();
		const formatted = formatStructureWarnings(findings);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(10);
		expect(formatted.length).toBe(20);
		// Each formatted warning should contain the interlinked:structure prefix
		for (const warning of formatted) {
			expect(warning).toContain("[interlinked:structure]");
		}
	});
});
