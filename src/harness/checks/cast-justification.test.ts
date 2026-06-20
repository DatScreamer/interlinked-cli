import { describe, expect, it } from "vitest";
import { countUnjustifiedCasts, findUnjustifiedCasts } from "./cast-justification.js";

const n = (s: string) => findUnjustifiedCasts(s, "src/foo.ts").length;

describe("findUnjustifiedCasts", () => {
	// ── positives: real `as T` assertions with no justification ──────────────
	it("flags a plain `as T` cast with no justification", () => {
		expect(n("const x = foo as Bar;")).toBeGreaterThanOrEqual(1);
	});
	it("flags a double `as unknown as T` escape-hatch cast", () => {
		expect(n("const c = data as unknown as Config;")).toBeGreaterThanOrEqual(1);
	});
	it("flags a cast embedded in an expression", () => {
		expect(n("const total = (val as number) + 1;")).toBeGreaterThanOrEqual(1);
	});

	// ── negatives: legitimate patterns that must NOT fire ────────────────────
	it("does not flag `as const`", () => {
		expect(n("const tuple = [1, 2] as const;")).toBe(0);
	});
	it("does not flag a cast carrying a // SAFETY: justification (same or prior line)", () => {
		expect(n("// SAFETY: parseFoo validated the shape above\nconst x = foo as Bar;")).toBe(0);
		expect(n("const x = foo as Bar; // SAFETY: branded by the parser")).toBe(0);
	});
	it("does not flag an import rename `as`", () => {
		expect(n('import { foo as bar } from "./x.js";')).toBe(0);
	});
	it("does not flag an export rename `as`", () => {
		expect(n('export { a as b } from "./y.js";')).toBe(0);
	});
	it("does not flag cast-like text inside a string literal", () => {
		expect(n('const label = "treat this as Foo, please";')).toBe(0);
	});
});

describe("countUnjustifiedCasts", () => {
	it("matches the finder length and counts net occurrences across lines", () => {
		const src = ["const a = x as A;", "const b = y as B; // SAFETY: ok", "const c = z as C;"].join("\n");
		// lines 1 and 3 are unjustified; line 2 is justified.
		expect(countUnjustifiedCasts(src)).toBe(2);
	});
});
