// ===========================================
// section-table-agent-safety mutation-kill (wave 34)
// ===========================================
// Kills StringLiteral-emptying mutants on the literal `label` / `noun` /
// `passLabel` fields of each SectionSpec entry — exact-value assertions.

import { describe, expect, it } from "vitest";
import { agentSafetySections } from "./section-table-agent-safety.js";

function byKey(key: string) {
	const spec = agentSafetySections.find((s) => s.key === key);
	if (!spec) throw new Error(`missing spec for key ${key}`);
	return spec;
}

describe("agentSafetySections — exact literal text (mutation-kill)", () => {
	// test-contract: public-api — misusedPromises literal fields
	it("P1: misusedPromises carries its exact label/noun/passLabel", () => {
		const spec = byKey("misusedPromises");
		expect(spec.label).toBe("misused promises");
		expect(spec.noun).toBe("async callbacks in sync APIs");
		expect(spec.passLabel).toBe("no misused promises");
	});

	// test-contract: public-api — floatingPromises literal fields
	it("P2: floatingPromises carries its exact label/noun/passLabel", () => {
		const spec = byKey("floatingPromises");
		expect(spec.label).toBe("floating promises");
		expect(spec.noun).toBe("unhandled async calls at statement position");
		expect(spec.passLabel).toBe("no floating promises");
	});

	// test-contract: public-api — broadObjectTypes literal fields
	it("P3: broadObjectTypes carries its exact label/noun/passLabel", () => {
		const spec = byKey("broadObjectTypes");
		expect(spec.label).toBe("broad object types");
		expect(spec.noun).toBe(
			"Record<K, any> / index-to-any / bare Function / bare object annotations",
		);
		expect(spec.passLabel).toBe("no broad object types");
	});

	// test-contract: public-api — booleanTrap literal fields
	it("P4: booleanTrap carries its exact label/noun/passLabel", () => {
		const spec = byKey("booleanTrap");
		expect(spec.label).toBe("boolean trap");
		expect(spec.noun).toBe("call sites with 2+ boolean literal arguments");
		expect(spec.passLabel).toBe("no boolean traps");
	});

	// test-contract: public-api — positionalOptionalBoolean literal fields
	it("P5: positionalOptionalBoolean carries its exact label/noun/passLabel", () => {
		const spec = byKey("positionalOptionalBoolean");
		expect(spec.label).toBe("positional optional boolean");
		expect(spec.noun).toBe(
			"function signatures with a positional optional boolean param",
		);
		expect(spec.passLabel).toBe("no positional optional booleans");
	});

	// test-contract: public-api — manyOptionalParams literal fields
	it("P6: manyOptionalParams carries its exact label/noun/passLabel", () => {
		const spec = byKey("manyOptionalParams");
		expect(spec.label).toBe("many optional params");
		expect(spec.noun).toBe("function signatures with 3+ optional params");
		expect(spec.passLabel).toBe("no signatures with 3+ optional params");
	});

	// test-contract: public-api — sameTypedPrimitiveParams literal fields
	it("P7: sameTypedPrimitiveParams carries its exact label/noun/passLabel", () => {
		const spec = byKey("sameTypedPrimitiveParams");
		expect(spec.label).toBe("same-typed primitive params");
		expect(spec.noun).toBe(
			"public signatures with adjacent same-typed primitive params",
		);
		expect(spec.passLabel).toBe("no orderable-by-mistake param pairs");
	});

	// test-contract: public-api — commentClaimsLimitNoGuard literal fields
	it("P8: commentClaimsLimitNoGuard carries its exact label/noun/passLabel", () => {
		const spec = byKey("commentClaimsLimitNoGuard");
		expect(spec.label).toBe("comment claims limit");
		expect(spec.noun).toBe(
			'functions whose comment says "max N" / "limited to N" without a guard',
		);
		expect(spec.passLabel).toBe("no comment-claims-limit drift");
	});

	// test-contract: public-api — commentClaimsNullThrowsInstead literal fields
	it("P9: commentClaimsNullThrowsInstead carries its exact label/noun/passLabel", () => {
		const spec = byKey("commentClaimsNullThrowsInstead");
		expect(spec.label).toBe("comment claims null");
		expect(spec.noun).toBe(
			'functions whose comment says "returns null" but body throws',
		);
		expect(spec.passLabel).toBe("no comment-claims-null drift");
	});

	// test-contract: public-api — commentClaimsValidationMissing literal fields
	it("P10: commentClaimsValidationMissing carries its exact label/noun/passLabel", () => {
		const spec = byKey("commentClaimsValidationMissing");
		expect(spec.label).toBe("comment claims validation");
		expect(spec.noun).toBe(
			'functions whose comment says "validates/sanitizes/escapes" without any check',
		);
		expect(spec.passLabel).toBe("no comment-claims-validation drift");
	});

	// test-contract: public-api — commentClaimsIdempotentMutates literal fields
	it("P11: commentClaimsIdempotentMutates carries its exact label/noun/passLabel", () => {
		const spec = byKey("commentClaimsIdempotentMutates");
		expect(spec.label).toBe("comment claims idempotent");
		expect(spec.noun).toBe(
			'functions whose comment says "idempotent" but body mutates unconditionally',
		);
		expect(spec.passLabel).toBe("no comment-claims-idempotent drift");
	});

	// test-contract: public-api — commentClaimsThrowsDoesnt literal fields
	it("P12: commentClaimsThrowsDoesnt carries its exact label/noun/passLabel", () => {
		const spec = byKey("commentClaimsThrowsDoesnt");
		expect(spec.label).toBe("comment claims throws");
		expect(spec.noun).toBe(
			"functions whose @throws {ErrorX} declaration isn't actually thrown",
		);
		expect(spec.passLabel).toBe("no comment-claims-throws drift");
	});
});
