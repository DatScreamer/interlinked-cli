import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode } from "../types.js";
import { checkEnvKeyCompanions } from "./env-key-companions.js";

function envNode(
	label: string,
	file: string,
	provenance: "declared" | "inferred" | "extracted" = "declared",
): ArtifactNode {
	return {
		id: makeGlobalRef("env_key", label),
		kind: "env_key",
		label,
		file,
		provenance,
		determinism_ceiling: "partially_deterministic",
	};
}

describe("checkEnvKeyCompanions", () => {
	it("returns empty when no env key file is in changedFiles", () => {
		const g = new ArtifactGraph();
		g.addNode(envNode("SAMPLE_FLAG", ".env.example"));
		expect(checkEnvKeyCompanions(g, ["src/unrelated.ts"])).toEqual([]);
	});

	it("returns empty when the env key has no companion docs", () => {
		const g = new ArtifactGraph();
		g.addNode(envNode("SAMPLE_FLAG", ".env.example"));
		expect(checkEnvKeyCompanions(g, [".env.example"])).toEqual([]);
	});

	it("flags untouched companion docs when the env key file is changed", () => {
		const g = new ArtifactGraph();
		const env = envNode("SAMPLE_FLAG", ".env.example");
		const doc: ArtifactNode = {
			id: makeGlobalRef("doc", "config"),
			kind: "doc",
			label: "config",
			file: "docs/config.md",
			provenance: "declared",
			determinism_ceiling: "fully_deterministic",
		};
		g.addNode(env);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(env.id, doc.id),
			kind: "documents",
			from: env.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		const findings = checkEnvKeyCompanions(g, [".env.example"]);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("env_key_companion_untouched");
		expect(nonNull(findings[0]).affected_files).toEqual(["docs/config.md"]);
		expect(nonNull(findings[0]).artifact_kind).toBe("env_key");
	});
});
