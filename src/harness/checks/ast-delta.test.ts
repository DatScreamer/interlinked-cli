// Oracle tests for the AST semantic-delta profile (7c).
// The headline contract: a pure rename is textually large but structurally
// zero; a rewritten conditional is textually small but structurally nonzero.
import { describe, expect, it } from "vitest";
import { astProfile, structuralDelta } from "./ast-delta.js";

function profileOf(code: string) {
	const p = astProfile(code, "fixture.ts");
	if (p === null) throw new Error("typescript optional dep missing in test env");
	return p;
}

describe("astProfile", () => {
	it("counts nodes and kinds, and carries cognitive totals", () => {
		const p = profileOf(`function f(a: boolean) { if (a) { return 1; } return 0; }`);
		expect(p.nodes).toBeGreaterThan(5);
		expect(p.kinds.IfStatement).toBe(1);
		expect(p.kinds.ReturnStatement).toBe(2);
		expect(p.cogTotal).toBe(1); // one if at nesting 0
		expect(p.cogMax).toBe(1);
	});

	it("returns null for unparseable inputs only when typescript is absent (never throws)", () => {
		// Malformed input still yields a best-effort tree — profile, not null.
		expect(astProfile("function {{{", "broken.ts")).not.toBeNull();
	});

	it("returns null for non-JS/TS files (foreign syntax must not be parsed as TS)", () => {
		expect(astProfile("def f():\n    return 1", "src/x.py")).toBeNull();
	});
});

describe("structuralDelta", () => {
	it("a pure rename is structurally ZERO despite touching every line", () => {
		const before = profileOf(`
function computeTotal(items: number[]): number {
  let total = 0;
  for (const item of items) { total += item; }
  return total;
}`);
		const after = profileOf(`
function sumAll(values: number[]): number {
  let acc = 0;
  for (const value of values) { acc += value; }
  return acc;
}`);
		expect(structuralDelta(before, after)).toBe(0);
	});

	it("an if→ternary rewrite is textually tiny but structurally nonzero", () => {
		const before = profileOf(`function f(a: boolean): number { if (a) { return 1; } return 2; }`);
		const after = profileOf(`function f(a: boolean): number { return a ? 1 : 2; }`);
		expect(structuralDelta(before, after)).toBeGreaterThan(0);
	});

	it("adding a function raises the delta by roughly its node count", () => {
		const before = profileOf(`export const x = 1;`);
		const withFn = profileOf(`export const x = 1;\nexport function f(a: number) { return a + 1; }`);
		const delta = structuralDelta(before, withFn);
		expect(delta).toBeGreaterThanOrEqual(withFn.nodes - before.nodes);
	});

	it("is symmetric", () => {
		const a = profileOf(`const a = 1;`);
		const b = profileOf(`function g() { return 2; }`);
		expect(structuralDelta(a, b)).toBe(structuralDelta(b, a));
	});

	it("identical content deltas to zero", () => {
		const code = `export function h(x: number) { return x * 2; }`;
		expect(structuralDelta(profileOf(code), profileOf(code))).toBe(0);
	});
});
