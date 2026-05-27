// Smoke test for the `generic-checks` re-export barrel. The file itself has
// no runtime logic — it only re-exports detector functions from `./checks/*`.
// This test pins the contract that future renames or accidental deletions of
// barrel entries fail loudly in CI rather than silently breaking every
// downstream importer.

import { describe, expect, it } from "vitest";

import * as barrel from "./generic-checks.js";

describe("generic-checks barrel", () => {
	it("re-exports at least 50 detector symbols", () => {
		const exported = Object.keys(barrel);
		expect(exported.length).toBeGreaterThan(50);
	});

	it("every export resolves to a function", () => {
		const nonFunctionExports = Object.entries(barrel)
			.filter(([_, v]) => typeof v !== "function")
			.map(([k]) => k);
		expect(nonFunctionExports).toEqual([]);
	});

	it("includes the new pattern-parity detectors added in 2026-05", () => {
		const required = [
			"checkAesEcbMode",
			"checkDocumentWrite",
			"checkGoShellInjection",
			"checkInsertAdjacentHtml",
			"checkMarshalLoad",
			"checkNodeCreateCipher",
			"checkOuterHtmlAssignment",
			"checkPickleWrapperLoad",
			"checkScriptWithoutSri",
			"checkShelveOpen",
			"checkTorchUnsafeLoad",
			"checkYamlUnsafeLoad",
		];
		for (const name of required) {
			expect(barrel, `missing barrel export: ${name}`).toHaveProperty(name);
		}
	});

	it("does not leak unrelated identifiers — barrel surface stays minimal", () => {
		// Negative case: the barrel should NOT expose names that look like
		// internal helpers or implementation details. If one of these ever
		// becomes a real export, this assertion fires loudly so the rename or
		// surface widening gets explicit review rather than silently drifting.
		const forbidden = [
			"default",
			"__esModule",
			"internalScanContent",
			"_compileRegex",
			"PRIVATE_API",
		];
		for (const name of forbidden) {
			expect(barrel, `unexpected barrel export: ${name}`).not.toHaveProperty(name);
		}
	});
});
