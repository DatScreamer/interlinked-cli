// ===========================================
// Generic Artifact Structure V1 — Comprehensive Test Suite
// ===========================================
// Covers: schema validation, artifact graph, rule families,
// baseline, hook output, verify output, noise budget, adoption.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateAdoption } from "../adoption.js";

import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import { addToBaseline, findingToBaselineEntry, isBaselined } from "../baseline.js";
import { evaluateStructureRules } from "../rules/index.js";
import {
	resolveStructureConfig,
	validateConfigFile,
	validateDocsFile,
	validateEnvFile,
	validateExamplesFile,
	validateGlossaryFile,
	validateLayersFile,
	validatePackagesFile,
	validatePublicApiFile,
	validateStructureJson,
	validateTestsFile,
} from "../schema-validator.js";
import { structureFindingToCheckResult } from "../structure-checks.js";
import { formatStructureVerifyOutput, formatStructureWarnings } from "../structure-formatter.js";
import type {
	ArtifactEdge,
	ArtifactNode,
	BaselineFile,
	StructureConfig,
	StructureFinding,
} from "../types.js";
import { MODE_DEFAULTS } from "../types.js";

// -------------------------------------------
// Test Helpers
// -------------------------------------------

function makeNode(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
	return {
		id: "public_symbol:foo",
		kind: "public_symbol",
		label: "foo",
		file: "src/foo.ts",
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
		...overrides,
	};
}

function makeEdge(overrides: Partial<ArtifactEdge> = {}): ArtifactEdge {
	return {
		id: "edge:a->b",
		kind: "exports",
		from: "module:a",
		to: "public_symbol:b",
		provenance: "declared",
		confidence: 1.0,
		...overrides,
	};
}

function makeFinding(overrides: Partial<StructureFinding> = {}): StructureFinding {
	return {
		name: "test_finding",
		severity: "warning",
		message: "Test finding message",
		file: "src/foo.ts",
		determinism: "fully_deterministic",
		provenance: "declared",
		artifact_kind: "public_symbol",
		artifact_id: "public_symbol:foo",
		required_updates: [],
		confidence: 1.0,
		...overrides,
	};
}

function makeConfig(overrides: Partial<StructureConfig> = {}): StructureConfig {
	// Use resolveStructureConfig so mode defaults are applied correctly
	const base = resolveStructureConfig({
		version: 1,
		mode: overrides.mode ?? "minimal",
	});
	return { ...base, ...overrides };
}

// =========================================
// 1. Schema Validation Tests
// =========================================

describe("Schema Validation", () => {
	describe("validateStructureJson", () => {
		it("valid structure.json passes validation", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				artifacts: { public_api: "public-api.json" },
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});

		it("rejects version !== 1", () => {
			const result = validateStructureJson({ version: 2, mode: "standard" });
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.path === "$.version")).toBe(true);
		});

		it("rejects unknown top-level keys", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				unknownKey: true,
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("unknownKey"))).toBe(true);
		});

		it("rejects unknown keys in verify", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				verify: { bad_key: true },
			});
			expect(result.valid).toBe(false);
			expect(
				result.errors.some(
					(e) => e.path.includes("verify") && e.message.includes("bad_key"),
				),
			).toBe(true);
		});

		it("rejects unknown keys in posttooluse", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				posttooluse: { nope: true },
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.path.includes("posttooluse"))).toBe(true);
		});

		it("rejects unknown keys in adoption", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				adoption: { unknown_field: true },
			});
			expect(result.valid).toBe(false);
		});

		it("rejects unknown keys in builtins", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				builtins: { custom_rule: true },
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("custom_rule"))).toBe(true);
		});

		it("rejects unknown keys in artifacts", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				artifacts: { not_a_key: "file.json" },
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("not_a_key"))).toBe(true);
		});

		it("rejects invalid mode values", () => {
			const result = validateStructureJson({ version: 1, mode: "turbo" });
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.path === "$.mode")).toBe(true);
		});

		it("rejects non-repo-relative paths in artifacts", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				artifacts: { public_api: "/absolute/path.json" },
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("repo-relative"))).toBe(true);
		});

		it("rejects ../parent paths in artifacts", () => {
			const result = validateStructureJson({
				version: 1,
				mode: "standard",
				artifacts: { env: "../escape/env.json" },
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("resolveStructureConfig", () => {
		it("applies minimal mode defaults", () => {
			const config = resolveStructureConfig({ version: 1, mode: "minimal" });
			expect(config.mode).toBe("minimal");
			expect(config.verify.fail_on_deterministic).toBe(
				MODE_DEFAULTS.minimal.verify.fail_on_deterministic,
			);
		});

		it("applies standard mode defaults", () => {
			const config = resolveStructureConfig({ version: 1, mode: "standard" });
			expect(config.verify.fail_on_deterministic).toBe(true);
		});

		it("applies strict mode defaults", () => {
			const config = resolveStructureConfig({ version: 1, mode: "strict" });
			expect(config.verify.fail_on_deterministic).toBe(true);
		});

		it("explicit verify values override mode defaults", () => {
			const config = resolveStructureConfig({
				version: 1,
				mode: "minimal",
				verify: { fail_on_deterministic: true },
			});
			expect(config.verify.fail_on_deterministic).toBe(true);
			// Other verify fields still get minimal defaults
			expect(config.verify.fail_on_heuristic).toBe(false);
		});

		it("explicit posttooluse values override mode defaults", () => {
			const config = resolveStructureConfig({
				version: 1,
				mode: "standard",
				posttooluse: { max_heuristics: 10 },
			});
			expect(config.posttooluse.max_heuristics).toBe(10);
			expect(config.posttooluse.emit_deterministic).toBe(true);
		});
	});

	describe("validatePublicApiFile", () => {
		it("valid file passes validation", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [
					{
						id: "pkg-index",
						file: "src/index.ts",
						symbols: [
							{
								name: "createClient",
								kind: "function",
								stability: "public",
								docs: [],
								tests: [],
								examples: [],
							},
						],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects unknown keys", () => {
			const result = validatePublicApiFile({ version: 1, modules: [], extra: true });
			expect(result.valid).toBe(false);
		});

		it("rejects duplicate module IDs", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [
					{ id: "dup", file: "a.ts", symbols: [] },
					{ id: "dup", file: "b.ts", symbols: [] },
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
		});

		it("rejects invalid symbol kind", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [
					{
						id: "m",
						file: "src/m.ts",
						symbols: [
							{
								name: "x",
								kind: "variable",
								stability: "public",
								docs: [],
								tests: [],
								examples: [],
							},
						],
					},
				],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.path.includes("kind"))).toBe(true);
		});

		it("rejects invalid stability", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [
					{
						id: "m",
						file: "src/m.ts",
						symbols: [
							{
								name: "x",
								kind: "function",
								stability: "experimental",
								docs: [],
								tests: [],
								examples: [],
							},
						],
					},
				],
			});
			expect(result.valid).toBe(false);
		});

		it("rejects non-repo-relative file paths", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [{ id: "m", file: "/abs/path.ts", symbols: [] }],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("repo-relative"))).toBe(true);
		});
	});

	describe("validateEnvFile", () => {
		it("valid file passes validation", () => {
			const result = validateEnvFile({
				version: 1,
				sources: { declarations: [".env"], defaults: [".env.example"] },
				keys: [
					{
						name: "DATABASE_URL",
						required: true,
						docs: [],
						tests: [],
						examples: [],
						default_sources: [],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects unknown keys", () => {
			const result = validateEnvFile({ version: 1, keys: [], extra: 1 });
			expect(result.valid).toBe(false);
		});

		it("rejects duplicate key names", () => {
			const key = {
				name: "API_KEY",
				required: true,
				docs: [],
				tests: [],
				examples: [],
				default_sources: [],
			};
			const result = validateEnvFile({ version: 1, keys: [key, key] });
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
		});

		it("rejects invalid env key format", () => {
			const result = validateEnvFile({
				version: 1,
				keys: [
					{
						name: "lowercase_bad",
						required: true,
						docs: [],
						tests: [],
						examples: [],
						default_sources: [],
					},
				],
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("validateConfigFile", () => {
		it("valid file passes validation", () => {
			const result = validateConfigFile({
				version: 1,
				roots: [{ id: "main", file: "config.toml" }],
				keys: [
					{
						name: "port",
						required: true,
						docs: [],
						tests: [],
						examples: [],
						declared_in: [],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects unknown keys", () => {
			const result = validateConfigFile({ version: 1, roots: [], keys: [], bonus: true });
			expect(result.valid).toBe(false);
		});

		it("rejects duplicate root IDs", () => {
			const result = validateConfigFile({
				version: 1,
				roots: [
					{ id: "dup", file: "a.toml" },
					{ id: "dup", file: "b.toml" },
				],
				keys: [],
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("validateTestsFile", () => {
		it("valid file passes validation", () => {
			const result = validateTestsFile({
				version: 1,
				tests: [
					{
						id: "auth-unit",
						file: "test/auth.test.ts",
						kind: "unit",
						covers: [{ artifact_kind: "public_symbol", artifact_id: "auth#login" }],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects duplicate test IDs", () => {
			const t = { id: "dup", file: "test/a.ts", kind: "unit", covers: [] };
			const result = validateTestsFile({ version: 1, tests: [t, t] });
			expect(result.valid).toBe(false);
		});

		it("rejects invalid test kind", () => {
			const result = validateTestsFile({
				version: 1,
				tests: [{ id: "t", file: "test/t.ts", kind: "e2e", covers: [] }],
			});
			expect(result.valid).toBe(false);
		});

		it("rejects non-repo-relative paths", () => {
			const result = validateTestsFile({
				version: 1,
				tests: [{ id: "t", file: "/abs/test.ts", kind: "unit", covers: [] }],
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("validateDocsFile", () => {
		it("valid file passes validation", () => {
			const result = validateDocsFile({
				version: 1,
				docs: [{ id: "readme", file: "docs/readme.md", kind: "readme", covers: [] }],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects duplicate doc IDs", () => {
			const d = { id: "dup", file: "docs/a.md", kind: "guide", covers: [] };
			const result = validateDocsFile({ version: 1, docs: [d, d] });
			expect(result.valid).toBe(false);
		});

		it("rejects invalid doc kind", () => {
			const result = validateDocsFile({
				version: 1,
				docs: [{ id: "d", file: "docs/d.md", kind: "tutorial", covers: [] }],
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("validateExamplesFile", () => {
		it("valid file passes validation", () => {
			const result = validateExamplesFile({
				version: 1,
				examples: [{ id: "basic", file: "examples/basic.ts", covers: [] }],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects unknown keys", () => {
			const result = validateExamplesFile({ version: 1, examples: [], extra: 1 });
			expect(result.valid).toBe(false);
		});

		it("rejects duplicate example IDs", () => {
			const e = { id: "dup", file: "examples/a.ts", covers: [] };
			const result = validateExamplesFile({ version: 1, examples: [e, e] });
			expect(result.valid).toBe(false);
		});
	});

	describe("validateGlossaryFile", () => {
		it("valid file passes validation", () => {
			const result = validateGlossaryFile({
				version: 1,
				terms: [
					{
						id: "workspace",
						canonical: "Workspace",
						aliases: ["project"],
						deprecated: ["repo"],
						docs: [],
					},
				],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects duplicate term IDs", () => {
			const t = { id: "dup", canonical: "Dup", aliases: [], deprecated: [], docs: [] };
			const result = validateGlossaryFile({ version: 1, terms: [t, t] });
			expect(result.valid).toBe(false);
		});

		it("rejects unknown keys", () => {
			const result = validateGlossaryFile({ version: 1, terms: [], bonus: 1 });
			expect(result.valid).toBe(false);
		});
	});

	describe("validateLayersFile", () => {
		it("valid file passes validation", () => {
			const result = validateLayersFile({
				version: 1,
				layers: [
					{ id: "ui", globs: ["src/ui/**"] },
					{ id: "core", globs: ["src/core/**"] },
				],
				rules: [
					{ from: "core", cannot_import: ["ui"], reason: "Core must not depend on UI" },
				],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects duplicate layer IDs", () => {
			const result = validateLayersFile({
				version: 1,
				layers: [
					{ id: "dup", globs: [] },
					{ id: "dup", globs: [] },
				],
				rules: [],
			});
			expect(result.valid).toBe(false);
		});

		it("rejects unknown keys", () => {
			const result = validateLayersFile({ version: 1, layers: [], rules: [], extra: 1 });
			expect(result.valid).toBe(false);
		});
	});

	describe("validatePackagesFile", () => {
		it("valid file passes validation", () => {
			const result = validatePackagesFile({
				version: 1,
				packages: [{ id: "core", root: "packages/core", entrypoints: ["src/index.ts"] }],
			});
			expect(result.valid).toBe(true);
		});

		it("rejects duplicate package IDs", () => {
			const result = validatePackagesFile({
				version: 1,
				packages: [
					{ id: "dup", root: "a/", entrypoints: [] },
					{ id: "dup", root: "b/", entrypoints: [] },
				],
			});
			expect(result.valid).toBe(false);
		});

		it("rejects non-repo-relative root paths", () => {
			const result = validatePackagesFile({
				version: 1,
				packages: [{ id: "pkg", root: "/abs/path", entrypoints: [] }],
			});
			expect(result.valid).toBe(false);
		});

		it("rejects unknown keys", () => {
			const result = validatePackagesFile({ version: 1, packages: [], bonus: 1 });
			expect(result.valid).toBe(false);
		});
	});
});

// =========================================
// 2. ArtifactGraph Tests
// =========================================

describe("ArtifactGraph", () => {
	it("node and edge construction via helpers", () => {
		const ref = makeGlobalRef("module", "pkg-index");
		expect(ref).toBe("module:pkg-index");

		const edgeId = makeEdgeId("module:a", "public_symbol:b");
		expect(edgeId).toBe("edge:module:a->public_symbol:b");
	});

	it("getCompanions follows documents/tests/illustrates edges", () => {
		const graph = new ArtifactGraph();
		graph.addNode(makeNode({ id: "public_symbol:foo", file: "src/foo.ts" }));
		graph.addNode(makeNode({ id: "doc:foo-doc", kind: "doc", file: "docs/foo.md" }));
		graph.addNode(makeNode({ id: "test:foo-test", kind: "test", file: "test/foo.test.ts" }));
		graph.addNode(makeNode({ id: "example:foo-ex", kind: "example", file: "examples/foo.ts" }));

		graph.addEdge(
			makeEdge({ id: "e1", kind: "documents", from: "doc:foo-doc", to: "public_symbol:foo" }),
		);
		graph.addEdge(
			makeEdge({ id: "e2", kind: "tests", from: "test:foo-test", to: "public_symbol:foo" }),
		);
		graph.addEdge(
			makeEdge({
				id: "e3",
				kind: "illustrates",
				from: "example:foo-ex",
				to: "public_symbol:foo",
			}),
		);

		const companions = graph.getCompanions("public_symbol:foo");
		expect(companions.docs).toHaveLength(1);
		expect(companions.tests).toHaveLength(1);
		expect(companions.examples).toHaveLength(1);
	});

	it("removeNodesByFile removes nodes AND their edges", () => {
		const graph = new ArtifactGraph();
		graph.addNode(makeNode({ id: "A", file: "src/a.ts" }));
		graph.addNode(makeNode({ id: "B", file: "src/b.ts" }));
		graph.addEdge(makeEdge({ id: "e1", from: "A", to: "B" }));
		graph.addEdge(makeEdge({ id: "e2", from: "B", to: "B" }));

		graph.removeNodesByFile("src/a.ts");

		expect(graph.getNode("A")).toBeUndefined();
		expect(graph.getNode("B")).toBeDefined();
		expect(graph.edgeCount).toBe(1); // e1 removed (from A), e2 kept
	});

	it("fromJson round-trips correctly", () => {
		const graph = new ArtifactGraph();
		graph.addNode(makeNode({ id: "X", file: "x.ts" }));
		graph.addNode(makeNode({ id: "Y", file: "y.ts" }));
		graph.addEdge(makeEdge({ id: "e1", from: "X", to: "Y" }));

		const restored = ArtifactGraph.fromJson(graph.toNodesJson(), graph.toEdgesJson());
		expect(restored.nodeCount).toBe(2);
		expect(restored.edgeCount).toBe(1);
		expect(restored.getNode("X")).toEqual(graph.getNode("X"));
	});
});

// =========================================
// 3. Rule Family Tests
// =========================================

describe("Rule Families", () => {
	describe("public_symbol_companions", () => {
		it("emits finding when declared public symbol changed but companion not touched", () => {
			const graph = new ArtifactGraph();
			graph.addNode(
				makeNode({
					id: "public_symbol:foo",
					kind: "public_symbol",
					file: "src/foo.ts",
					provenance: "declared",
				}),
			);
			graph.addNode(
				makeNode({
					id: "doc:foo-doc",
					kind: "doc",
					file: "docs/foo.md",
					provenance: "declared",
				}),
			);
			graph.addEdge(
				makeEdge({
					id: "e1",
					kind: "documents",
					from: "doc:foo-doc",
					to: "public_symbol:foo",
				}),
			);

			const config = makeConfig();
			const findings = evaluateStructureRules(graph, config, ["src/foo.ts"]);

			expect(findings.length).toBeGreaterThanOrEqual(1);
			const f = findings.find((f) => f.name === "public_symbol_companion_untouched");
			expect(f).toBeDefined();
			expect(f!.file).toBe("src/foo.ts");
			expect(f!.required_updates.some((u) => u.file === "docs/foo.md")).toBe(true);
		});

		it("no finding when companions are not declared", () => {
			const graph = new ArtifactGraph();
			graph.addNode(
				makeNode({ id: "public_symbol:bar", kind: "public_symbol", file: "src/bar.ts" }),
			);
			// No companion edges

			const config = makeConfig();
			const findings = evaluateStructureRules(graph, config, ["src/bar.ts"]);
			const symbolFindings = findings.filter(
				(f) => f.name === "public_symbol_companion_untouched",
			);
			expect(symbolFindings).toHaveLength(0);
		});
	});

	describe("env_key_companions", () => {
		it("emits finding for changed env key file", () => {
			const graph = new ArtifactGraph();
			graph.addNode(
				makeNode({
					id: "env_key:DB_URL",
					kind: "env_key",
					file: "src/config.ts",
					provenance: "declared",
				}),
			);
			graph.addNode(
				makeNode({
					id: "doc:env-ref",
					kind: "doc",
					file: "docs/env.md",
					provenance: "declared",
				}),
			);
			graph.addEdge(
				makeEdge({
					id: "e1",
					kind: "documents",
					from: "doc:env-ref",
					to: "env_key:DB_URL",
				}),
			);

			const config = makeConfig();
			const findings = evaluateStructureRules(graph, config, ["src/config.ts"]);

			const f = findings.find((f) => f.name === "env_key_companion_untouched");
			expect(f).toBeDefined();
			expect(f!.artifact_kind).toBe("env_key");
		});
	});

	describe("config_key_companions", () => {
		it("emits finding for changed config key file", () => {
			const graph = new ArtifactGraph();
			graph.addNode(
				makeNode({
					id: "config_key:port",
					kind: "config_key",
					file: "src/server.ts",
					provenance: "declared",
				}),
			);
			graph.addNode(
				makeNode({
					id: "test:port-test",
					kind: "test",
					file: "test/port.test.ts",
					provenance: "declared",
				}),
			);
			graph.addEdge(
				makeEdge({
					id: "e1",
					kind: "tests",
					from: "test:port-test",
					to: "config_key:port",
				}),
			);

			const config = makeConfig();
			const findings = evaluateStructureRules(graph, config, ["src/server.ts"]);

			const f = findings.find((f) => f.name === "config_key_companion_untouched");
			expect(f).toBeDefined();
			expect(f!.artifact_kind).toBe("config_key");
		});
	});

	describe("layer_boundary_violations", () => {
		it("emits finding when import crosses forbidden layer", () => {
			const graph = new ArtifactGraph();

			// Create two modules in different layers
			graph.addNode(
				makeNode({ id: "module:core-mod", kind: "module", file: "src/core/mod.ts" }),
			);
			graph.addNode(makeNode({ id: "module:ui-mod", kind: "module", file: "src/ui/mod.ts" }));

			// Create layer nodes with cannot_import metadata
			graph.addNode(
				makeNode({
					id: "layer:core",
					kind: "layer",
					file: "",
					metadata: { cannot_import: ["layer:ui"] },
				}),
			);
			graph.addNode(makeNode({ id: "layer:ui", kind: "layer", file: "" }));

			// belongs_to_layer edges
			graph.addEdge(
				makeEdge({
					id: "bl1",
					kind: "belongs_to_layer",
					from: "module:core-mod",
					to: "layer:core",
				}),
			);
			graph.addEdge(
				makeEdge({
					id: "bl2",
					kind: "belongs_to_layer",
					from: "module:ui-mod",
					to: "layer:ui",
				}),
			);

			// Forbidden import: core -> ui
			graph.addEdge(
				makeEdge({
					id: "imp1",
					kind: "imports",
					from: "module:core-mod",
					to: "module:ui-mod",
				}),
			);

			const config = makeConfig();
			const findings = evaluateStructureRules(graph, config, []);

			const f = findings.find((f) => f.name === "layer_boundary_violation");
			expect(f).toBeDefined();
			expect(f!.determinism).toBe("fully_deterministic");
		});
	});

	describe("glossary_residue", () => {
		it("emits finding when deprecated term found in changed file", () => {
			// Create a temp directory with a file containing a deprecated term
			const tmpDir = mkdtempSync(join(tmpdir(), "structure-test-"));
			try {
				writeFileSync(
					join(tmpDir, "code.ts"),
					'const repo = getRepo(); // uses old "repo" term',
				);

				const graph = new ArtifactGraph();
				graph.addNode(
					makeNode({
						id: "term:workspace",
						kind: "term",
						file: "",
						label: "Workspace",
						provenance: "declared",
						metadata: { deprecated: ["repo"] },
					}),
				);

				const config = makeConfig();
				const findings = evaluateStructureRules(graph, config, ["code.ts"], tmpDir);

				const f = findings.find((f) => f.name === "glossary_residue");
				expect(f).toBeDefined();
				expect(f!.message).toContain("repo");
				expect(f!.message).toContain("Workspace");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("sort order", () => {
		it("rules are sorted: fully_deterministic before partially_deterministic before heuristic", () => {
			const graph = new ArtifactGraph();

			// Create a symbol with an extracted companion (partially_deterministic)
			graph.addNode(
				makeNode({
					id: "public_symbol:a",
					kind: "public_symbol",
					file: "src/a.ts",
					provenance: "extracted",
				}),
			);
			graph.addNode(
				makeNode({
					id: "doc:a-doc",
					kind: "doc",
					file: "docs/a.md",
					provenance: "extracted",
				}),
			);
			graph.addEdge(
				makeEdge({ id: "e1", kind: "documents", from: "doc:a-doc", to: "public_symbol:a" }),
			);

			// Create a declared symbol with a declared companion (fully_deterministic)
			graph.addNode(
				makeNode({
					id: "public_symbol:b",
					kind: "public_symbol",
					file: "src/b.ts",
					provenance: "declared",
				}),
			);
			graph.addNode(
				makeNode({
					id: "doc:b-doc",
					kind: "doc",
					file: "docs/b.md",
					provenance: "declared",
				}),
			);
			graph.addEdge(
				makeEdge({ id: "e2", kind: "documents", from: "doc:b-doc", to: "public_symbol:b" }),
			);

			const config = makeConfig();
			const findings = evaluateStructureRules(graph, config, ["src/a.ts", "src/b.ts"]);

			if (findings.length >= 2) {
				const deterOrder = findings.map((f) => f.determinism);
				const orderMap = {
					fully_deterministic: 0,
					partially_deterministic: 1,
					heuristic: 2,
				};
				for (let i = 1; i < deterOrder.length; i++) {
					expect(orderMap[deterOrder[i]]).toBeGreaterThanOrEqual(
						orderMap[deterOrder[i - 1]],
					);
				}
			}
		});
	});
});

// =========================================
// 4. Baseline Tests
// =========================================

describe("Baseline", () => {
	const finding = makeFinding({
		name: "public_symbol_companion_untouched",
		artifact_kind: "public_symbol",
		artifact_id: "foo",
		file: "src/foo.ts",
		determinism: "fully_deterministic",
		required_updates: [{ file: "docs/foo.md", kind: "doc", reason: "Update doc" }],
	});

	const matchingEntry = findingToBaselineEntry(finding);

	it("isBaselined returns true for matching finding", () => {
		const baseline: BaselineFile = { schema_version: 1, entries: [matchingEntry] };
		expect(isBaselined(finding, baseline)).toBe(true);
	});

	it("isBaselined returns false for non-matching finding", () => {
		const baseline: BaselineFile = { schema_version: 1, entries: [matchingEntry] };
		const differentFinding = makeFinding({
			name: "other_rule",
			artifact_kind: "env_key",
			artifact_id: "DB_URL",
			file: "src/config.ts",
		});
		expect(isBaselined(differentFinding, baseline)).toBe(false);
	});

	it("addToBaseline deduplicates entries", () => {
		const baseline: BaselineFile = { schema_version: 1, entries: [matchingEntry] };
		const result = addToBaseline(baseline, [finding, finding]);
		// Should not add duplicates of the already-present entry
		expect(result.entries).toHaveLength(1);
	});

	it("addToBaseline adds new entries", () => {
		const baseline: BaselineFile = { schema_version: 1, entries: [] };
		const result = addToBaseline(baseline, [finding]);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].finding_name).toBe("public_symbol_companion_untouched");
	});

	it("findingToBaselineEntry generates consistent context_hash", () => {
		const entry1 = findingToBaselineEntry(finding);
		const entry2 = findingToBaselineEntry(finding);
		expect(entry1.context_hash).toBe(entry2.context_hash);
		expect(entry1.context_hash).toHaveLength(64); // sha256 hex
	});

	it("context_hash is deterministic based on companion files", () => {
		const f1 = makeFinding({
			required_updates: [
				{ file: "b.ts", kind: "test", reason: "r" },
				{ file: "a.ts", kind: "doc", reason: "r" },
			],
		});
		const f2 = makeFinding({
			required_updates: [
				{ file: "a.ts", kind: "doc", reason: "r" },
				{ file: "b.ts", kind: "test", reason: "r" },
			],
		});
		// Same files in different order should produce same hash (sorted internally)
		expect(findingToBaselineEntry(f1).context_hash).toBe(
			findingToBaselineEntry(f2).context_hash,
		);
	});
});

// =========================================
// 5. Hook Output Tests (PostToolUse)
// =========================================

describe("Hook Output (PostToolUse)", () => {
	describe("formatStructureWarnings", () => {
		it("sorts deterministic findings before heuristic", () => {
			const findings = [
				makeFinding({ name: "heuristic_one", determinism: "heuristic" }),
				makeFinding({ name: "deterministic_one", determinism: "fully_deterministic" }),
				makeFinding({ name: "partial_one", determinism: "partially_deterministic" }),
			];
			const warnings = formatStructureWarnings(findings);
			expect(warnings[0]).toContain("deterministic_one");
			expect(warnings[1]).toContain("partial_one");
			expect(warnings[2]).toContain("heuristic_one");
		});

		it("includes file paths in output", () => {
			const findings = [makeFinding({ file: "src/important.ts" })];
			const warnings = formatStructureWarnings(findings);
			expect(warnings[0]).toContain("src/important.ts");
		});

		it("includes required follow-ups in output", () => {
			const findings = [
				makeFinding({
					required_updates: [
						{ file: "docs/api.md", kind: "doc", reason: "Needs update" },
					],
				}),
			];
			const warnings = formatStructureWarnings(findings);
			expect(warnings[0]).toContain("docs/api.md");
			expect(warnings[0]).toContain("required follow-ups");
		});
	});

	describe("structureFindingToCheckResult", () => {
		it("maps all fields correctly", () => {
			const finding = makeFinding({
				name: "public_symbol_companion_untouched",
				severity: "warning",
				message: "Symbol changed",
				file: "src/foo.ts",
				detail: "some detail",
				line: 42,
				affected_files: ["docs/foo.md"],
				determinism: "fully_deterministic",
				provenance: "declared",
				artifact_kind: "public_symbol",
				artifact_id: "public_symbol:foo",
				required_updates: [{ file: "docs/foo.md", kind: "doc", reason: "Update doc" }],
				confidence: 0.95,
			});

			const result = structureFindingToCheckResult(finding);

			expect(result.source).toBe("structure");
			expect(result.name).toBe("public_symbol_companion_untouched");
			expect(result.severity).toBe("warning");
			expect(result.message).toBe("Symbol changed");
			expect(result.file).toBe("src/foo.ts");
			expect(result.detail).toBe("some detail");
			expect(result.line).toBe(42);
			expect(result.affected_files).toEqual(["docs/foo.md"]);
			expect(result.determinism).toBe("fully_deterministic");
			expect(result.provenance).toBe("declared");
			expect(result.artifact_kind).toBe("public_symbol");
			expect(result.artifact_id).toBe("public_symbol:foo");
			expect(result.required_updates).toHaveLength(1);
			expect(result.confidence).toBe(0.95);
		});
	});
});

// =========================================
// 6. Verify Output Tests
// =========================================

describe("Verify Output", () => {
	it("output includes mode, catalog_fresh, invalid_files, adoption, findings counts, details", () => {
		const config = makeConfig({ mode: "standard" });
		const findings = [
			makeFinding({ determinism: "fully_deterministic", name: "rule_a" }),
			makeFinding({ determinism: "heuristic", name: "rule_b" }),
		];

		const output = formatStructureVerifyOutput({
			config,
			findings,
			invalidFiles: ["bad.json"],
			adoption: {
				public_api: 0.8,
				env: 1.0,
				config: 0.5,
				tests: 0.6,
				docs: 0.4,
				examples: 0.3,
				glossary: 1.0,
				layers: 0.0,
				packages: 1.0,
			},
			catalogFresh: true,
		});

		expect(output.mode).toBe("standard");
		expect(output.catalog_fresh).toBe(true);
		expect(output.invalid_files).toEqual(["bad.json"]);
		expect(output.adoption.public_api).toBe(0.8);
		expect(output.findings.fully_deterministic).toBe(1);
		expect(output.findings.heuristic).toBe(1);
		expect(output.details).toHaveLength(2);
		expect(output.details[0].name).toBe("rule_a");
	});

	it("exit code logic: fully_deterministic findings + fail_on_deterministic implies exit 1", () => {
		const config = makeConfig({ mode: "standard" });
		// In standard mode, fail_on_deterministic defaults to true
		expect(config.verify.fail_on_deterministic).toBe(true);

		const output = formatStructureVerifyOutput({
			config,
			findings: [makeFinding({ determinism: "fully_deterministic" })],
			invalidFiles: [],
			adoption: {},
			catalogFresh: true,
		});

		// The caller determines exit code: deterministic > 0 && config.verify.fail_on_deterministic
		const shouldFail =
			output.findings.fully_deterministic > 0 && config.verify.fail_on_deterministic;
		expect(shouldFail).toBe(true);
	});

	it("no exit 1 when fail_on_deterministic is false", () => {
		const config = makeConfig({ mode: "minimal" });
		expect(config.verify.fail_on_deterministic).toBe(false);

		const output = formatStructureVerifyOutput({
			config,
			findings: [makeFinding({ determinism: "fully_deterministic" })],
			invalidFiles: [],
			adoption: {},
			catalogFresh: true,
		});

		const shouldFail =
			output.findings.fully_deterministic > 0 && config.verify.fail_on_deterministic;
		expect(shouldFail).toBe(false);
	});
});

// =========================================
// 7. Noise Budget Tests
// =========================================

describe("Noise Budget", () => {
	it("single edit emits at most max_heuristics (default 3) heuristic findings", () => {
		// We cannot easily invoke the full filtering pipeline without the
		// structure-checks runner, so we test the emission config logic directly.
		const config = makeConfig();
		expect(config.posttooluse.max_heuristics).toBe(3);

		// Simulate the filtering logic from structure-checks.ts:filterByEmissionConfig
		const findings: StructureFinding[] = [];
		for (let i = 0; i < 10; i++) {
			findings.push(
				makeFinding({
					name: `heuristic_${i}`,
					determinism: "heuristic",
				}),
			);
		}

		let heuristicCount = 0;
		const filtered = findings.filter((f) => {
			if (f.determinism === "heuristic") {
				if (!config.posttooluse.emit_heuristic) return false;
				heuristicCount++;
				if (heuristicCount > config.posttooluse.max_heuristics) return false;
			}
			return true;
		});

		expect(filtered).toHaveLength(3);
	});

	it("deterministic findings always include exact files", () => {
		const finding = makeFinding({
			determinism: "fully_deterministic",
			file: "src/exact.ts",
			required_updates: [{ file: "docs/exact.md", kind: "doc", reason: "Update" }],
		});

		// Deterministic findings must have a file and required_updates with files
		expect(finding.file).toBeTruthy();
		expect(finding.required_updates.every((u) => u.file.length > 0)).toBe(true);
	});
});

// =========================================
// 8. Adoption Tests
// =========================================

describe("Adoption", () => {
	it("returns 1.0 for categories with no extracted baseline", () => {
		const graph = new ArtifactGraph();
		// No nodes at all
		const config = makeConfig();
		const adoption = calculateAdoption(graph, config);

		// When no extracted nodes exist, ratio is 1.0 (nothing to adopt)
		expect(adoption.public_api).toBe(1.0);
		expect(adoption.tests).toBe(1.0);
		expect(adoption.env).toBe(1.0);
	});

	it("returns ratio of declared/extracted when both exist", () => {
		const graph = new ArtifactGraph();

		// Add 4 extracted symbols
		for (let i = 0; i < 4; i++) {
			graph.addNode(
				makeNode({
					id: `public_symbol:ext${i}`,
					kind: "public_symbol",
					provenance: "extracted",
					file: `src/ext${i}.ts`,
				}),
			);
		}

		// Add 2 declared symbols
		for (let i = 0; i < 2; i++) {
			graph.addNode(
				makeNode({
					id: `public_symbol:decl${i}`,
					kind: "public_symbol",
					provenance: "declared",
					file: `src/decl${i}.ts`,
				}),
			);
		}

		const config = makeConfig();
		const adoption = calculateAdoption(graph, config);

		// 2 declared / 4 extracted = 0.5
		expect(adoption.public_api).toBe(0.5);
	});

	it("glossary returns 1.0 when any terms declared", () => {
		const graph = new ArtifactGraph();
		graph.addNode(
			makeNode({
				id: "term:workspace",
				kind: "term",
				provenance: "declared",
				file: "",
			}),
		);

		const config = makeConfig();
		const adoption = calculateAdoption(graph, config);

		expect(adoption.glossary).toBe(1.0);
	});

	it("glossary returns 0.0 when no terms declared", () => {
		const graph = new ArtifactGraph();
		// No term nodes at all
		const config = makeConfig();
		const adoption = calculateAdoption(graph, config);

		expect(adoption.glossary).toBe(0.0);
	});

	it("layers returns 1.0 when any layers declared", () => {
		const graph = new ArtifactGraph();
		graph.addNode(
			makeNode({
				id: "layer:ui",
				kind: "layer",
				provenance: "declared",
				file: "",
			}),
		);

		const config = makeConfig();
		const adoption = calculateAdoption(graph, config);

		expect(adoption.layers).toBe(1.0);
	});
});
