// Unit tests for tag-reflection.ts
//
// Covers:
//   Positive (MUST fire):
//     P1  instanceof String
//     P2  === "[object Number]"
//     P3  !== '[object Boolean]'
//   Negative (MUST NOT fire):
//     N1  typeof check (the preferred replacement)
//     N2  Object.prototype.toString.call(x) === "[object Date]"
//     N3  StringDecoder identifier / comment mentioning "instanceof String"

import { describe, expect, it } from "vitest";
import { detectTagReflectionTypeCheck } from "./tag-reflection.js";

function fires(src: string, filePath = "src/util.ts"): boolean {
	return detectTagReflectionTypeCheck(src, filePath).length > 0;
}

describe("detectTagReflectionTypeCheck — positive (must fire)", () => {
	// test-contract: public-api — instanceof String must be flagged since typeof answers the same question correctly and cheaply
	it("P1: instanceof String", () => {
		const src = `
function isStringy(x: unknown): boolean {
  return x instanceof String;
}
`;
		const found = detectTagReflectionTypeCheck(src, "file.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.text).toMatch(/tag_reflection_type_check/);
	});

	// test-contract: public-api — instanceof Number must also be flagged, not just String
	it("P1b: instanceof Number", () => {
		expect(fires("if (x instanceof Number) { return true; }")).toBe(true);
	});

	// test-contract: public-api — instanceof Boolean must also be flagged
	it("P1c: instanceof Boolean", () => {
		expect(fires("if (x instanceof Boolean) { return true; }")).toBe(true);
	});

	// test-contract: public-api — Object.prototype.toString tag reflection for the Number primitive tag must be flagged
	it("P2: === \"[object Number]\"", () => {
		const src = `
function isNum(x: unknown): boolean {
  return Object.prototype.toString.call(x) === "[object Number]";
}
`;
		expect(fires(src)).toBe(true);
	});

	// test-contract: public-api — negated tag reflection with single quotes for the Boolean primitive tag must also be flagged
	it("P3: !== '[object Boolean]'", () => {
		const src = `
function isNotBool(x: unknown): boolean {
  return Object.prototype.toString.call(x) !== '[object Boolean]';
}
`;
		expect(fires(src)).toBe(true);
	});
});

describe("detectTagReflectionTypeCheck — negative (must not fire)", () => {
	// test-contract: invariant — the preferred typeof replacement itself must never be flagged, or the check would fight its own fix instruction
	it("N1: typeof check", () => {
		const src = `
function isStringy(x: unknown): boolean {
  return typeof x === "string";
}
`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: boundary — Object.prototype.toString.call comparisons against non-primitive tags (Date/Array/RegExp/Map) must not fire since typeof cannot distinguish these
	it("N2: Object.prototype.toString.call(x) === \"[object Date]\"", () => {
		const src = `
function isDate(x: unknown): boolean {
  return Object.prototype.toString.call(x) === "[object Date]";
}
`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: boundary — StringDecoder must not match the word-bounded "instanceof String" pattern, and a comment mentioning the smell must not fire either
	it("N3: StringDecoder identifier and a comment mentioning the pattern", () => {
		const src = `
import { StringDecoder } from "node:string_decoder";
// don't write x instanceof String here, use typeof instead
function make(): StringDecoder {
  return new StringDecoder("utf8");
}
`;
		expect(fires(src)).toBe(false);
	});

	// test-contract: boundary — non-JS/TS file extensions are out of scope for this check
	it("N4: non-JS file (.py) — out of scope", () => {
		const src = `if isinstance(x, str):\n    return True\n`;
		expect(fires(src, "src/util.py")).toBe(false);
	});

	// test-contract: boundary — test files are skipped, mirroring sibling checks in this family
	it("N5: test file is skipped", () => {
		const src = `
function isStringy(x: unknown): boolean {
  return x instanceof String;
}
`;
		expect(fires(src, "src/util.test.ts")).toBe(false);
	});
});
