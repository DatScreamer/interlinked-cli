import { describe, expect, it } from "vitest";
import {
	validateArtifactFile,
	validateEnvFile,
	validatePublicApiFile,
	validateStructureJson,
} from "./schema-validator.js";

describe("validateStructureJson", () => {
	it("accepts a minimal valid structure", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: {},
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects unknown top-level keys", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			unknownProp: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unknown key"))).toBe(true);
	});

	it("rejects invalid mode values", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "bogus",
		});
		expect(result.valid).toBe(false);
	});

	it("rejects missing version", () => {
		const result = validateStructureJson({ mode: "minimal" });
		expect(result.valid).toBe(false);
	});

	it("rejects a non-object payload", () => {
		expect(validateStructureJson("not an object").valid).toBe(false);
		expect(validateStructureJson(null).valid).toBe(false);
		expect(validateStructureJson([]).valid).toBe(false);
	});
});

describe("validatePublicApiFile", () => {
	it("accepts a valid public-api file", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "foo",
					file: "src/foo.ts",
					symbols: [
						{
							name: "foo",
							kind: "function",
							stability: "public",
							docs: ["docs/foo.md"],
							tests: [],
							examples: [],
						},
					],
				},
			],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects unknown keys on a module entry", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "foo",
					file: "src/foo.ts",
					symbols: [],
					badKey: true,
				},
			],
		});
		expect(result.valid).toBe(false);
	});
});

describe("validateEnvFile", () => {
	it("accepts a valid env file", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [{ name: "VALID_KEY", required: true, docs: [], tests: [], examples: [] }],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects an env key that doesn't match UPPER_SNAKE_CASE", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [{ name: "lowercase", required: true, docs: [], tests: [], examples: [] }],
		});
		expect(result.valid).toBe(false);
	});
});

describe("validateArtifactFile dispatch", () => {
	it("routes to the right validator based on key", () => {
		const ok = validateArtifactFile("env", {
			version: 1,
			keys: [],
		});
		expect(ok.valid).toBe(true);
		const bad = validateArtifactFile("env", { not: "valid" });
		expect(bad.valid).toBe(false);
	});
});
