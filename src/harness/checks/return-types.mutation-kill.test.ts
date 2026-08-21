import { describe, expect, it } from "vitest";
import { checkMissingReturnTypes } from "./return-types.js";

const TS = "src/features/w26.ts";

function findingLines(code: string, filePath = TS): number[] {
	return checkMissingReturnTypes(code, filePath).map((match) => match.line);
}

describe("return-type detector mutation contracts: w26 pass1 supplement", () => {
	// test-contract: boundary — a bare colon glued directly to the opening brace (no whitespace
	// gap) is still an empty return annotation and must be reported as missing.
	it("reports a bare colon glued directly to the opening brace", () => {
		expect(findingLines("export function empty(value: string):{")).toEqual([1]);
	});

	// test-contract: boundary — the arrow-export entry guard must tolerate more than one space
	// between "const" and the binding name; a real declaration with extra whitespace is still
	// eligible for the missing-annotation finding.
	it("still recognizes an arrow export with extra whitespace after const", () => {
		expect(findingLines("export const  double = (value: number) => value * 2;")).toEqual([1]);
	});

	// test-contract: security — the binding-type-annotation check must anchor to the start of the
	// line; an unrelated "export const NAME: Type =" fragment embedded in a string literal default
	// value must not be able to forge an annotation and suppress a real finding.
	it("does not let an embedded string fragment forge a binding-type annotation (arrow)", () => {
		const code = 'export const run = (a = "export const ignored: Type = value") => a;';
		expect(findingLines(code)).toEqual([1]);
	});

	// test-contract: security — same anchoring requirement for the function-expression variant of
	// the binding-type-annotation check.
	it("does not let an embedded string fragment forge a binding-type annotation (function expression)", () => {
		const code =
			'export const run = function(a = "export const ignored: Type = value") { return a; }';
		expect(findingLines(code)).toEqual([1]);
	});

	// test-contract: boundary — the function-expression entry guard must tolerate more than one
	// space between "const" and the binding name, mirroring the arrow guard above.
	it("still recognizes a function-expression export with extra whitespace after const", () => {
		expect(findingLines("export const  run = function() { return 1; }")).toEqual([1]);
	});

	// test-contract: boundary — the function-expression entry guard's whitespace between "=" and
	// "function" is optional; a tightly-packed "=function(" is still a valid declaration to check.
	it("still recognizes a function-expression export with no space before the keyword", () => {
		expect(findingLines("export const run =function() { return 1; }")).toEqual([1]);
	});

	// test-contract: invariant — once the arrow pattern recognizes a param return-type annotation
	// it must claim the line exclusively; the function-expression pattern must never also inspect
	// the same declaration and manufacture an unrelated finding from an embedded arrow-like colon.
	it("does not let a coincidental embedded colon-arrow manufacture a duplicate finding", () => {
		const code = "export const run = function() { return helper(): number => 1; }";
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: invariant — once the arrow pattern pushes a missing-annotation finding for a
	// declaration, it must claim the line exclusively; the function-expression pattern must never
	// re-examine the same line and add a duplicate finding for the same declaration.
	it("reports exactly one finding, not a duplicate, for a nested-arrow default parameter", () => {
		const code = "export const run = function(cb = () => 1) { return cb(); }";
		expect(findingLines(code)).toEqual([1]);
	});

	// test-contract: boundary — a single-character return type annotation immediately before the
	// arrow is still an explicit annotation and must not be reported as missing.
	it("accepts a single-character return type annotation before a tight arrow", () => {
		expect(findingLines("export const foo = (): X=>value;")).toEqual([]);
	});
});
