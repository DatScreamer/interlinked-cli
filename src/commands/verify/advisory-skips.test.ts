// ===========================================
// advisory-skips unit tests (moved from advisory.test.ts with the functions)
// ===========================================

import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISORY_SKIPS, TOOL_IDS } from "./advisory.js";
import { getEffectiveSkipChecks, getSkipTools } from "./advisory-skips.js";

describe("getEffectiveSkipChecks", () => {
	it("includes every advisory default when --all-checks is off", () => {
		const skip = getEffectiveSkipChecks(undefined, false);
		for (const id of DEFAULT_ADVISORY_SKIPS) expect(skip.has(id)).toBe(true);
	});

	it("returns only the CLI list when --all-checks is on", () => {
		const skip = getEffectiveSkipChecks("Knip, complexity ", true);
		expect(skip).toEqual(new Set(["knip", "complexity"]));
	});

	it("merges, trims, and lowercases the CLI --skip list", () => {
		const skip = getEffectiveSkipChecks(" TSC ,, biome ", false);
		expect(skip.has("tsc")).toBe(true);
		expect(skip.has("biome")).toBe(true);
		expect(skip.has("")).toBe(false);
	});

	it("returns an empty set for no args under --all-checks", () => {
		expect(getEffectiveSkipChecks(undefined, true)).toEqual(new Set());
	});
});

describe("getSkipTools", () => {
	it("keeps only known tool ids", () => {
		const tools = getSkipTools(new Set(["tsc", "complexity", "nonsense"]));
		expect(tools).toEqual(["tsc"]);
	});

	it("passes through every tool id and nothing else", () => {
		const all = getSkipTools(new Set([...TOOL_IDS, "cognitive_complexity"]));
		expect([...all].sort()).toEqual([...TOOL_IDS].sort());
	});

	it("returns empty for an empty skip set", () => {
		expect(getSkipTools(new Set())).toEqual([]);
	});
});
