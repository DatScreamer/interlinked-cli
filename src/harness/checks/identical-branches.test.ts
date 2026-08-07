import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkIdenticalBranches } from "./identical-branches.js";

// ---------------------------------------------------------------------------
// Positive cases — MUST fire (identical branches → condition has no effect)
// ---------------------------------------------------------------------------

describe("checkIdenticalBranches — positive (must fire)", () => {
	it("fires on the Rust expression-if from the report (both arms `val`)", () => {
		// The exact shape in the bug report: `if cond { val } else { val }`.
		const content = `
fn pick(condition: bool) -> i32 {
    if condition {
        val
    } else {
        val
    }
}
`.trim();
		const found = checkIdenticalBranches(content, "src/pick.rs");
		expect(found.length).toBeGreaterThan(0);
		expect(nonNull(found[0]).text).toMatch(/identical if\/else branches/);
	});

	it("fires on a TS if/else with identical return statements", () => {
		const content = `
export function clamp(x: number): number {
  if (x > 0) {
    return x;
  } else {
    return x;
  }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/clamp.ts").length).toBeGreaterThan(0);
	});

	it("fires on a Go if/else with identical assignment bodies", () => {
		const content = `
func choose(flag bool) {
	if flag {
		result = compute()
	} else {
		result = compute()
	}
}
`.trim();
		expect(checkIdenticalBranches(content, "main.go").length).toBeGreaterThan(0);
	});

	it("fires on a C identical-branch if/else", () => {
		const content = `
int f(int c) {
    if (c) {
        return 1 + g();
    } else {
        return 1 + g();
    }
}
`.trim();
		expect(checkIdenticalBranches(content, "f.c").length).toBeGreaterThan(0);
	});

	it("fires on a ternary returning the same value both ways", () => {
		const content = `const label = isActive ? "ready" : "ready";`;
		const found = checkIdenticalBranches(content, "src/label.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(nonNull(found[0]).text).toMatch(/identical ternary results/);
	});

	it("fires on a multi-line ternary with identical operands", () => {
		const content = `
const value = cond
  ? computeValue(a, b)
  : computeValue(a, b);
`.trim();
		expect(checkIdenticalBranches(content, "src/value.ts").length).toBeGreaterThan(0);
	});

	it("reports the correct 1-based line for the if/else", () => {
		const content = `line1\nif (x) {\n  go();\n} else {\n  go();\n}\n`;
		const found = checkIdenticalBranches(content, "src/x.ts");
		expect(found.length).toBeGreaterThan(0);
		// The closing `}` of the then-arm sits on line 4.
		expect(nonNull(found[0]).line).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Negative cases — MUST NOT fire (legitimate divergent branches)
// ---------------------------------------------------------------------------

describe("checkIdenticalBranches — negative (must NOT fire)", () => {
	it("does NOT fire when the branches genuinely differ", () => {
		const content = `
export function pick(x: number): number {
  if (x > 0) {
    return x;
  } else {
    return -x;
  }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/pick.ts")).toEqual([]);
	});

	it("does NOT fire when only the string literal differs (strings preserved)", () => {
		const content = `
function status(ok: boolean): string {
  if (ok) {
    return "ready";
  } else {
    return "failed";
  }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/status.ts")).toEqual([]);
	});

	it("does NOT fire on an empty if/else (no body to compare)", () => {
		const content = `if (x) {} else {}`;
		expect(checkIdenticalBranches(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire on nested if/else where the inner blocks differ", () => {
		const content = `
function f(a: boolean, b: boolean): number {
  if (a) {
    if (b) { return 1; }
    return 2;
  } else {
    return 3;
  }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/f.ts")).toEqual([]);
	});

	it("does NOT fire on a normal ternary with different operands", () => {
		const content = `const n = positive ? value : -value;`;
		expect(checkIdenticalBranches(content, "src/n.ts")).toEqual([]);
	});

	it("does NOT confuse optional chaining / nullish for a ternary", () => {
		const content = `const v = obj?.prop ?? fallback;\nconst w = a?.b?.c;`;
		expect(checkIdenticalBranches(content, "src/v.ts")).toEqual([]);
	});

	it("does NOT fire on `} else {` that lives inside a string or comment", () => {
		const content = `
const doc = "if (x) { a } else { a }";
// if (y) { z } else { z }
function real(x: number): number {
  if (x) {
    return x + 1;
  } else {
    return x - 1;
  }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/doc.ts")).toEqual([]);
	});

	it("does NOT fire on a TS optional parameter marker `x?: T`", () => {
		const content = `function g(x?: number, y?: string): void { use(x, y); }`;
		expect(checkIdenticalBranches(content, "src/g.ts")).toEqual([]);
	});

	it("does NOT scan non-brace languages (Python is out of scope)", () => {
		const content = `
def pick(cond):
    if cond:
        return val
    else:
        return val
`.trim();
		expect(checkIdenticalBranches(content, "pick.py")).toEqual([]);
	});

	it("does NOT scan non-code files", () => {
		const content = `if (x) { a } else { a }`;
		expect(checkIdenticalBranches(content, "README.md")).toEqual([]);
	});

	it("does NOT fire on Rust lifetimes sharing a line with a brace", () => {
		// The lifetime `'a` must not unbalance the brace scan and mis-pair blocks.
		const content = `
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() {
        x
    } else {
        y
    }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/lifetime.rs")).toEqual([]);
	});

	it("does NOT fire on a chain whose final two arms differ", () => {
		const content = `
function grade(n: number): string {
  if (n > 90) {
    return "A";
  } else if (n > 80) {
    return "B";
  } else {
    return "C";
  }
}
`.trim();
		expect(checkIdenticalBranches(content, "src/grade.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Branch-coverage batch — unmatched braces, caps, long snippets, ternary
// edge cases (findTernaryColon / findTernaryEnd boundary conditions).
// ---------------------------------------------------------------------------

describe("checkIdenticalBranches — branch coverage batch", () => {
	it("truncates a long identical branch body in the snippet text (SNIPPET_MAX)", () => {
		const body = "x".repeat(90);
		const content = `if (flag) {\n  ${body}\n} else {\n  ${body}\n}`;
		const found = checkIdenticalBranches(content, "src/long.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.text).toContain("…");
		// Un-truncated body would be 90 chars; SNIPPET_MAX (70) + ellipsis caps it.
		expect(found[0]?.text.length).toBeLessThan(content.length);
	});

	it("does not truncate a short identical branch body (no ellipsis)", () => {
		const content = `if (flag) {\n  a();\n} else {\n  a();\n}`;
		const found = checkIdenticalBranches(content, "src/short.ts");
		expect(found[0]?.text).not.toContain("…");
	});

	it("does NOT fire when the `} else {` closer has no matching open brace (unbalanced)", () => {
		// A stray "} else { ... }" with no preceding matching "{" — matchOpenBrace
		// scans left from index 0 and exhausts the string without finding depth 0.
		const content = `} else {\n  doStuff();\n}`;
		expect(checkIdenticalBranches(content, "src/unbalanced-open.ts")).toEqual([]);
	});

	it("does NOT fire when the else block has no matching close brace (unbalanced)", () => {
		// A well-formed `if { ... } else {` whose else-body never closes —
		// matchCloseBrace scans right and exhausts the string without depth 0.
		const content = `if (x) {\n  a();\n} else {\n  a();`;
		expect(checkIdenticalBranches(content, "src/unbalanced-close.ts")).toEqual([]);
	});

	it("caps if/else findings at MAX_MATCHES and stops scanning further blocks", () => {
		const one = (n: number) => `if (x${n}) {\n  same();\n} else {\n  same();\n}`;
		const content = Array.from({ length: 12 }, (_, i) => one(i)).join("\n");
		const found = checkIdenticalBranches(content, "src/many-blocks.ts");
		expect(found).toHaveLength(10);
		// All 10 findings are the block form — ternary scanning never runs.
		expect(found.every((f) => f.text.includes("identical if/else branches"))).toBe(true);
	});

	it("caps ternary findings at MAX_MATCHES", () => {
		const one = (n: number) => `const v${n} = cond${n} ? same : same;`;
		const content = Array.from({ length: 12 }, (_, i) => one(i)).join("\n");
		const found = checkIdenticalBranches(content, "src/many-ternaries.ts");
		expect(found).toHaveLength(10);
		expect(found.every((f) => f.text.includes("identical ternary results"))).toBe(true);
	});

	it("does NOT fire on a ternary whose enclosing bracket closes before any colon", () => {
		// `(flag ? 1)` — the `?` at depth 0 relative to itself, but the `)` that
		// follows belongs to the OUTER "(" before the "?", so from the ternary
		// scanner's viewpoint depth goes negative: "left the enclosing expression".
		const content = `const x = (flag ? 1);`;
		expect(checkIdenticalBranches(content, "src/no-colon-paren.ts")).toEqual([]);
	});

	it("does NOT fire on a ternary whose statement ends (;) before any colon", () => {
		const content = `const x = flag ? 1;\nconst y = 2;`;
		expect(checkIdenticalBranches(content, "src/no-colon-semi.ts")).toEqual([]);
	});

	it("bails on a depth-0 nested ternary before any colon (no enclosing brackets)", () => {
		// `a ? b ? c : d : e` — the SECOND `?` sits at the same bracket depth as
		// the first, with no colon in between: findTernaryColon must reject this
		// as a nested ternary rather than misreading the inner `:` as its own.
		const content = `const x = a ? b ? c : d : e;`;
		expect(checkIdenticalBranches(content, "src/nested-ternary-depth0.ts")).toEqual([]);
	});

	it("does NOT read a parenthesized nested ternary's inner colon as the outer's", () => {
		const content = `const x = a ? (b ? c : d) : e;`;
		expect(checkIdenticalBranches(content, "src/nested-ternary-parens.ts")).toEqual([]);
	});

	it("fires on a ternary whose false branch runs to end-of-scan with no terminator", () => {
		// No trailing `;`, `,`, or bracket after the false branch — findTernaryEnd
		// must fall through to `end` (the scan boundary) rather than looping forever.
		const content = `const label = isActive ? "ready" : "ready"`;
		const found = checkIdenticalBranches(content, "src/eof-ternary.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.text).toMatch(/identical ternary results/);
	});

	it("does NOT fire on a ternary with no colon at all, ending at EOF", () => {
		// findTernaryColon's loop must exhaust and return -1 via its final
		// statement (no `;`, no `)`/`]`/`}` close, no nested `?`) rather than
		// throwing or looping past the end of the scan.
		const content = `const x = flag ? 1`;
		expect(checkIdenticalBranches(content, "src/no-colon-eof.ts")).toEqual([]);
	});

	it("fires on a ternary whose false branch ends at a closing bracket", () => {
		// `[cond ? a : a]` — findTernaryEnd must terminate at the `]` (depth 0,
		// "enclosing bracket closed") rather than treating it as nesting.
		const content = `const arr = [cond ? a : a];`;
		const found = checkIdenticalBranches(content, "src/bracket-close-ternary.ts");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.text).toMatch(/identical ternary results/);
	});

	it("does NOT fire when the else block contains nested braces (matchCloseBrace depth walk)", () => {
		// The else body's inner `{ y(); }` must not be mistaken for the closing
		// brace of the else block itself — matchCloseBrace has to walk past it
		// at depth > 0 before finding the real matching `}`.
		const content = `
if (a) {
  x();
} else {
  if (b) { y(); }
  z();
}
`.trim();
		expect(checkIdenticalBranches(content, "src/nested-else-braces.ts")).toEqual([]);
	});

	it("does NOT scan a vendored path even with an identical if/else", () => {
		const content = `if (x) {\n  a();\n} else {\n  a();\n}`;
		expect(checkIdenticalBranches(content, "node_modules/pkg/index.js")).toEqual([]);
	});

	it("does NOT scan a file carrying a generated-file marker", () => {
		const content = `// @generated by some-tool\nif (x) {\n  a();\n} else {\n  a();\n}`;
		expect(checkIdenticalBranches(content, "src/gen.ts")).toEqual([]);
	});

	it("short-circuits on content with neither `else` nor `?` (cheap pre-reject)", () => {
		const content = `function f() {\n  return compute();\n}`;
		expect(checkIdenticalBranches(content, "src/plain.ts")).toEqual([]);
	});
});
