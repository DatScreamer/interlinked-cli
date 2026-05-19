import { describe, expect, it } from "vitest";
import { UBS_ENTRIES } from "./ubs-checks.js";

describe("UBS_ENTRIES", () => {
	it("is non-empty", () => {
		expect(UBS_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of UBS_ENTRIES) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase", () => {
		for (const c of UBS_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
		}
	});

	it("every entry has the required metadata fields populated", () => {
		for (const c of UBS_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
			expect(["error", "warning"], `${c.id} severity`).toContain(c.severity);
		}
	});

	it("UBS Plan 04 ids carry the ubs_ prefix", () => {
		const ubsPrefixed = UBS_ENTRIES.filter((c) => c.id.startsWith("ubs_"));
		expect(ubsPrefixed.length).toBeGreaterThan(0);
		for (const c of ubsPrefixed) {
			// ubs_ ids never carry the prefix in resultsPropName (Plan 04 phase matrix)
			expect(c.resultsPropName.startsWith("ubs")).not.toBeUndefined();
		}
	});

	it("includes the Plan 04 UBS rows and package/tsconfig checks", () => {
		const ids = new Set(UBS_ENTRIES.map((c) => c.id));
		for (const expected of [
			"ubs_js_loose_equality",
			"ubs_float_equality",
			"ubs_eval_input_tainted",
			"ubs_sql_string_concat",
			"ubs_pickle_untrusted_load",
			"ubs_print_debug_leak",
			"package_json_script_paths",
			"tsconfig_strictness",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("has no duplicate ids", () => {
		const ids = UBS_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
