import { describe, expect, it } from "vitest";
import { SWIFT_ENTRIES } from "./entries-swift.js";

describe("SWIFT_ENTRIES", () => {
	it("is non-empty", () => {
		expect(SWIFT_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of SWIFT_ENTRIES) {
			expect(c.pipeline).toBe("agent_safety");
		}
	});

	it("every check fn is a no-op on non-Swift file paths (skip gate)", () => {
		// Most Swift checks gate on `.swift`. The ATS-plist check gates on
		// `.plist` / `Info.plist` instead, so it's exempt from this scan.
		const PLIST_CHECK_IDS = new Set(["swift_ats_arbitrary_loads"]);
		for (const c of SWIFT_ENTRIES) {
			if (PLIST_CHECK_IDS.has(c.id)) continue;
			expect(c.fn("some content", "unrelated.ts"), c.id).toEqual([]);
		}
	});

	it("every entry has the required fields", () => {
		for (const c of SWIFT_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.id, "id").toMatch(/^swift_/);
			expect(typeof c.fn).toBe("function");
			expect(c.fix_instruction.length).toBeGreaterThan(20);
			expect(c.name.length).toBeGreaterThan(0);
			expect(c.description.length).toBeGreaterThan(20);
			expect(c.severity).toBe("warning");
		}
	});

	it("each entry uses a unique id", () => {
		const ids = SWIFT_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("each entry uses a unique resultsPropName", () => {
		const props = SWIFT_ENTRIES.map((c) => c.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
	});

	it("includes the seven previously-orphan swift.ts detectors", () => {
		const ids = new Set(SWIFT_ENTRIES.map((c) => c.id));
		for (const id of [
			"swift_task_detached",
			"swift_unhandled_task_error",
			"swift_global_var_no_isolation",
			"swift_self_in_escaping_closure",
			"swift_filter_count",
			"swift_file_id_over_file_path",
			"swift_abbreviations",
		]) {
			expect(ids.has(id), id).toBe(true);
		}
	});
});
