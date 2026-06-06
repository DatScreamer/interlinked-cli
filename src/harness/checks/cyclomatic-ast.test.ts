import { describe, expect, it } from "vitest";
import { astComplexityAvailable, computeCyclomaticAst } from "./cyclomatic-ast.js";

const run = (src: string) => computeCyclomaticAst(src, "src/x.ts") ?? [];
const byName = (src: string, name: string) => run(src).find((e) => e.name === name);

describe("cyclomatic-ast — availability", () => {
	it("typescript is resolvable in this environment (AST path active)", () => {
		expect(astComplexityAvailable()).toBe(true);
	});
});

describe("cyclomatic-ast — per-function scope (the headline fix)", () => {
	it("counts an inline callback as its OWN function, not rolled into the parent", () => {
		const src = `
			export function parent(xs: number[]): number {
				if (xs.length === 0) return 0;        // parent +1
				return xs.map((x) => {
					return x > 0 ? x : -x;            // ternary belongs to the CALLBACK, not parent
				}).reduce((a, b) => a + b, 0);
			}
		`;
		// The whole point: the ternary inside .map's callback must NOT inflate
		// `parent`. Parent = base 1 + its own `if` = 2 (the regex walker gave 3).
		expect(byName(src, "parent")?.cyclomatic).toBe(2);
		const callback = run(src).find((e) => e.name === "(callback)");
		expect(callback?.cyclomatic).toBe(2); // base 1 + the ternary
	});

	it("emits a separate entry for each nested function", () => {
		const src = `function outer() { const a = () => 1; const b = () => 2; return a() + b(); }`;
		expect(run(src).length).toBe(3); // outer + 2 arrows
	});
});

describe("cyclomatic-ast — decision set", () => {
	it("counts `??` as a branch", () => {
		expect(byName(`function f(a: unknown) { return a ?? 1; }`, "f")?.cyclomatic).toBe(2);
	});

	it("counts if / && / || / for / while / case / catch / ternary", () => {
		const src = `function f(a: number, b: number) {
			if (a && b || a) { return 1; }            // if +1, && +1, || +1
			for (let i = 0; i < a; i++) {}            // +1
			while (b > 0) { b--; }                    // +1
			switch (a) { case 1: break; case 2: break; default: break; } // case +2 (default excluded)
			try { b++; } catch (e) { void e; }        // catch +1
			return a > 0 ? 1 : 2;                     // ternary +1
		}`;
		// base 1 + if + && + || + for + while + 2*case + catch + ternary = 10
		expect(byName(src, "f")?.cyclomatic).toBe(10);
	});

	it("does not count a `default:` clause", () => {
		expect(byName(`function f(a: number) { switch (a) { default: return 0; } }`, "f")?.cyclomatic).toBe(1);
	});

	it("does not count `?.` optional chaining", () => {
		expect(byName(`function f(x: { v?: number } | null) { return x?.v; }`, "f")?.cyclomatic).toBe(1);
	});
});

describe("cyclomatic-ast — implementation functions only", () => {
	it("excludes bodiless overload signatures, keeping the implementation", () => {
		const src = `
			export function f(a: string): string;
			export function f(a: number): number;
			export function f(a: unknown): unknown { return a; }
		`;
		expect(run(src).filter((e) => e.name === "f").length).toBe(1);
	});

	it("counts methods, getters, and constructors", () => {
		const src = `class C { constructor() {} get x() { return 1; } m(a: number) { return a > 0 ? 1 : 2; } }`;
		const names = run(src).map((e) => e.name).sort();
		expect(names).toContain("constructor");
		expect(names).toContain("x");
		expect(names).toContain("m");
		expect(byName(src, "m")?.cyclomatic).toBe(2); // the ternary
	});

	it("reports accurate 1-based start lines (for coverage matching)", () => {
		const src = "\n\nfunction first() { return 1; }\nfunction second() { return 2; }\n";
		expect(byName(src, "first")?.line).toBe(3);
		expect(byName(src, "second")?.line).toBe(4);
	});
});
