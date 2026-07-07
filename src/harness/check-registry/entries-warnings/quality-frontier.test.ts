import { describe, expect, it } from "vitest";
import { QUALITY_FRONTIER_ENTRIES } from "./quality-frontier.js";

// Shape pins for the 2026-07-06 quality-frontier wave (docs/design/
// quality-frontier-2026-07.md). The cross-registry invariants (unique ids
// repo-wide, metadata presence, docs freshness) live in the registry-wide
// suites; this file pins what is specific to THIS fragment.

const EXPECTED_IDS = [
	"timeout_unit_mismatch",
	"numeric_sort_without_comparator",
	"implicit_switch_fallthrough",
	"contradictory_nullness_chain",
	"json_stringify_error",
	"catch_rewrap_loses_cause",
	"resource_handle_leak",
	"jsdoc_param_drift",
] as const;

describe("QUALITY_FRONTIER_ENTRIES", () => {
	it("registers exactly the eight wave detectors, in declaration order", () => {
		expect(QUALITY_FRONTIER_ENTRIES.map((e) => e.id)).toEqual([...EXPECTED_IDS]);
	});

	it("every entry is a post-phase warning with a callable detector", () => {
		for (const e of QUALITY_FRONTIER_ENTRIES) {
			expect(e.phase, e.id).toBe("post");
			expect(e.severity, e.id).toBe("warning");
			expect(typeof e.fn, e.id).toBe("function");
			expect(e.pipeline, e.id).toBe("agent_safety");
			expect(e.tier, e.id).toBe(1);
		}
	});

	it("every entry carries actionable copy (description + fix_instruction)", () => {
		for (const e of QUALITY_FRONTIER_ENTRIES) {
			expect(e.description.length, e.id).toBeGreaterThan(40);
			expect(e.fix_instruction.length, e.id).toBeGreaterThan(40);
			expect(e.name.length, e.id).toBeGreaterThan(3);
		}
	});

	it("resultsPropNames are unique lowerCamelCase", () => {
		const props = QUALITY_FRONTIER_ENTRIES.map((e) => e.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
		for (const p of props) expect(p).toMatch(/^[a-z][A-Za-z]+$/);
	});

	it("rejects pre_block claims: no fragment entry escalates to the error phase or error severity", () => {
		// pre_block is reserved for zero-FP deterministic errors in entries-errors.ts;
		// this wave's heuristics must NOT sneak in as blocking.
		for (const e of QUALITY_FRONTIER_ENTRIES) {
			expect(e.phase, e.id).not.toBe("pre_block");
			expect(e.severity, e.id).not.toBe("error");
		}
	});

	it("only jsdoc_param_drift claims full determinism (TS-AST-exact); the rest are heuristic", () => {
		for (const e of QUALITY_FRONTIER_ENTRIES) {
			expect(e.determinism, e.id).toBe(
				e.id === "jsdoc_param_drift" ? "fully_deterministic" : "heuristic",
			);
		}
	});
});
