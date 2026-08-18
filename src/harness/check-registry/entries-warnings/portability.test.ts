import { describe, expect, it } from "vitest";
import { PORTABILITY_ENTRIES } from "./portability.js";

describe("PORTABILITY_ENTRIES", () => {
	it("registers the four portability checks with unique ids and prop names", () => {
		expect(PORTABILITY_ENTRIES.map((e) => e.id)).toEqual([
			"dynamic_code_execution",
			"builtin_prototype_mutation",
			"float_equality_comparison",
			"python_portability_trap",
		]);
		const props = PORTABILITY_ENTRIES.map((e) => e.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
	});

	it("keeps every entry post-phase, warning severity, agent_safety pipeline, heuristic", () => {
		for (const e of PORTABILITY_ENTRIES) {
			expect(e.phase).toBe("post");
			expect(e.severity).toBe("warning");
			expect(e.pipeline).toBe("agent_safety");
			expect(e.determinism).toBe("heuristic");
			expect(e.tier).toBe(1);
		}
	});

	it("every entry has a callable fn and a non-trivial fix_instruction", () => {
		for (const e of PORTABILITY_ENTRIES) {
			expect(typeof e.fn).toBe("function");
			expect(e.fix_instruction.length).toBeGreaterThan(40);
		}
	});

	it("fn.name matches the exported detector for each entry (Check Evidence Contract resolution)", () => {
		const byId = new Map(PORTABILITY_ENTRIES.map((e) => [e.id, e.fn.name]));
		expect(byId.get("dynamic_code_execution")).toBe("detectDynamicCodeExecution");
		expect(byId.get("builtin_prototype_mutation")).toBe("detectBuiltinPrototypeMutation");
		expect(byId.get("float_equality_comparison")).toBe("detectFloatEqualityComparison");
	});
});
