import { describe, expect, it } from "vitest";
import {
	validateConfigFile,
	validateEnvFile,
	validateGlossaryFile,
	validateLayersFile,
	validatePublicApiFile,
} from "./schema-validator-artifacts.js";

function errorAt(
	result: { errors: Array<{ path: string; message: string }> },
	path: string,
): { path: string; message: string } | undefined {
	return result.errors.find((error) => error.path === path);
}

describe("schema-validator-artifacts mutation boundaries", () => {
	describe("public_api", () => {
		it("validates symbol enum values and each companion-array path", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [
					{
						id: "mod-a",
						file: "src/a.ts",
						symbols: [
							{
								name: "run",
								kind: "not-a-kind",
								stability: "not-a-stability",
								docs: [1],
								tests: [2],
								examples: [3],
							},
						],
					},
				],
			});

			expect(errorAt(result, "$.modules[0].symbols[0].kind")?.message).toContain(
				"Must be one of",
			);
			expect(errorAt(result, "$.modules[0].symbols[0].stability")?.message).toContain(
				"Must be one of",
			);
			expect(errorAt(result, "$.modules[0].symbols[0].docs[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.modules[0].symbols[0].tests[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.modules[0].symbols[0].examples[0]")?.message).toBe(
				"Must be a string",
			);
		});

		it("rejects duplicate and invalid module IDs and non-relative module files", () => {
			const result = validatePublicApiFile({
				version: 1,
				modules: [
					{ id: "bad:id", file: "src/a.ts", symbols: [] },
					{ id: "mod-a", file: "../outside.ts", symbols: [] },
					{ id: "mod-a", file: "src/c.ts", symbols: [] },
				],
			});

			expect(errorAt(result, "$.modules[0].id")?.message).toContain("Invalid local ID");
			expect(errorAt(result, "$.modules[1].file")?.message).toBe(
				"Must be a repo-relative POSIX path",
			);
			expect(errorAt(result, "$.modules[2].id")?.message).toContain("Duplicate module ID");
		});

		it("reports unknown top-level keys at the root path", () => {
			const result = validatePublicApiFile({ version: 1, modules: [], unexpected: true });
			expect(errorAt(result, "$.unexpected")?.message).toBe('Unknown key "unexpected"');
		});
	});

	describe("env", () => {
		it("distinguishes null and non-object payloads and reports the root path", () => {
			for (const data of [null, "not an object", []]) {
				const result = validateEnvFile(data);
				expect(result.valid).toBe(false);
				expect(errorAt(result, "$")?.message).toBe("Must be a JSON object");
			}
			const unknown = validateEnvFile({ version: 1, keys: [], unexpected: true });
			expect(errorAt(unknown, "$.unexpected")?.message).toBe('Unknown key "unexpected"');
		});

		it("validates version, sources object shape, and keys array shape", () => {
			expect(errorAt(validateEnvFile({ version: 2, keys: [] }), "$.version")?.message).toBe(
				"Must be 1",
			);
			for (const sources of [null, "nope", []]) {
				const result = validateEnvFile({ version: 1, sources, keys: [] });
				expect(errorAt(result, "$.sources")?.message).toBe("Must be an object");
			}
			const validSources = validateEnvFile({
				version: 1,
				sources: { declarations: [".env"], defaults: [".env.example"] },
				keys: [],
			});
			expect(validSources.valid).toBe(true);
			const badKeys = validateEnvFile({ version: 1, keys: "nope" });
			expect(errorAt(badKeys, "$.keys")?.message).toBe("Must be an array");
		});

		it("checks env key names, duplicates, and every optional array path", () => {
			const result = validateEnvFile({
				version: 1,
				keys: [
					{
						name: "bad-name",
						required: true,
						docs: [1],
						tests: [2],
						examples: [3],
						default_sources: [4],
					},
					{name: "GOOD_KEY", required: false},
					{name: "GOOD_KEY", required: false},
				],
			});

			expect(errorAt(result, "$.keys[0].name")?.message).toContain("Must match");
			expect(errorAt(result, "$.keys[0].docs[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[0].tests[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[0].examples[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[0].default_sources[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[2].name")?.message).toContain("Duplicate key name");
		});
	});

	describe("config", () => {
		it("rejects null and primitive payloads with a root error", () => {
			for (const data of [null, "nope", []]) {
				const result = validateConfigFile(data);
				expect(errorAt(result, "$")?.message).toBe("Must be a JSON object");
			}
			const unknown = validateConfigFile({ version: 1, keys: [], unexpected: true });
			expect(errorAt(unknown, "$.unexpected")?.message).toBe('Unknown key "unexpected"');
		});

		it("validates root IDs, duplicate roots, and key name types", () => {
			const result = validateConfigFile({
				version: 1,
				roots: [
					{id: 7, file: "config.json"},
					{id: "bad:id", file: "config.json"},
					{id: "root-a", file: "config.json"},
					{id: "root-a", file: "config.json"},
				],
				keys: [{ name: 7, required: true }],
			});
			expect(errorAt(result, "$.roots[0].id")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.roots[1].id")?.message).toContain("Invalid local ID");
			expect(errorAt(result, "$.roots[3].id")?.message).toContain("Duplicate root ID");
			expect(errorAt(result, "$.keys[0].name")?.message).toBe("Must be a non-empty string");
		});

		it("checks each optional key-array path", () => {
			const result = validateConfigFile({
				version: 1,
				keys: [
					{
						name: "port",
						required: true,
						docs: [1],
						tests: [2],
						examples: [3],
						declared_in: [4],
					},
				],
			});
			expect(errorAt(result, "$.keys[0].docs[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[0].tests[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[0].examples[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.keys[0].declared_in[0]")?.message).toBe("Must be a string");
		});
	});

	describe("glossary", () => {
		it("rejects null and reports unknown top-level keys at the root", () => {
			const nullResult = validateGlossaryFile(null);
			expect(errorAt(nullResult, "$")?.message).toBe("Must be a JSON object");
			const unknown = validateGlossaryFile({ version: 1, terms: [], unexpected: true });
			expect(errorAt(unknown, "$.unexpected")?.message).toBe('Unknown key "unexpected"');
		});

		it("checks term ID/canonical boundaries and optional array paths", () => {
			const result = validateGlossaryFile({
				version: 1,
				terms: [
					{id: "bad:id", canonical: "Widget", aliases: "bad", deprecated: "old", docs: [3]},
					{id: "term-b", canonical: 7},
					{id: "term-b", canonical: "Gadget"},
				],
			});
			expect(errorAt(result, "$.terms[0].id")?.message).toContain("Invalid local ID");
			expect(errorAt(result, "$.terms[0].aliases")?.message).toBe("Must be an array");
			expect(errorAt(result, "$.terms[0].deprecated")?.message).toBe("Must be an array");
			expect(errorAt(result, "$.terms[0].docs[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.terms[1].canonical")?.message).toBe("Must be a non-empty string");
			expect(errorAt(result, "$.terms[2].id")?.message).toContain("Duplicate term ID");
		});

		it("accepts non-colliding aliases and deprecated names", () => {
			const result = validateGlossaryFile({
				version: 1,
				terms: [
					{ id: "term-a", canonical: "Widget" },
					{ id: "term-b", canonical: "Gadget", aliases: ["Gizmo"], deprecated: ["OldWidget"] },
				],
			});
			expect(result.valid).toBe(true);
		});
	});

	describe("layers", () => {
		it("rejects null and primitive payloads and reports root unknown keys", () => {
			for (const data of [null, "nope", []]) {
				const result = validateLayersFile(data);
				expect(errorAt(result, "$")?.message).toBe("Must be a JSON object");
			}
			const unknown = validateLayersFile({ version: 1, layers: [], rules: [], unexpected: true });
			expect(errorAt(unknown, "$.unexpected")?.message).toBe('Unknown key "unexpected"');
		});

		it("checks layer IDs, duplicate declarations, omitted globs, and glob paths", () => {
			const omitted = validateLayersFile({
				version: 1,
				layers: [{ id: "core" }],
				rules: [],
			});
			expect(omitted.valid).toBe(true);

			const result = validateLayersFile({
				version: 1,
				layers: [
					{id: "bad:id", globs: [1]},
					{id: "core", globs: []},
					{id: "core", globs: []},
				],
				rules: [],
			});
			expect(errorAt(result, "$.layers[0].id")?.message).toContain("Invalid local ID");
			expect(errorAt(result, "$.layers[0].globs[0]")?.message).toBe("Must be a string");
			expect(errorAt(result, "$.layers[2].id")?.message).toContain("Duplicate layer ID");
		});

		it("distinguishes a non-string reason from the exact 160-character boundary", () => {
			const nonString = validateLayersFile({
				version: 1,
				layers: [{ id: "core", globs: [] }],
				rules: [{ from: "core", cannot_import: [], reason: 7 }],
			});
			expect(errorAt(nonString, "$.rules[0].reason")?.message).toBe("Must be a non-empty string");

			const exact = validateLayersFile({
				version: 1,
				layers: [{ id: "core", globs: [] }],
				rules: [{ from: "core", cannot_import: [], reason: "x".repeat(160) }],
			});
			expect(exact.valid).toBe(true);
		});
	});
});
