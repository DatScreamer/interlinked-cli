// ===========================================
// section-table-batches fragment tests
// ===========================================

import { describe, expect, it } from "vitest";
import { batchSections } from "./section-table-batches.js";

describe("batchSections", () => {
	it("is non-empty", () => {
		expect(batchSections.length).toBeGreaterThan(0);
	});

	it("each entry has well-formed, non-empty fields", () => {
		for (const spec of batchSections) {
			expect(typeof spec.label).toBe("string");
			expect(spec.label.length).toBeGreaterThan(0);
			expect(typeof spec.key).toBe("string");
			expect(spec.key.length).toBeGreaterThan(0);
			expect(typeof spec.noun).toBe("string");
			expect(spec.noun.length).toBeGreaterThan(0);
			expect(typeof spec.passLabel).toBe("string");
			expect(spec.passLabel.length).toBeGreaterThan(0);
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("pins skip ids for every section that declares one", () => {
		const byKey = new Map(batchSections.map((spec) => [spec.key, spec]));
		expect(byKey.get("introvertedTest")?.skipId).toBe("introverted_test");
		expect(byKey.get("procfsProbeInTest")?.skipId).toBe("procfs_probe_in_test");
	});

	it("opens with the Batch 1 agent-laziness checks", () => {
		expect(batchSections[0]?.key).toBe("agentThumbprintProse");
		expect(batchSections.map((s) => s.key)).toContain("stubNotImplementedThrow");
	});

	it("pins explicit skip ids for labels that do not normalize to check ids", () => {
		const byKey = new Map(batchSections.map((spec) => [spec.key, spec]));
		expect(byKey.get("mockOnlyTest")?.skipId).toBe("mock_only_test");
		expect(byKey.get("happyPathOnlyTest")?.skipId).toBe("happy_path_only_test");
	});

	it("carries the Phase B endpoint-security pack and ends on mass assignment", () => {
		const keys = batchSections.map((s) => s.key);
		expect(keys).toContain("endpointAuthMissing");
		expect(keys).toContain("endpointSsrfShape");
		expect(batchSections.at(-1)?.key).toBe("endpointMassAssignment");
	});
});
