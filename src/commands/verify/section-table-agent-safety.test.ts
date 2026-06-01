// ===========================================
// section-table-agent-safety fragment tests
// ===========================================

import { describe, expect, it } from "vitest";
import { agentSafetySections } from "./section-table-agent-safety.js";

describe("agentSafetySections", () => {
	it("is non-empty", () => {
		expect(agentSafetySections.length).toBeGreaterThan(0);
	});

	it("each entry has well-formed fields", () => {
		for (const spec of agentSafetySections) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("opens with the agent-safety promise checks", () => {
		expect(agentSafetySections[0]?.key).toBe("misusedPromises");
		expect(agentSafetySections.map((s) => s.key)).toContain("floatingPromises");
	});

	it("carries the Mythos comment-drift detectors", () => {
		const keys = agentSafetySections.map((s) => s.key);
		expect(keys).toContain("commentClaimsLimitNoGuard");
		expect(keys).toContain("commentClaimsThrowsDoesnt");
	});

	it("ends with the project-wide LOC ratio taste check", () => {
		expect(agentSafetySections.at(-1)?.key).toBe("projectLocRatio");
	});
});
