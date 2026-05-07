import { describe, expect, it } from "vitest";
import {
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
} from "./ratchet-metrics.js";

describe("Batch 7 ratchet counters", () => {
	it("counts TODO/FIXME/HACK/XXX markers", () => {
		const code = `// TODO: x\n// FIXME y\n/* HACK z */\nconst todo = 1; // not a marker comment\n`;
		expect(countTodoMarkers(code)).toBe(3);
	});

	it("does not count TODO inside string literals", () => {
		expect(countTodoMarkers(`const msg = "TODO list"; const a = 1;`)).toBe(0);
	});

	it("counts console.* statements", () => {
		const code = `console.log("a"); console.warn("b"); console.error("c"); logger.log("d");`;
		expect(countConsoleStatements(code)).toBe(3);
	});

	it("does not count console.* inside string literals", () => {
		expect(countConsoleStatements(`const s = "console.log(x)";`)).toBe(0);
	});

	it("counts exported-symbol public API surface", () => {
		const code = `
export function foo() {}
export const bar = 1;
export class Baz {}
export interface Qux {}
function notExported() {}
`;
		expect(countPublicApiSurface(code)).toBe(4);
	});

	it("dedupes same-name exports across declarations", () => {
		const code = `export const foo = 1; export type foo = string;`;
		expect(countPublicApiSurface(code)).toBe(1);
	});
});

describe("ratchet-metrics — existing counters", () => {
	it("counts `as any` casts", () => {
		expect(countAsAnyCasts("const x = a as any; const y = b as any;")).toBe(2);
		expect(countAsAnyCasts("const x = 1;")).toBe(0);
	});

	it("counts non-null assertions", () => {
		expect(countNonNullAssertions("foo!.bar; foo![0]; foo!();")).toBe(3);
		expect(countNonNullAssertions("if (x !== y) {}")).toBe(0);
	});

	it("counts suppression directives", () => {
		expect(countSuppressionDirectives("// @ts-ignore\n// eslint-disable\n")).toBe(2);
	});
});

describe("countTypeDensity", () => {
	it("counts bare `: any` annotations", () => {
		const result = countTypeDensity("function f(x: any) { return x; }\nconst y: any = 1;");
		expect(result.anyAnnotations).toBe(2);
	});

	it("counts `: unknown` annotations", () => {
		const result = countTypeDensity("function f(x: unknown) { return x; }");
		expect(result.unknownAnnotations).toBe(1);
	});

	it("counts bare `Function` type annotations", () => {
		const result = countTypeDensity("const f: Function = () => 1;");
		expect(result.functionType).toBe(1);
	});

	it("does not count Function constructor or class call", () => {
		// `Function(...)` and `new Function(...)` are runtime calls, not type annotations.
		const result = countTypeDensity("const f = new Function('x', 'return x'); const g = Function();");
		expect(result.functionType).toBe(0);
	});

	it("counts empty-object `: {}` annotations", () => {
		const result = countTypeDensity("function f(x: {}) { return x; }");
		expect(result.emptyObjectType).toBe(1);
	});

	it("counts exported function parameters that lack type annotations", () => {
		const result = countTypeDensity("export function f(x, y: number, z) { return x; }");
		// `x` and `z` are untyped; `y` is typed.
		expect(result.untypedExportedParams).toBe(2);
	});

	it("counts exported functions missing a return-type annotation", () => {
		const result = countTypeDensity(
			"export function withRet(x: number): number { return x; }\n" +
				"export function noRet(x: number) { return x; }\n",
		);
		expect(result.missingExportedReturnType).toBe(1);
	});

	it("ignores non-exported functions for export-related counters", () => {
		const result = countTypeDensity("function inner(x) { return x; }");
		expect(result.untypedExportedParams).toBe(0);
		expect(result.missingExportedReturnType).toBe(0);
	});

	it("ignores patterns in strings/comments via offset-preserving strip", () => {
		const result = countTypeDensity('const note = "use : any sparingly"; // : any is bad');
		expect(result.anyAnnotations).toBe(0);
	});

	it("returns zero counts on empty input", () => {
		const result = countTypeDensity("");
		expect(result).toEqual({
			anyAnnotations: 0,
			unknownAnnotations: 0,
			functionType: 0,
			emptyObjectType: 0,
			untypedExportedParams: 0,
			missingExportedReturnType: 0,
		});
	});
});
