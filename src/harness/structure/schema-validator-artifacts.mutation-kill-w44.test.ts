import { describe, expect, it } from "vitest";
import {
	validateConfigFile,
	validateEnvFile,
	validateGlossaryFile,
	validateLayersFile,
	validatePublicApiFile,
} from "./schema-validator-artifacts.js";
import { VALID_STABILITY, VALID_SYMBOL_KINDS } from "./types.js";

function findError(errors: { path: string; message: string }[], path: string) {
	return errors.find((e) => e.path === path);
}

describe("validatePublicApiFile — symbol kind/stability join(\", \") (mutant 8fd708c4, 054bec73)", () => {
	// test-contract: public-api — validatePublicApiFile error message format for invalid symbol kind
	it("P1: kind error message joins VALID_SYMBOL_KINDS with a comma+space", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "mod",
					file: "src/mod.ts",
					symbols: [{ name: "x", kind: "bogus", stability: "public", docs: [], tests: [], examples: [] }],
				},
			],
		});
		const e = findError(result.errors, "$.modules[0].symbols[0].kind");
		expect(e).toBeDefined();
		// If ", " were mutated to "" the joined list would have no separators at all.
		expect(e?.message).toBe(`Must be one of: ${VALID_SYMBOL_KINDS.join(", ")}`);
		expect(e?.message).toContain(", ");
		expect(e?.message).not.toContain("functionclass");
	});

	// test-contract: public-api — validatePublicApiFile error message format for invalid symbol stability
	it("P2: stability error message joins VALID_STABILITY with a comma+space", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "mod",
					file: "src/mod.ts",
					symbols: [{ name: "x", kind: "function", stability: "bogus", docs: [], tests: [], examples: [] }],
				},
			],
		});
		const e = findError(result.errors, "$.modules[0].symbols[0].stability");
		expect(e).toBeDefined();
		expect(e?.message).toBe(`Must be one of: ${VALID_STABILITY.join(", ")}`);
		expect(e?.message).toContain(", ");
		expect(e?.message).not.toContain("publicbeta");
	});
});

describe("validateEnvFile — sources block (mutants 2432495245f2f3d2, 0fba892e2136e9a3, 0f8c8ec7, 1fca71a4, 6d902d83, 232bdc5f)", () => {
	// test-contract: public-api — validateEnvFile flags unknown keys nested under $.sources
	it("P1: an unknown key inside sources is reported at path $.sources.<key> (kills BlockStatement + StringLiteral \"$.sources\")", () => {
		const result = validateEnvFile({
			version: 1,
			sources: { bogus_key: 1 },
			keys: [],
		});
		// If the block body were replaced with {} this error would never appear.
		const e = findError(result.errors, "$.sources.bogus_key");
		expect(e).toBeDefined();
		expect(e?.message).toBe('Unknown key "bogus_key"');
	});

	// test-contract: public-api — validateEnvFile treats an absent sources.declarations as the empty-array default
	it("P2: sources.declarations defaults to [] when absent — no 'must be an array' error (kills declarations || [] -> && [])", () => {
		const result = validateEnvFile({
			version: 1,
			sources: {},
			keys: [],
		});
		// With `&& []`, `undefined && []` is undefined, which fails the array check.
		expect(findError(result.errors, "$.sources.declarations")).toBeUndefined();
	});

	// test-contract: public-api — validateEnvFile treats an absent sources.defaults as the empty-array default
	it("P3: sources.defaults defaults to [] when absent — no 'must be an array' error (kills defaults || [] -> && [])", () => {
		const result = validateEnvFile({
			version: 1,
			sources: {},
			keys: [],
		});
		expect(findError(result.errors, "$.sources.defaults")).toBeUndefined();
	});

	// test-contract: public-api — validateEnvFile rejects duplicate entries in sources.declarations
	it("P4: duplicate entries in sources.declarations are reported at $.sources.declarations", () => {
		const result = validateEnvFile({
			version: 1,
			sources: { declarations: ["a", "a"] },
			keys: [],
		});
		const e = findError(result.errors, "$.sources.declarations");
		expect(e).toBeDefined();
		expect(e?.message).toBe("Array must not contain duplicates");
	});

	// test-contract: public-api — validateEnvFile rejects duplicate entries in sources.defaults
	it("P5: duplicate entries in sources.defaults are reported at $.sources.defaults", () => {
		const result = validateEnvFile({
			version: 1,
			sources: { defaults: ["b", "b"] },
			keys: [],
		});
		const e = findError(result.errors, "$.sources.defaults");
		expect(e).toBeDefined();
		expect(e?.message).toBe("Array must not contain duplicates");
	});
});

describe("validateEnvFile — keys[] allowed field names (mutants c9f90f17, 73e53977, f7afedc6, ee244ad0)", () => {
	// test-contract: public-api — validateEnvFile accepts docs/tests/examples/default_sources as allowed key fields
	it("P1: a fully populated, valid key entry produces zero errors", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [
				{
					name: "FOO_BAR",
					required: true,
					docs: ["doc.md"],
					tests: ["test.ts"],
					examples: ["ex.ts"],
					default_sources: ["env"],
				},
			],
		});
		// If "docs"/"tests"/"examples"/"default_sources" were mutated to "" in the
		// allowed-keys list, each of those fields would spuriously report as unknown.
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("validateConfigFile — keys[] allowed field names (mutants 8046289126168c9c, a2f6eee2, 3e5f59e9, 3ad8747f)", () => {
	// test-contract: public-api — validateConfigFile accepts docs/tests/examples/declared_in as allowed key fields
	it("P1: a fully populated, valid key entry produces zero errors", () => {
		const result = validateConfigFile({
			version: 1,
			keys: [
				{
					name: "foo.bar",
					required: true,
					docs: ["doc.md"],
					tests: ["test.ts"],
					examples: ["ex.ts"],
					declared_in: ["root"],
				},
			],
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("validateGlossaryFile — alias/deprecated collision registration (mutants d3fc4bf30e57c661, 0a0db0110eccc5e3)", () => {
	// test-contract: public-api — validateGlossaryFile's alias registration is empty when aliases is absent
	it("P1: when aliases is absent, no phantom \"stryker was here\" alias is registered to collide with a later term", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [
				{ id: "term_one", canonical: "First Term" },
				{ id: "term_two", canonical: "Stryker was here" },
			],
		});
		// If `(t.aliases as string[]) || []` were mutated to `|| ["Stryker was here"]`,
		// the first term's alias loop would iterate once, registering
		// "stryker was here" into allCanonicals — causing the second term's
		// canonical to collide.
		const collision = result.errors.find((e) => e.message.includes("collides"));
		expect(collision).toBeUndefined();
		expect(result.valid).toBe(true);
	});

	// test-contract: public-api — validateGlossaryFile's deprecated-alias registration is empty when deprecated is absent
	it("P2: when deprecated is absent, no phantom \"stryker was here\" deprecated alias is registered to collide with a later term", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [
				{ id: "term_one", canonical: "First Term" },
				{ id: "term_two", canonical: "Stryker was here" },
			],
		});
		const collision = result.errors.find((e) => e.message.includes("collides"));
		expect(collision).toBeUndefined();
		expect(result.valid).toBe(true);
	});
});

describe("validateGlossaryFile — checkUnknownKeys allowed \"docs\" field (mutant 05a24a19)", () => {
	// test-contract: public-api — validateGlossaryFile accepts docs as an allowed term field
	it("P1: a term with a docs field present is valid", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [{ id: "term_one", canonical: "First Term", docs: ["doc.md"] }],
		});
		expect(findError(result.errors, "$.terms[0].docs")).toBeUndefined();
		expect(result.valid).toBe(true);
	});
});

describe("validateLayersFile — layers.globs field (mutant c0f9ca4b)", () => {
	// test-contract: public-api — validateLayersFile accepts a valid globs array without error
	it("P1: a layer with a valid globs array produces no error at .globs", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: ["src/**"] }],
			rules: [],
		});
		expect(findError(result.errors, "$.layers[0].globs")).toBeUndefined();
		expect(result.valid).toBe(true);
	});
});
