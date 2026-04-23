// ===========================================
// Rule: Public Symbol Companions
// ===========================================
// When a public symbol's file is in changedFiles, check that
// its declared companion docs, tests, and examples exist.

import type { ArtifactGraph } from "../artifact-graph.js";
import type { Determinism, StructureFinding } from "../types.js";

export function checkPublicSymbolCompanions(
	graph: ArtifactGraph,
	changedFiles: string[],
): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const changedSet = new Set(changedFiles);
	const symbolNodes = graph.getNodesByKind("public_symbol");

	for (const symbol of symbolNodes) {
		if (!changedSet.has(symbol.file)) {
			continue;
		}

		const companions = graph.getCompanions(symbol.id);
		const allCompanions = [...companions.docs, ...companions.tests, ...companions.examples];

		if (allCompanions.length === 0) {
			continue;
		}

		const untouched = allCompanions.filter((c) => !changedSet.has(c.file));
		if (untouched.length === 0) {
			continue;
		}

		const allDeclared =
			symbol.provenance === "declared" && untouched.every((c) => c.provenance === "declared");
		const determinism: Determinism = allDeclared
			? "fully_deterministic"
			: "partially_deterministic";

		findings.push({
			name: "public_symbol_companion_untouched",
			severity: "warning",
			message: `Public symbol "${symbol.label}" was changed but ${untouched.length} companion(s) were not updated`,
			file: symbol.file,
			affected_files: untouched.map((c) => c.file),
			determinism,
			provenance: symbol.provenance,
			artifact_kind: "public_symbol",
			artifact_id: symbol.id,
			required_updates: untouched.map((c) => ({
				file: c.file,
				kind: c.kind,
				reason: `Companion ${c.kind} "${c.label}" may need updating`,
			})),
			confidence: allDeclared ? 1.0 : 0.8,
		});
	}

	return findings;
}
