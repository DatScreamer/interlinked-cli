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
