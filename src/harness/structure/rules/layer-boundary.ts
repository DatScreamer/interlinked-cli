// ===========================================
// Rule: Layer Boundary Violations
// ===========================================
// Check import edges that cross forbidden layer boundaries.

import type { ArtifactGraph } from "../artifact-graph.js";
import type { StructureFinding } from "../types.js";

export function checkLayerBoundaryViolations(
	graph: ArtifactGraph,
	layerRules: Array<{ from: string; cannot_import: string[] }>,
): StructureFinding[] {
	if (layerRules.length === 0) {
		return [];
	}

	const findings: StructureFinding[] = [];

	// Build node -> layer mapping from belongs_to_layer edges
	const nodeToLayer = new Map<string, string>();
	for (const edge of graph.getEdgesByKind("belongs_to_layer")) {
		nodeToLayer.set(edge.from, edge.to);
	}

	// Build forbidden-pair lookup: layerRef -> Set of forbidden layer refs
	const forbidden = new Map<string, Set<string>>();
	for (const rule of layerRules) {
		forbidden.set(rule.from, new Set(rule.cannot_import));
	}

	// Check each import edge
	for (const edge of graph.getEdgesByKind("imports")) {
		const sourceLayer = nodeToLayer.get(edge.from);
		const targetLayer = nodeToLayer.get(edge.to);

		if (!sourceLayer || !targetLayer) {
			continue;
		}

		const blockedSet = forbidden.get(sourceLayer);
		if (!blockedSet?.has(targetLayer)) {
			continue;
		}

		const sourceNode = graph.getNode(edge.from);
		const targetNode = graph.getNode(edge.to);
		if (!sourceNode || !targetNode) {
			continue;
		}

		findings.push({
			name: "layer_boundary_violation",
			severity: "warning",
			message: `"${sourceNode.label}" imports "${targetNode.label}" across forbidden layer boundary (${sourceLayer} -> ${targetLayer})`,
			file: sourceNode.file,
			affected_files: [targetNode.file],
			determinism: "fully_deterministic",
			provenance: edge.provenance,
			artifact_kind: sourceNode.kind,
			artifact_id: sourceNode.id,
			required_updates: [
				{
					file: sourceNode.file,
					kind: "module",
					reason: `Remove import of "${targetNode.label}" from forbidden layer`,
				},
			],
			confidence: edge.confidence,
		});
	}

	return findings;
}
