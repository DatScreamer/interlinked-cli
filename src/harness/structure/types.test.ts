import { describe, expect, it } from "vitest";
import {
	DEFAULT_ADOPTION_THRESHOLDS,
	DEFAULT_BUILTINS,
	ENV_KEY_PATTERN,
	LOCAL_ID_PATTERN,
	MODE_DEFAULTS,
	VALID_ARTIFACT_KINDS,
	VALID_DOC_KINDS,
	VALID_MODES,
	VALID_STABILITY,
	VALID_SYMBOL_KINDS,
	VALID_TEST_KINDS,
} from "./types.js";

describe("structure types (constants)", () => {
	it("VALID_MODES enumerates the three structure modes", () => {
		expect(VALID_MODES).toEqual(["minimal", "standard", "strict"]);
	});

	it("MODE_DEFAULTS has an entry for every valid mode", () => {
		for (const m of VALID_MODES) {
			expect(MODE_DEFAULTS[m]).toBeTruthy();
		}
	});

	it("VALID_ARTIFACT_KINDS includes the core artifact kinds", () => {
		expect(VALID_ARTIFACT_KINDS).toContain("public_symbol");
		expect(VALID_ARTIFACT_KINDS).toContain("env_key");
		expect(VALID_ARTIFACT_KINDS).toContain("doc");
		expect(VALID_ARTIFACT_KINDS).toContain("test");
	});

	it("VALID_SYMBOL_KINDS / VALID_STABILITY / VALID_DOC_KINDS / VALID_TEST_KINDS are non-empty", () => {
		expect(VALID_SYMBOL_KINDS.length).toBeGreaterThan(0);
		expect(VALID_STABILITY.length).toBeGreaterThan(0);
		expect(VALID_DOC_KINDS.length).toBeGreaterThan(0);
		expect(VALID_TEST_KINDS.length).toBeGreaterThan(0);
	});

	it("DEFAULT_ADOPTION_THRESHOLDS is a record of numeric thresholds", () => {
		for (const v of Object.values(DEFAULT_ADOPTION_THRESHOLDS)) {
			expect(typeof v).toBe("number");
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it("DEFAULT_BUILTINS has every rule family as a boolean flag", () => {
		for (const [name, enabled] of Object.entries(DEFAULT_BUILTINS)) {
			expect(typeof enabled, `${name} flag`).toBe("boolean");
		}
	});

	it("LOCAL_ID_PATTERN accepts valid identifiers", () => {
		expect(LOCAL_ID_PATTERN.test("foo")).toBe(true);
		expect(LOCAL_ID_PATTERN.test("foo_bar.baz-0")).toBe(true);
	});

	it("LOCAL_ID_PATTERN rejects invalid identifiers", () => {
		expect(LOCAL_ID_PATTERN.test("")).toBe(false);
		expect(LOCAL_ID_PATTERN.test("has spaces")).toBe(false);
	});

	it("ENV_KEY_PATTERN accepts UPPER_SNAKE_CASE", () => {
		expect(ENV_KEY_PATTERN.test("SAMPLE_FLAG")).toBe(true);
		expect(ENV_KEY_PATTERN.test("A_1_B")).toBe(true);
	});

	it("ENV_KEY_PATTERN rejects lowercase or mixed", () => {
		expect(ENV_KEY_PATTERN.test("lower")).toBe(false);
		expect(ENV_KEY_PATTERN.test("MixedCase")).toBe(false);
	});
});
