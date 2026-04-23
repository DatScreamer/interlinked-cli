// ===========================================
// Rule: Env Key Companions
// ===========================================
// When an env_key node's file is in changedFiles, check that
// its declared companion docs, tests, and examples exist.

import type { ArtifactGraph } from "../artifact-graph.js";
import type { Determinism, StructureFinding } from "../types.js";

export function checkEnvKeyCompanions(
	graph: ArtifactGraph,
	changedFiles: string[],
): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const changedSet = new Set(changedFiles);
	const envNodes = graph.getNodesByKind("env_key");

	for (const envKey of envNodes) {
		if (!changedSet.has(envKey.file)) {
			continue;
		}

		const companions = graph.getCompanions(envKey.id);
		const allCompanions = [...companions.docs, ...companions.tests, ...companions.examples];

		if (allCompanions.length === 0) {
			continue;
		}

		const untouched = allCompanions.filter((c) => !changedSet.has(c.file));
		if (untouched.length === 0) {
			continue;
		}

		const allDeclared =
			envKey.provenance === "declared" && untouched.every((c) => c.provenance === "declared");
		const determinism: Determinism = allDeclared
			? "fully_deterministic"
			: "partially_deterministic";

		findings.push({
			name: "env_key_companion_untouched",
			severity: "warning",
			message: `Env key "${envKey.label}" was changed but ${untouched.length} companion(s) were not updated`,
			file: envKey.file,
			affected_files: untouched.map((c) => c.file),
			determinism,
			provenance: envKey.provenance,
			artifact_kind: "env_key",
			artifact_id: envKey.id,
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
