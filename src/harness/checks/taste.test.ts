// Targeted line/branch coverage for taste.ts: the >=10-match caps, the
// extension gate, unmatched-signature edge cases, decorator-prefixed params,
// and the catch-and-ignore body scanner.
import { describe, expect, it } from "vitest";
import {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkFunctionArity,
	checkManyOptionalParams,
	checkPositionalOptionalBoolean,
} from "./taste.js";

describe("checkBooleanTrap — 10-match cap", () => {
	it("stops collecting after 10 matches even when an 11th line also qualifies", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `doThing${i}(true, false);`);
		const matches = checkBooleanTrap(lines.join("\n"), "src/foo.ts");
		expect(matches).toHaveLength(10);
	});
});

describe("checkFunctionArity", () => {
	it("returns [] for an unsupported extension", () => {
		expect(checkFunctionArity("def f(a,b,c,d,e,f): pass", "src/foo.py")).toEqual([]);
	});

	it("stops collecting after 10 matches even when an 11th function also qualifies", () => {
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `function f${i}(a,b,c,d,e) { return a; }`,
		);
		const matches = checkFunctionArity(lines.join("\n"), "src/foo.ts");
		expect(matches).toHaveLength(10);
	});

	it("skips a signature whose params never close within the 20-line collection window", () => {
		const header = "function foo(";
		const paramLines = Array.from({ length: 25 }, (_, i) => `  param${i}: number,`);
		const src = [header, ...paramLines].join("\n");
		expect(checkFunctionArity(src, "src/foo.ts")).toEqual([]);
	});

	it("skips a single destructured-object param with no top-level commas outside the braces", () => {
		const src = "function foo({ a, b, c, d, e }) { return a; }";
		expect(checkFunctionArity(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkPositionalOptionalBoolean", () => {
	it("stops collecting after 10 matches even when an 11th function also qualifies", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `function g${i}(flag?: boolean) {}`);
		const matches = checkPositionalOptionalBoolean(lines.join("\n"), "src/foo.ts");
		expect(matches).toHaveLength(10);
	});

	it("skips a signature whose params never close within the 20-line collection window", () => {
		const header = "function foo(";
		const paramLines = Array.from({ length: 25 }, (_, i) => `  param${i}: number,`);
		const src = [header, ...paramLines].join("\n");
		expect(checkPositionalOptionalBoolean(src, "src/foo.ts")).toEqual([]);
	});

	it("resolves a generic type parameter block before the params without miscounting depth", () => {
		const src = "function foo<T>(flag?: boolean) { return flag; }";
		const matches = checkPositionalOptionalBoolean(src, "src/foo.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("returns null (skips) for a decorator-prefixed param that has no leading identifier", () => {
		const src = "function foo(@Optional() flag?: boolean) { return flag; }";
		expect(checkPositionalOptionalBoolean(src, "src/foo.ts")).toEqual([]);
	});

	it("skips a destructured object param outright (findPositionalOptionalBoolean returns null immediately)", () => {
		// First param is a normal positional (no match); the second is a
		// destructured object, which is skipped outright rather than inspected.
		const src = "function foo(x: number, { flag }: Opts) { return flag; }";
		expect(checkPositionalOptionalBoolean(src, "src/foo.ts")).toEqual([]);
	});

	it("skips an array-destructured param outright", () => {
		const src = "function foo(x: number, [flag]: Opts) { return flag; }";
		expect(checkPositionalOptionalBoolean(src, "src/foo.ts")).toEqual([]);
	});

	it("skips a rest param outright", () => {
		const src = "function foo(x: number, ...rest: boolean[]) { return rest; }";
		expect(checkPositionalOptionalBoolean(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkManyOptionalParams", () => {
	it("stops collecting after 10 matches even when an 11th function also qualifies", () => {
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `function h${i}(a?: number, b?: number, c?: number) {}`,
		);
		const matches = checkManyOptionalParams(lines.join("\n"), "src/foo.ts");
		expect(matches).toHaveLength(10);
	});

	it("skips a signature whose params never close within the 20-line collection window", () => {
		const header = "function foo(";
		const paramLines = Array.from({ length: 25 }, (_, i) => `  param${i}: number,`);
		const src = [header, ...paramLines].join("\n");
		expect(checkManyOptionalParams(src, "src/foo.ts")).toEqual([]);
	});
});

describe("checkCatchAndIgnore", () => {
	it("stops collecting after 10 matches even when an 11th catch block also qualifies", () => {
		const lines = Array.from(
			{ length: 12 },
			() => "try { doWork(); } catch (e) { return null; }",
		);
		const matches = checkCatchAndIgnore(lines.join("\n"), "src/foo.ts");
		expect(matches).toHaveLength(10);
	});

	it("does not flag a catch block that already logs the error", () => {
		const src = "try { doWork(); } catch (e) { console.error(e); return null; }";
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toEqual([]);
	});

	it("does not flag a catch block whose body is not a bare default-return", () => {
		const src = "try { doWork(); } catch (e) { doCleanup(); }";
		expect(checkCatchAndIgnore(src, "src/foo.ts")).toEqual([]);
	});
});
