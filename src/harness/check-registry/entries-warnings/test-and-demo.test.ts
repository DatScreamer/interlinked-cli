import { describe, expect, it } from "vitest";
import { TEST_AND_DEMO_ENTRIES } from "./test-and-demo.js";

describe("TEST_AND_DEMO_ENTRIES", () => {
	it("is non-empty", () => {
		expect(TEST_AND_DEMO_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of TEST_AND_DEMO_ENTRIES) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase + warning severity", () => {
		for (const c of TEST_AND_DEMO_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
			expect(c.severity, `${c.id} severity`).toBe("warning");
		}
	});

	it("every entry has the required metadata fields populated", () => {
		for (const c of TEST_AND_DEMO_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
		}
	});

	it("includes the Batch 2 test-hygiene checks", () => {
		const ids = new Set(TEST_AND_DEMO_ENTRIES.map((c) => c.id));
		for (const expected of [
			"duplicate_test_names",
			"real_io_in_tests",
			"test_nondeterminism",
			"hardcoded_timeout_in_tests",
			"test_missing_sut_import",
			"mocking_the_sut_self",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("includes the Batch 5 cross-file and Batch 8 demo-data checks", () => {
		const ids = new Set(TEST_AND_DEMO_ENTRIES.map((c) => c.id));
		for (const expected of [
			"empty_body_handler",
			"listener_pairing",
			"schema_type_drift",
			"migration_parity",
			"demo_data_unmarked",
			"silent_demo_fallback",
			"demo_runtime_missing_banner",
			"placeholder_data_in_ui",
			"manual_field_copy",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("has no duplicate ids", () => {
		const ids = TEST_AND_DEMO_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
