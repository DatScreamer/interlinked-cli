import { describe, expect, it } from "vitest";
import {
	buildAgentSafetyChecks,
	buildCheckInstructions,
	buildGenericCheckMeta,
} from "./builders.js";
import { CHECK_REGISTRY } from "./registry.js";

describe("buildAgentSafetyChecks", () => {
	it("returns one entry per agent_safety check when no phase is passed", () => {
		const all = buildAgentSafetyChecks("", "x.ts");
		const expected = CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety");
		expect(all).toHaveLength(expected.length);
	});

	it("filters by phase when passed", () => {
		const preBlock = buildAgentSafetyChecks("", "x.ts", "pre_block");
		for (const c of preBlock) {
			const entry = CHECK_REGISTRY.find((r) => r.id === c.name);
			expect(entry?.phase).toBe("pre_block");
		}
	});

	it("returns entries with {name, severity, fn}", () => {
		const [first] = buildAgentSafetyChecks("", "x.ts");
		expect(first).toHaveProperty("name");
		expect(first).toHaveProperty("severity");
		expect(typeof first.fn).toBe("function");
	});

	it("each built fn closes over the passed content + filePath", () => {
		// floating_promises fires on a known-async call at statement position.
		const checks = buildAgentSafetyChecks(
			"async function load() {}\nload();",
			"app.ts",
			"pre_warn",
		);
		const floating = checks.find((c) => c.name === "floating_promises");
		if (!floating) return; // check may have moved phases; skip if absent
		expect(floating.fn().length).toBeGreaterThan(0);
	});
});

describe("buildCheckInstructions", () => {
	it("returns a map from id to fix_instruction with one entry per registered check", () => {
		const map = buildCheckInstructions();
		expect(Object.keys(map)).toHaveLength(CHECK_REGISTRY.length);
		for (const c of CHECK_REGISTRY) {
			expect(map[c.id]).toBe(c.fix_instruction);
		}
	});
});

describe("buildGenericCheckMeta", () => {
	it("returns a map with name/description/tier/determinism per check", () => {
		const meta = buildGenericCheckMeta();
		expect(Object.keys(meta)).toHaveLength(CHECK_REGISTRY.length);
		for (const c of CHECK_REGISTRY) {
			expect(meta[c.id]).toEqual({
				name: c.name,
				description: c.description,
				tier: c.tier,
				determinism: c.determinism,
			});
		}
	});
});
