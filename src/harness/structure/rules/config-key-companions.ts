// ===========================================
// Rule: Config Key Companions
// ===========================================
// When a config_key node's file is in changedFiles, check that
// its declared companion docs, tests, and examples exist.

import type { ArtifactGraph } from "../artifact-graph.js";
import type { Determinism, StructureFinding } from "../types.js";

export function checkConfigKeyCompanions(
	graph: ArtifactGraph,
	changedFiles: string[],
): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const changedSet = new Set(changedFiles);
	const configNodes = graph.getNodesByKind("config_key");

	for (const configKey of configNodes) {
		if (!changedSet.has(configKey.file)) {
			continue;
		}

		const companions = graph.getCompanions(configKey.id);
		const allCompanions = [...companions.docs, ...companions.tests, ...companions.examples];

		if (allCompanions.length === 0) {
			continue;
		}

		const untouched = allCompanions.filter((c) => !changedSet.has(c.file));
		if (untouched.length === 0) {
			continue;
		}

		const allDeclared =
			configKey.provenance === "declared" &&
			untouched.every((c) => c.provenance === "declared");
		const determinism: Determinism = allDeclared
			? "fully_deterministic"
			: "partially_deterministic";

		findings.push({
			name: "config_key_companion_untouched",
			severity: "warning",
			message: `Config key "${configKey.label}" was changed but ${untouched.length} companion(s) were not updated`,
			file: configKey.file,
			affected_files: untouched.map((c) => c.file),
			determinism,
			provenance: configKey.provenance,
			artifact_kind: "config_key",
			artifact_id: configKey.id,
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
