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

function addCompanion(
	graph: ArtifactGraph,
	env: ArtifactNode,
	kind: "doc" | "test" | "example",
	label: string,
	file: string,
	provenance: "declared" | "inferred" | "extracted" = "declared",
): ArtifactNode {
	const companion: ArtifactNode = {
		id: makeGlobalRef(kind, label),
		kind,
		label,
		file,
		provenance,
		determinism_ceiling: "fully_deterministic",
	};
	graph.addNode(companion);
	graph.addEdge({
		id: makeEdgeId(env.id, companion.id),
		kind: kind === "doc" ? "documents" : kind === "test" ? "tests" : "illustrates",
		from: env.id,
		to: companion.id,
		provenance: "declared",
		confidence: 1,
	});
	return companion;
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

	it("ignores companions when the env key file is unchanged", () => {
		const g = new ArtifactGraph();
		const env = envNode("SAMPLE_FLAG", ".env.example");
		g.addNode(env);
		addCompanion(g, env, "doc", "config", "docs/config.md");

		expect(checkEnvKeyCompanions(g, ["src/unrelated.ts"])).toEqual([]);
	});

	it("returns empty when every companion is also changed", () => {
		const g = new ArtifactGraph();
		const env = envNode("SAMPLE_FLAG", ".env.example");
		g.addNode(env);
		addCompanion(g, env, "doc", "config", "docs/config.md");

		expect(checkEnvKeyCompanions(g, [".env.example", "docs/config.md"])).toEqual([]);
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

	it("reports only untouched companions across docs, tests, and examples", () => {
		const g = new ArtifactGraph();
		const env = envNode("SAMPLE_FLAG", ".env.example");
		g.addNode(env);
		addCompanion(g, env, "doc", "config docs", "docs/config.md");
		addCompanion(g, env, "test", "config test", "test/config.test.ts");
		addCompanion(g, env, "example", "config example", "examples/config.ts");

		const findings = checkEnvKeyCompanions(g, [".env.example", "test/config.test.ts"]);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0])).toMatchObject({
			message: 'Env key "SAMPLE_FLAG" was changed but 2 companion(s) were not updated',
			severity: "warning",
			affected_files: ["docs/config.md", "examples/config.ts"],
			determinism: "fully_deterministic",
			confidence: 1,
		});
		expect(nonNull(findings[0]).required_updates).toEqual([
			{
				file: "docs/config.md",
				kind: "doc",
				reason: 'Companion doc "config docs" may need updating',
			},
			{
				file: "examples/config.ts",
				kind: "example",
				reason: 'Companion example "config example" may need updating',
			},
		]);
	});

	it("marks an inferred env key as partially deterministic even with declared companions", () => {
		const g = new ArtifactGraph();
		const env = envNode("INFERRED_FLAG", ".env", "inferred");
		g.addNode(env);
		addCompanion(g, env, "doc", "config", "docs/config.md");

		const findings = checkEnvKeyCompanions(g, [".env"]);
		expect(nonNull(findings[0])).toMatchObject({
			determinism: "partially_deterministic",
			provenance: "inferred",
			confidence: 0.8,
		});
	});

	it("marks a declared env key as partial when any untouched companion is inferred", () => {
		const g = new ArtifactGraph();
		const env = envNode("MIXED_FLAG", ".env.example");
		g.addNode(env);
		addCompanion(g, env, "doc", "declared docs", "docs/config.md");
		addCompanion(g, env, "test", "inferred test", "test/config.test.ts", "inferred");

		const findings = checkEnvKeyCompanions(g, [".env.example"]);
		expect(nonNull(findings[0])).toMatchObject({
			determinism: "partially_deterministic",
			provenance: "declared",
			confidence: 0.8,
		});
	});
});
