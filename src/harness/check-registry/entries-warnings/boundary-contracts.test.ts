import { describe, expect, it } from "vitest";
import { BOUNDARY_CONTRACT_ENTRIES } from "./boundary-contracts.js";

describe("BOUNDARY_CONTRACT_ENTRIES", () => {
	it("registers the two boundary/contract checks with unique ids and prop names", () => {
		expect(BOUNDARY_CONTRACT_ENTRIES.map((e) => e.id)).toEqual([
			"test_contract_annotation",
			"unvalidated_input_boundary",
		]);
		const props = BOUNDARY_CONTRACT_ENTRIES.map((e) => e.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
	});

	it("keeps every entry post-phase, warning severity, agent_safety pipeline, heuristic", () => {
		for (const e of BOUNDARY_CONTRACT_ENTRIES) {
			expect(e.phase).toBe("post");
			expect(e.severity).toBe("warning");
			expect(e.pipeline).toBe("agent_safety");
			expect(e.determinism).toBe("heuristic");
			expect(e.tier).toBe(1);
		}
	});

	it("every entry has a callable fn and a non-trivial fix_instruction", () => {
		for (const e of BOUNDARY_CONTRACT_ENTRIES) {
			expect(typeof e.fn).toBe("function");
			expect(e.fix_instruction.length).toBeGreaterThan(40);
		}
	});

	it("fn.name matches the exported detector for each entry (Check Evidence Contract resolution)", () => {
		const byId = new Map(BOUNDARY_CONTRACT_ENTRIES.map((e) => [e.id, e.fn.name]));
		expect(byId.get("test_contract_annotation")).toBe("detectTestContractAnnotation");
		expect(byId.get("unvalidated_input_boundary")).toBe("detectUnvalidatedInputBoundary");
	});
});
