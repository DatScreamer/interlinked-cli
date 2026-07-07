// ===========================================
// Advisory-tier check ids — parity + surface tests
// ===========================================
// The load-bearing assertion here is PARITY: the harness-side
// `ADVISORY_CHECK_IDS` must stay identical to the verify command's
// `DEFAULT_ADVISORY_SKIPS` until advisory.ts re-exports from this module.
// A drifted pair would let `persistent_warning_escalation` amplify a
// check that verify itself treats as advisory-tier noise.
import { describe, expect, it } from "vitest";

import { DEFAULT_ADVISORY_SKIPS } from "../commands/verify/advisory.js";
import { ADVISORY_CHECK_IDS, isAdvisoryCheckId } from "./advisory-check-ids.js";

describe("ADVISORY_CHECK_IDS", () => {
	it("is set-equal to DEFAULT_ADVISORY_SKIPS (no drift while both definitions exist)", () => {
		// Sorted-array comparison so a failure names the exact drifted ids.
		expect([...ADVISORY_CHECK_IDS].sort()).toEqual([...DEFAULT_ADVISORY_SKIPS].sort());
	});

	it("contains the known advisory heuristics the escalation FP was built on", () => {
		expect(ADVISORY_CHECK_IDS.has("magic_literal_in_conditional")).toBe(true);
		expect(ADVISORY_CHECK_IDS.has("complexity")).toBe(true);
		expect(ADVISORY_CHECK_IDS.has("ubs_magic_number_no_const")).toBe(true);
	});

	it("does NOT contain default-gate check ids", () => {
		expect(ADVISORY_CHECK_IDS.has("typescript")).toBe(false);
		expect(ADVISORY_CHECK_IDS.has("nan_coercion_guard")).toBe(false);
		expect(ADVISORY_CHECK_IDS.has("floating_promises")).toBe(false);
	});
});

describe("isAdvisoryCheckId", () => {
	it("returns true for advisory ids and false for default-gate ids", () => {
		expect(isAdvisoryCheckId("write_without_mkdir")).toBe(true);
		expect(isAdvisoryCheckId("typescript")).toBe(false);
		expect(isAdvisoryCheckId("")).toBe(false);
	});
});
