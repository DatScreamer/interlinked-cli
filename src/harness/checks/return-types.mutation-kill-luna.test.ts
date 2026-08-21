import { describe, expect, it } from "vitest";
import { checkMissingReturnTypes } from "./return-types.js";

const TS = "src/features/account.ts";

function findingLines(code: string, filePath = TS): number[] {
	return checkMissingReturnTypes(code, filePath).map((match) => match.line);
}

function findingTexts(code: string, filePath = TS): string[] {
	return checkMissingReturnTypes(code, filePath).map((match) => match.text);
}

describe("return-type detector mutation contracts: exported declarations", () => {
	// MUST-FIRE table: each form is a supported public export whose signature has no annotation.
	const MUST_FIRE = [
		"export function plain(value: string) { return value; }",
		"export async function pending(value: string) { return value; }",
		"export function generic<T extends object>(value: T) { return value; }",
		"export function destructured({ id }: { id: string }) { return id; }",
		"export function nested(value: Array<{ id: string }>) { return value; }",
	];

	// test-contract: public-api — every supported exported function declaration without a return annotation is reported
	it.each(MUST_FIRE)("reports an unannotated declaration: %s", (code) => {
		expect(findingLines(code)).toEqual([1]);
	});

	// MUST-NOT-FIRE table: explicit annotations are the public exemption, including complex type syntax.
	const MUST_NOT_FIRE = [
		"export function plain(value: string): string { return value; }",
		"export async function pending(value: string): Promise<string> { return value; }",
		"export function generic<T extends object>(value: T): T { return value; }",
		"export function destructured({ id }: { id: string }): string { return id; }",
		"export function nested(value: Array<{ id: string }>): Array<{ id: string }> { return value; }",
	];

	// test-contract: invariant — explicit return annotations must suppress findings regardless of generic or nested type punctuation
	it.each(MUST_NOT_FIRE)("accepts an annotated declaration: %s", (code) => {
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — only an export declaration at the line boundary is eligible for the declaration detector
	it("rejects private, default, and embedded declaration lookalikes", () => {
		const code = [
			"function privateFn(value: string) { return value; }",
			"export default function(value: string) { return value; }",
			"if (ready) export function embedded(value: string) { return value; }",
			"const text = \"export function inside(value: string) { return value; }\";",
		].join("\n");
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — declaration whitespace and multiline parameters remain one public signature
	it("reports multiline declarations on their first line and preserves exact finding text", () => {
		const code = [
			"  export   async   function   merge(",
			"    { id }: { id: string },",
			"    values: Array<{ key: string }>,",
			") {",
			"  return { id, values };",
			"}",
		].join("\n");
		expect(findingLines(code)).toEqual([1]);
		expect(findingTexts(code)).toEqual(["export   async   function   merge("]);
	});

	// test-contract: invariant — a multiline explicit annotation suppresses the finding even when the type contains braces
	it("accepts multiline declarations with object and function return types", () => {
		const code = [
			"export function makeHandler(",
			"  input: { id: string },",
			"): { run: (id: string) => Promise<{ ok: boolean }> } {",
			"  return { run: async (id) => ({ ok: Boolean(id) }) };",
			"}",
		].join("\n");
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — a bare colon is equivalent to a missing annotation and must not become an exemption
	it("reports the empty return-annotation boundary", () => {
		expect(findingLines("export function empty(value: string):  { return value; }")).toEqual([1]);
	});
});

describe("return-type detector mutation contracts: exported arrow consts", () => {
	// MUST-FIRE table: arrow exports without a binding or parameter return annotation are reportable.
	const MUST_FIRE = [
		"export const double = (value: number) => value * 2;",
		"export const pending = async (value: string) => value;",
		"export const identity = <T extends object>(value: T) => value;",
		"export const pick = ({ id }: { id: string }) => id;",
		"export const nested = (value: Array<{ id: string }>) => ({ value });",
	];

	// test-contract: public-api — exported arrow consts without explicit return typing are reported across async, generic, and destructured forms
	it.each(MUST_FIRE)("reports an unannotated arrow: %s", (code) => {
		expect(findingLines(code)).toEqual([1]);
	});

	// MUST-NOT-FIRE table: either a parameter return annotation or a binding annotation makes the arrow explicitly typed.
	const MUST_NOT_FIRE = [
		"export const double = (value: number): number => value * 2;",
		"export const pending = async (value: string): Promise<string> => value;",
		"export const identity: <T>(value: T) => T = (value) => value;",
		"export const pick: ({ id }: { id: string }) => string = ({ id }) => id;",
		"export const nested = (value: Array<{ id: string }>): { value: Array<{ id: string }> } => ({ value });",
	];

	// test-contract: invariant — arrow return typing is recognized in both supported annotation positions and complex types
	it.each(MUST_NOT_FIRE)("accepts an annotated arrow: %s", (code) => {
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — export-const syntax must begin the trimmed line and must not be inferred from values or text
	it("rejects private, default, embedded, value, and string lookalikes", () => {
		const code = [
			"const privateArrow = (value: number) => value;",
			"export default const impossible = (value: number) => value;",
			"if (ready) export const embedded = (value: number) => value;",
			"export const value = 42;",
			"const text = \"export const inside = (value: number) => value;\";",
		].join("\n");
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — the detector accepts declaration whitespace but still reports the declaration's first line
	it("reports multiline and compact arrows with exact first-line locations", () => {
		const code = [
			" export  const  merge = (",
			"   { id }: { id: string },",
			")=>({ id });",
			"export const compact = (value: number)=>value;",
		].join("\n");
		expect(findingLines(code)).toEqual([1, 4]);
		expect(findingTexts(code)).toEqual([
			"export  const  merge = (",
			"export const compact = (value: number)=>value;",
		]);
	});

	// test-contract: invariant — multiline arrow annotations with nested braces are explicit and suppress findings
	it("accepts a multiline arrow return annotation with nested object types", () => {
		const code = [
			"export const make = (input: { id: string })",
			"  : { run: () => { ok: boolean } }",
			"  => ({ run: () => ({ ok: true }) });",
		].join("\n");
		expect(findingLines(code)).toEqual([]);
	});
});

describe("return-type detector mutation contracts: exported function-expression consts", () => {
	// MUST-FIRE table: exported const bindings to named, anonymous, and async function expressions need return typing.
	const MUST_FIRE = [
		"export const run = function (value: string) { return value; };",
		"export const run = async function named(value: string) { return value; };",
		"export const make = function ({ id }: { id: string }) { return id; };",
		"export const nested = function (value: Array<{ id: string }>) { return value; };",
	];

	// test-contract: public-api — all supported exported function-expression bindings are reported when unannotated
	it.each(MUST_FIRE)("reports an unannotated function expression: %s", (code) => {
		expect(findingLines(code)).toEqual([1]);
	});

	// MUST-NOT-FIRE table: function-expression return annotations and binding annotations both establish explicit typing.
	const MUST_NOT_FIRE = [
		"export const run = function (value: string): string { return value; };",
		"export const run = async function named(value: string): Promise<string> { return value; };",
		"export const make: ({ id }: { id: string }) => string = function ({ id }) { return id; };",
		"export const nested = function (value: Array<{ id: string }>): Array<{ id: string }> { return value; };",
	];

	// test-contract: invariant — function-expression annotations suppress findings across async, named, binding, and nested-type forms
	it.each(MUST_NOT_FIRE)("accepts an annotated function expression: %s", (code) => {
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — function-expression matching must not cross private, default, embedded, punctuation, or string boundaries
	it("rejects function-expression near-misses", () => {
		const code = [
			"const privateRun = function (value: string) { return value; };",
			"export default function (value: string) { return value; }",
			"if (ready) export const embedded = function (value: string) { return value; };",
			"export const punctuation = function!(value: string) { return value; };",
			"const text = \"export const inside = function (value: string) { return value; };\";",
		].join("\n");
		expect(findingLines(code)).toEqual([]);
	});

	// test-contract: boundary — multiline function-expression signatures report only the declaration line and preserve its trimmed text
	it("reports multiline function expressions on their declaration line", () => {
		const code = [
			"  export const make = async function named(",
			"    { id }: { id: string },",
			") {",
			"  return { id };",
			"};",
		].join("\n");
		expect(findingLines(code)).toEqual([1]);
		expect(findingTexts(code)).toEqual(["export const make = async function named("]);
	});

	// test-contract: invariant — an empty function-expression annotation remains missing even with spacing before its body
	it("reports the empty function-expression annotation boundary", () => {
		expect(findingLines("export const run = function (value: string):  { return value; };"))
			.toEqual([1]);
	});
});

describe("return-type detector mutation contracts: shared public boundaries", () => {
	// test-contract: security — comments and strings must not manufacture exported findings after comment/string stripping
	it("ignores commented and string-contained exports while finding the real declaration", () => {
		const code = [
			"// export const ghost = (value: string) => value;",
			"const source = 'export const alsoGhost = function (value: string) { return value; };';",
			"export const real = (value: string) => value;",
		].join("\n");
		expect(findingLines(code)).toEqual([3]);
	});

	// test-contract: public-api — TypeScript and TSX are eligible source forms while JavaScript is outside this detector's contract
	it("enforces TypeScript eligibility and exact line reporting", () => {
		const code = [
			"export function first(value: string) { return value; }",
			"export const second = (value: string) => value;",
		].join("\n");
		expect(findingLines(code, "src/features/account.ts")).toEqual([1, 2]);
		expect(findingLines(code, "src/features/account.tsx")).toEqual([1, 2]);
		expect(findingLines(code, "src/features/account.js")).toEqual([]);
	});
});
