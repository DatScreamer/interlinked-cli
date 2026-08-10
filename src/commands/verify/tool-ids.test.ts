import { describe, expect, it } from "vitest";
import { TOOL_IDS } from "./tool-ids.js";

describe("TOOL_IDS", () => {
	it("P1: contains the core external verifiers", () => {
		expect(TOOL_IDS).toContain("tsc");
		expect(TOOL_IDS).toContain("biome");
		expect(TOOL_IDS).toContain("gitleaks");
	});

	it("P2: ids are unique and kebab/lower-case", () => {
		expect(new Set(TOOL_IDS).size).toBe(TOOL_IDS.length);
		for (const id of TOOL_IDS) expect(id).toMatch(/^[a-z0-9-]+$/);
	});
});
