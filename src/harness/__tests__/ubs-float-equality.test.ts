// Registration test for `ubs_float_equality` (row 28 of Phase-1 Plan 04
// phase matrix). The detector itself (`checkFloatEquality`) lives in
// `checks/b-series.ts` and predates this rollout; this test simply verifies
// the registry / metadata / verify wiring is in place.

import { describe, expect, it } from "vitest";
import { GENERIC_CHECK_META } from "../check-metadata.js";
import { WARNING_ENTRIES } from "../check-registry/entries-warnings.js";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { checkFloatEquality } from "../generic-checks.js";

describe("ubs_float_equality registration", () => {
	it("`checkFloatEquality` is exported from the generic-checks barrel", () => {
		expect(typeof checkFloatEquality).toBe("function");
	});

	it("is registered in WARNING_ENTRIES with the expected shape", () => {
		const entry = WARNING_ENTRIES.find((c) => c.id === "ubs_float_equality");
		expect(entry, "ubs_float_equality should be in WARNING_ENTRIES").toBeTruthy();
		if (!entry) return;
		expect(entry.phase).toBe("pre_warn");
		expect(entry.severity).toBe("warning");
		expect(entry.pipeline).toBe("agent_safety");
		expect(entry.tier).toBe(1);
		expect(entry.determinism).toBe("fully_deterministic");
		expect(entry.resultsPropName).toBe("floatEquality");
		expect(typeof entry.fn).toBe("function");
	});

	it("appears in the combined CHECK_REGISTRY", () => {
		const ids = CHECK_REGISTRY.map((c) => c.id);
		expect(ids).toContain("ubs_float_equality");
	});

	it("has metadata in GENERIC_CHECK_META", () => {
		const meta = GENERIC_CHECK_META.ubs_float_equality;
		expect(meta, "ubs_float_equality should have metadata").toBeTruthy();
		if (!meta) return;
		expect(meta.tier).toBe(1);
		expect(meta.determinism).toBe("fully_deterministic");
	});

	it("the underlying detector still flags `=== 0.1` and ignores integers", () => {
		expect(checkFloatEquality("if (x === 0.1) {}", "math.ts").length).toBeGreaterThan(0);
		expect(checkFloatEquality("if (x === 42) {}", "math.ts")).toEqual([]);
	});
});
