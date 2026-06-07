// Supplementary coverage for the JS/TS REGEX-WALKER FALLBACK in cyclomatic.ts.
//
// `computeCyclomaticComplexity` prefers the TS-AST pass (`computeCyclomaticAst`)
// for JS/TS and only drops to the hand-rolled regex walker (`walkJsTs` /
// `detectJsFunctionName` / `countJsDecisions`) when the optional `typescript`
// dep is ABSENT — i.e. `computeCyclomaticAst` returns `null`. The sibling
// `cyclomatic.test.ts` runs with `typescript` present, so it exercises the AST
// path; this file mocks the AST module to return `null`, forcing every JS/TS
// case through the regex walker so its branches are pinned behaviorally.
//
// The walker's semantics differ from the AST pass on purpose, and those
// differences are the whole point of the published-install degradation note in
// the module header — so they are asserted here exactly:
//   - `??` (nullish coalescing) is NOT counted (no JS_TERNARY match).
//   - inline closures roll their decision points into the enclosing function
//     (no per-closure scope), unlike the AST pass.
//
// `vi.mock` is file-hoisted, so this MUST live in its own file: enabling it in
// `cyclomatic.test.ts` would corrupt that file's AST-path assertions.
//
// All fixtures use synthetic identifiers — no real vendor/model/provider names.

import { describe, expect, it, vi } from "vitest";
import { computeCyclomaticComplexity } from "./cyclomatic.js";

// Force the regex-walker fallback: pretend `typescript` is unavailable so the
// AST pass declines and `computeCyclomaticComplexity` calls `walkJsTs`.
vi.mock("./cyclomatic-ast.js", () => ({
	computeCyclomaticAst: () => null,
	astComplexityAvailable: () => false,
	__resetTsCacheForTesting: () => {},
}));

describe("computeCyclomaticComplexity — JS/TS regex-walker fallback", () => {
	it("named function: CC=1 for a trivial body (walker baseline)", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() { return 1; }`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("foo");
		expect(entries[0].cyclomatic).toBe(1);
		expect(entries[0].language).toBe("js_ts");
		expect(entries[0].line).toBe(1);
	});

	it("named function: counts if / for / while / catch keywords", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(xs) {
				if (xs.length) {
					for (let i = 0; i < xs.length; i++) {
						while (xs[i]) {
							try { risky(); } catch (e) { handle(e); }
						}
					}
				}
				return 0;
			}`,
			"src/foo.ts",
		);
		// base 1 + if + for + while + catch = 5
		expect(entries[0].cyclomatic).toBe(5);
	});

	it("named function: counts `case` labels (JS_CASE_LABEL)", () => {
		const entries = computeCyclomaticComplexity(
			`function pick(x) {
				switch (x) {
					case "a": return 1;
					case "b": return 2;
					default: return 0;
				}
			}`,
			"src/foo.ts",
		);
		// base 1 + 2 case labels (default excluded)
		expect(entries[0].cyclomatic).toBe(3);
	});

	it("named function: counts ternary (JS_TERNARY) and &&/|| symbols", () => {
		const entries = computeCyclomaticComplexity(
			`function decide(a, b, c) {
				const r = a && b || c ? 1 : 0;
				return r;
			}`,
			"src/foo.ts",
		);
		// base 1 + && + || + ternary = 4
		expect(entries[0].cyclomatic).toBe(4);
	});

	it("walker does NOT count `??` (the published-install degradation)", () => {
		// The AST pass counts `??`; the regex walker does not. This asymmetry is
		// the documented reason the AST pass exists.
		const entries = computeCyclomaticComplexity(
			`function fallbacky(x) {
				return x ?? 0;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(1);
	});

	it("walker does NOT count `?.` optional chaining", () => {
		const entries = computeCyclomaticComplexity(
			`function reach(x) {
				return x?.y;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(1);
	});

	it("detects an arrow function assigned to const (JS_ARROW_ASSIGNED)", () => {
		const entries = computeCyclomaticComplexity(
			`const grade = (n) => {
				return n > 0 ? 1 : 0;
			};`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("grade");
		expect(entries[0].cyclomatic).toBe(2);
	});

	it("detects a class method (JS_METHOD_LINE)", () => {
		const entries = computeCyclomaticComplexity(
			`class Widget {
				render(flag) {
					if (flag) return 1;
					return 0;
				}
			}`,
			"src/foo.ts",
		);
		const render = entries.find((e) => e.name === "render");
		expect(render).toBeDefined();
		expect(render?.cyclomatic).toBe(2);
	});

	it("detects async / static / visibility-qualified methods via the method regex", () => {
		const entries = computeCyclomaticComplexity(
			`class Service {
				public async run(x) {
					return x > 0 ? 1 : 0;
				}
				static helper(y) {
					if (y) return 1;
					return 0;
				}
			}`,
			"src/foo.ts",
		);
		expect(entries.find((e) => e.name === "run")?.cyclomatic).toBe(2);
		expect(entries.find((e) => e.name === "helper")?.cyclomatic).toBe(2);
	});

	it("rejects reserved-word heads so control statements are not method names", () => {
		// `if (...) {` matches JS_METHOD_LINE's shape but `if` is reserved, so the
		// candidate is dropped (line 171 guard) and only `wrapper` is detected.
		const entries = computeCyclomaticComplexity(
			`function wrapper(n) {
				if (n > 0) { return 1; }
				for (let i = 0; i < n; i++) { tick(); }
				while (n--) { tick(); }
				return 0;
			}`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("wrapper");
		// base 1 + if + for + while = 4 (walker counts the keyword forms)
		expect(entries[0].cyclomatic).toBe(4);
	});

	it("returns no entry when no function shape is detected (detectJsFunctionName null)", () => {
		const entries = computeCyclomaticComplexity(
			`const x = 1;
			const y = doThing(x);
			other.method(y);`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(0);
	});

	it("skips a function whose opening brace is not found within the lookahead window", () => {
		// `findOpeningBrace` scans only 10 lines from the declaration; push the `{`
		// past that window so the function is detected but yields no entry.
		const filler = Array.from({ length: 12 }, () => "  // padding").join("\n");
		const entries = computeCyclomaticComplexity(
			`function spread(a)\n${filler}\n{ return a; }`,
			"src/foo.ts",
		);
		expect(entries.find((e) => e.name === "spread")).toBeUndefined();
	});

	it("discards a function whose braces never close (walk.closed === false)", () => {
		// No closing brace at all -> the brace walker runs to EOF without
		// balancing, so the entry is dropped rather than emitted with a
		// wildly-inflated, EOF-spanning score.
		const entries = computeCyclomaticComplexity(
			`function leaky() {
				if (a) doThing();
				moreWork();`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(0);
	});

	it("inline closures roll into the enclosing function (no per-closure scope)", () => {
		// AST pass would split the callback into its own unit; the walker counts
		// the whole brace-balanced body, so the inner `?:` lands on the parent.
		const entries = computeCyclomaticComplexity(
			`function outer(xs) {
				return xs.map((v) => (v > 0 ? 1 : 0));
			}`,
			"src/foo.ts",
		);
		// Only the enclosing function is emitted by the walker name-detector here,
		// and its CC absorbs the inner ternary.
		const outer = entries.find((e) => e.name === "outer");
		expect(outer).toBeDefined();
		expect(outer?.cyclomatic).toBe(2);
	});

	it("emits 1-based inclusive start/end lines from the brace walker", () => {
		const entries = computeCyclomaticComplexity(
			`function spanned() {
				return 1;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].line).toBe(1);
		expect(entries[0].endLine).toBe(3);
	});

	it("ignores decision keywords inside comments and strings (stripForBraceScan)", () => {
		const entries = computeCyclomaticComplexity(
			`function clean() {
				// if (this) were real it would count
				const s = "a && b || c";
				return s;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(1);
	});
});
