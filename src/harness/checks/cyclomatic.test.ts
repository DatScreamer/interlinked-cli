import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { computeCyclomaticComplexity } from "./cyclomatic.js";

describe("computeCyclomaticComplexity", () => {
	it("returns CC=1 for a trivial function with no decisions", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() { return 1; }`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(nonNull(entries[0]).name).toBe("foo");
		expect(nonNull(entries[0]).cyclomatic).toBe(1);
		expect(nonNull(entries[0]).line).toBe(1);
	});

	it("counts `if` as +1", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: number) {
				if (x > 0) return 1;
				return 0;
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).cyclomatic).toBe(2);
	});

	it("counts `else if` via the inner `if` (not `else`)", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: number) {
				if (x > 0) return 1;
				else if (x < 0) return -1;
				return 0;
			}`,
			"src/foo.ts",
		);
		// 1 base + 2 ifs (primary + else-if)
		expect(nonNull(entries[0]).cyclomatic).toBe(3);
	});

	it("counts `case` labels but not `default`", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: string) {
				switch (x) {
					case "a": return 1;
					case "b": return 2;
					default: return 0;
				}
			}`,
			"src/foo.ts",
		);
		// 1 base + 2 cases (default not counted)
		expect(nonNull(entries[0]).cyclomatic).toBe(3);
	});

	it("counts `catch` as +1", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() {
				try { risky(); }
				catch (e) { handle(e); }
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).cyclomatic).toBe(2);
	});

	it("counts ternaries", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: number) {
				return x > 0 ? 1 : 0;
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).cyclomatic).toBe(2);
	});

	it("counts `??` (nullish coalescing) as a branch, but not `?.` (optional chaining)", () => {
		// `??` is a genuine decision point (canonical cyclomatic counts it — the
		// AST pass fixed the old regex walker that silently dropped it). `?.` is
		// not a branch, so it adds nothing.
		const entries = computeCyclomaticComplexity(
			`function foo(x: { v?: number } | null) {
				return x?.v ?? 0;
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).cyclomatic).toBe(2); // base 1 + one `??`
	});

	it("does not count `?.` optional chaining on its own", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: { v?: number } | null) {
				return x?.v;
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).cyclomatic).toBe(1);
	});

	it("counts `&&` and `||`", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(a: boolean, b: boolean, c: boolean) {
				if (a && b || c) return 1;
				return 0;
			}`,
			"src/foo.ts",
		);
		// 1 base + 1 if + 1 && + 1 ||
		expect(nonNull(entries[0]).cyclomatic).toBe(4);
	});

	it("counts `for` and `while`", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(xs: number[]) {
				for (let i = 0; i < xs.length; i++) {
					doSomething(i);
				}
				while (running()) {
					tick();
				}
			}`,
			"src/foo.ts",
		);
		// 1 base + 1 for + 1 while
		expect(nonNull(entries[0]).cyclomatic).toBe(3);
	});

	it("detects arrow functions assigned to const", () => {
		const entries = computeCyclomaticComplexity(
			`const foo = (x: number) => {
				return x > 0 ? 1 : 0;
			};`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(nonNull(entries[0]).name).toBe("foo");
		expect(nonNull(entries[0]).cyclomatic).toBe(2);
	});

	it("detects class methods", () => {
		const entries = computeCyclomaticComplexity(
			`class Foo {
				bar(x: number) {
					if (x > 0) return 1;
					return 0;
				}
			}`,
			"src/foo.ts",
		);
		const bar = entries.find((e) => e.name === "bar");
		expect(bar).toBeDefined();
		expect(bar?.cyclomatic).toBe(2);
	});

	it("detects async / static / visibility-qualified class methods", () => {
		const entries = computeCyclomaticComplexity(
			`class Foo {
				public async doWork(x: number): Promise<number> {
					return x > 0 ? 1 : 0;
				}
				static helper(y: string) {
					if (y === "go") return 1;
					return 0;
				}
			}`,
			"src/foo.ts",
		);
		expect(entries.map((e) => e.name)).toEqual(
			expect.arrayContaining(["doWork", "helper"]),
		);
		expect(entries.find((e) => e.name === "doWork")?.cyclomatic).toBe(2);
		expect(entries.find((e) => e.name === "helper")?.cyclomatic).toBe(2);
	});

	it("does not misdetect `if`, `for`, `while`, `switch` as function names", () => {
		const entries = computeCyclomaticComplexity(
			`function wrapper(n: number) {
				if (n > 0) { return 1; }
				for (let i = 0; i < n; i++) { console.log(i); }
				while (n--) { tick(); }
			}`,
			"src/foo.ts",
		);
		// Only one function should be detected: `wrapper`.
		expect(entries).toHaveLength(1);
		expect(nonNull(entries[0]).name).toBe("wrapper");
	});

	it("does not misdetect ordinary function calls as method declarations", () => {
		const entries = computeCyclomaticComplexity(
			`function wrapper() {
				doSomething(x);
				other.method(y);
				handler();
			}`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(nonNull(entries[0]).name).toBe("wrapper");
	});

	it("skips test files entirely", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: boolean) { if (x) return 1; return 0; }`,
			"src/foo.test.ts",
		);
		expect(entries).toHaveLength(0);
	});

	it("returns empty for unsupported extensions", () => {
		const entries = computeCyclomaticComplexity(
			`func foo() -> Int { return 1 }`,
			"src/foo.swift",
		);
		expect(entries).toHaveLength(0);
	});

	it("does not fall through to the Rust walker for a non-Rust extension (dispatch checks the actual ext)", () => {
		// The Rust branch is `if (ext === RUST_EXT) return walkRust(lines)`. A
		// `.txt` file whose content happens to look exactly like a Rust `fn`
		// must still yield [] — this only holds if the check compares the real
		// extension rather than firing unconditionally once the earlier
		// python/go branches have been ruled out.
		const entries = computeCyclomaticComplexity(`fn foo() { return 1; }`, "src/foo.txt");
		expect(entries).toHaveLength(0);
	});

	describe("Python", () => {
		it("detects `def` functions and counts `if`", () => {
			const entries = computeCyclomaticComplexity(
				`def foo(x):
    if x > 0:
        return 1
    return 0
`,
				"src/foo.py",
			);
			expect(entries).toHaveLength(1);
			expect(nonNull(entries[0]).name).toBe("foo");
			expect(nonNull(entries[0]).language).toBe("python");
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("counts `elif`, `for`, `while`, `except`", () => {
			const entries = computeCyclomaticComplexity(
				`def foo(xs):
    for x in xs:
        if x == 0:
            pass
        elif x > 0:
            pass
    while running():
        tick()
    try:
        risky()
    except Exception:
        handle()
`,
				"src/foo.py",
			);
			// 1 base + 1 for + 1 if + 1 elif + 1 while + 1 except = 6
			expect(nonNull(entries[0]).cyclomatic).toBe(6);
		});

		it("counts `and` and `or` as decision points", () => {
			const entries = computeCyclomaticComplexity(
				`def foo(a, b, c):
    if a and b or c:
        return 1
    return 0
`,
				"src/foo.py",
			);
			// 1 base + 1 if + 1 and + 1 or = 4
			expect(nonNull(entries[0]).cyclomatic).toBe(4);
		});

		it("detects `async def`", () => {
			const entries = computeCyclomaticComplexity(
				`async def fetch(url):
    if url:
        return await get(url)
`,
				"src/foo.py",
			);
			expect(nonNull(entries[0]).name).toBe("fetch");
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("counts a single-line ternary expression (`x if cond else y`)", () => {
			const entries = computeCyclomaticComplexity(
				`def grade(x):
    y = 1 if x else 0
    return y
`,
				"src/foo.py",
			);
			// base 1 + ternary (meaningful `y =` before `if`) = 2
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("counts `case` labels in a structural-pattern `match`", () => {
			// PY_CASE fires on each `case` arm of a 3.10+ `match` block.
			const entries = computeCyclomaticComplexity(
				`def classify(x):
    match x:
        case 0:
            return "zero"
        case 1:
            return "one"
    return "many"
`,
				"src/foo.py",
			);
			// base 1 + 2 `case` arms = 3
			expect(nonNull(entries[0]).cyclomatic).toBe(3);
		});

		it("does not double-count a statement `if` as a ternary", () => {
			const entries = computeCyclomaticComplexity(
				`def gate(x):
    if x:
        return 1
    return 0
`,
				"src/foo.py",
			);
			// base 1 + the statement `if` only (no text precedes `if`, so the
			// ternary heuristic does not also fire) = 2
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("counts a statement `if` that also contains `else` exactly once", () => {
			// A body line where the leading token is `if` and `else` appears later
			// (e.g. a one-line conditional after stripping) matches the ternary
			// regex, but the ternary heuristic must NOT add a second increment:
			// there's no text before `if`, so it's a statement opener already
			// counted, not an `a if c else b` expression. This pins the false arm
			// of the "meaningful text before `if`" guard.
			const entries = computeCyclomaticComplexity(
				`def branchy(x):
    if x else y
    return 0
`,
				"src/foo.py",
			);
			// base 1 + the single statement `if` (ternary guard suppressed) = 2
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("ends the body at the first line dedented to/under the def indent", () => {
			// `bar` is at module indent, so `foo`'s body stops before it: foo keeps
			// only its own `if`, and a second independent entry is emitted for bar.
			const entries = computeCyclomaticComplexity(
				`def foo(x):
    if x:
        return 1
def bar(y):
    return y
`,
				"src/foo.py",
			);
			expect(entries.map((e) => e.name)).toEqual(["foo", "bar"]);
			expect(entries.find((e) => e.name === "foo")?.cyclomatic).toBe(2);
			expect(entries.find((e) => e.name === "bar")?.cyclomatic).toBe(1);
			// foo's body is lines 1-3; the dedent at line 4 (`def bar`) ends it.
			expect(entries.find((e) => e.name === "foo")?.endLine).toBe(3);
		});

		it("skips blank lines inside the body without ending it", () => {
			// The blank line between two indented statements must not terminate the
			// body; the dedented `x = 1` at module level does.
			const entries = computeCyclomaticComplexity(
				`def foo(x):
    a = x

    if a:
        return 1
x = 1
`,
				"src/foo.py",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(2); // base 1 + the post-blank `if`
			expect(foo?.endLine).toBe(5);
		});

		it("treats a whitespace-only line (spaces, not just literal empty) as blank inside a body", () => {
			// `bodyLine.trim() === ""` must catch lines that are ALL whitespace,
			// not just the exact empty string — otherwise the line falls through
			// to the indent check, whose `search(/\S/)` returns -1 on an
			// all-whitespace line, which is `<= headIndent` and ends the body
			// early (dropping the `if` and its endLine below).
			const entries = computeCyclomaticComplexity(
				"def foo(x):\n    a = x\n    \n    if a:\n        return 1\nx = 1\n",
				"src/foo.py",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(2); // base 1 + the post-blank `if`
			expect(foo?.endLine).toBe(5);
		});

		it("reports the `def` line as 1-based (i + 1, not i - 1)", () => {
			const entries = computeCyclomaticComplexity(
				"x = 1\ndef foo():\n    return 1\n",
				"src/foo.py",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.line).toBe(2);
		});

		it("does not detect a `def` keyword appearing mid-line (PY_DEF requires start-of-line)", () => {
			const entries = computeCyclomaticComplexity(
				"x = 1; def foo():\n    return 1\n",
				"src/foo.py",
			);
			expect(entries).toHaveLength(0);
		});

		it("detects an indented `def` nested under other code (leading \\s* must allow real whitespace)", () => {
			const entries = computeCyclomaticComplexity(
				"if True:\n    def nested():\n        return 1\n",
				"src/foo.py",
			);
			expect(entries.map((e) => e.name)).toEqual(["nested"]);
		});

		it("recognizes PY_DEF with doubled internal whitespace and a space before the paren", () => {
			const entries = computeCyclomaticComplexity(
				[
					"async  def withExtraSpaceAfterAsync():",
					"    return 1",
					"def  withExtraSpaceAfterDef():",
					"    return 1",
					"def withExtraSpaceBeforeParen ():",
					"    return 1",
				].join("\n"),
				"src/foo.py",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withExtraSpaceAfterAsync",
				"withExtraSpaceAfterDef",
				"withExtraSpaceBeforeParen",
			]);
		});

		it("does not count a `case` substring appearing after other text (PY_CASE requires start-of-line)", () => {
			const entries = computeCyclomaticComplexity(
				"def foo(x):\n    x = case 1\n    return 0\n",
				"src/foo.py",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(1);
		});

		describe("the `:`-anchor guard on the ternary heuristic (beforeIf must not end in a bare colon)", () => {
			it("suppresses the ternary count when beforeIf ends exactly at a colon", () => {
				// beforeIf = "note:" -- ends in `:` with zero trailing whitespace.
				// Pins both the trailing `$` anchor and that the whitespace
				// quantifier after `:` is zero-or-more, not exactly one.
				const entries = computeCyclomaticComplexity(
					"def foo(x):\n    note: if x else 0\n    return 0\n",
					"src/foo.py",
				);
				const foo = entries.find((e) => e.name === "foo");
				expect(foo?.cyclomatic).toBe(1);
			});

			it("does NOT suppress when the colon is mid-string, not at the end of beforeIf", () => {
				// beforeIf = "d: y = 1" -- contains a colon, but doesn't END with
				// one. Pins the `$` anchor: an unanchored version would wrongly
				// find the colon anywhere in beforeIf and suppress this too.
				const entries = computeCyclomaticComplexity(
					"def foo(x):\n    d: y = 1 if flag else 0\n    return 0\n",
					"src/foo.py",
				);
				const foo = entries.find((e) => e.name === "foo");
				expect(foo?.cyclomatic).toBe(2); // base 1 + the ternary
			});

			it("does NOT suppress when the colon is followed by non-whitespace all the way to the end", () => {
				// beforeIf = "note:x" -- pins that the char class after `:` is
				// whitespace (\s), not non-whitespace (\S).
				const entries = computeCyclomaticComplexity(
					"def foo(x):\n    note:x if flag else 0\n    return 0\n",
					"src/foo.py",
				);
				const foo = entries.find((e) => e.name === "foo");
				expect(foo?.cyclomatic).toBe(2); // base 1 + the ternary
			});
		});
	});

	describe("Go", () => {
		it("detects `func` and counts `if`", () => {
			const entries = computeCyclomaticComplexity(
				`func foo(x int) int {
	if x > 0 {
		return 1
	}
	return 0
}`,
				"src/foo.go",
			);
			expect(entries).toHaveLength(1);
			expect(nonNull(entries[0]).name).toBe("foo");
			expect(nonNull(entries[0]).language).toBe("go");
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("detects methods with receivers", () => {
			const entries = computeCyclomaticComplexity(
				`func (s *Server) Handle(x int) error {
	if x < 0 {
		return errBad
	}
	return nil
}`,
				"src/server.go",
			);
			expect(nonNull(entries[0]).name).toBe("Handle");
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("counts `case` labels in switch / select", () => {
			const entries = computeCyclomaticComplexity(
				`func foo(x string) int {
	switch x {
	case "a":
		return 1
	case "b":
		return 2
	default:
		return 0
	}
}`,
				"src/foo.go",
			);
			// 1 base + 2 cases (default not counted)
			expect(nonNull(entries[0]).cyclomatic).toBe(3);
		});

		it("counts `&&` and `||`", () => {
			const entries = computeCyclomaticComplexity(
				`func foo(a, b, c bool) bool {
	if a && b || c {
		return true
	}
	return false
}`,
				"src/foo.go",
			);
			// 1 base + 1 if + 1 && + 1 ||
			expect(nonNull(entries[0]).cyclomatic).toBe(4);
		});

		it("emits no entry when no opening brace is found within the lookahead", () => {
			// The brace is pushed well past the 10-line scan window, so `func foo`
			// is detected but discarded (no body span found).
			const filler = Array.from({ length: 12 }, () => "\t// pad").join("\n");
			const entries = computeCyclomaticComplexity(
				`func foo(x int) int\n${filler}\n{\n\treturn x\n}`,
				"src/foo.go",
			);
			expect(entries.find((e) => e.name === "foo")).toBeUndefined();
		});

		it("discards a func whose braces never close (unbalanced body)", () => {
			const entries = computeCyclomaticComplexity(
				`func foo() int {
	x := 1
	doThing(x)`,
				"src/foo.go",
			);
			expect(entries).toHaveLength(0);
		});

		it("reports the `func` line as 1-based (i + 1, not i - 1)", () => {
			const entries = computeCyclomaticComplexity(
				"x := 1\nfunc foo() int {\n\treturn 1\n}",
				"src/foo.go",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.line).toBe(2);
		});

		it("reports the func body's endLine as 1-based (walk.endLine + 1, not - 1)", () => {
			const entries = computeCyclomaticComplexity("func foo() int {\n\treturn 1\n}", "src/foo.go");
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.endLine).toBe(3);
		});

		it("does not detect a `func` keyword appearing mid-line (GO_FUNC requires start-of-line)", () => {
			const entries = computeCyclomaticComplexity(
				"x := 1; func foo() int {\n\treturn 1\n}",
				"src/foo.go",
			);
			expect(entries).toHaveLength(0);
		});

		it("detects an indented `func` nested under other code (leading \\s* must allow real whitespace)", () => {
			const entries = computeCyclomaticComplexity(
				"if true {\n\tfunc foo() int {\n\t\treturn 1\n\t}\n}",
				"src/foo.go",
			);
			expect(entries.map((e) => e.name)).toEqual(["foo"]);
		});

		it("recognizes GO_FUNC with doubled internal whitespace and a space before the paren", () => {
			const entries = computeCyclomaticComplexity(
				[
					"func  withExtraSpaceAfterFunc() int { return 1 }",
					"func (s *S)  withExtraSpaceAfterReceiver() int { return 1 }",
					"func withExtraSpaceBeforeParen () int { return 1 }",
				].join("\n"),
				"src/foo.go",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withExtraSpaceAfterFunc",
				"withExtraSpaceAfterReceiver",
				"withExtraSpaceBeforeParen",
			]);
		});

		it("does not count an `if`-like word (e.g. `iffy`) as a decision keyword", () => {
			// GO_DECISION_KEYWORD requires whitespace-or-`(` immediately after
			// `if`/`for`. A `\S*` in place of `\s*` there could reach past filler
			// letters (the "fy" in "iffy") to a later space and wrongly match.
			const entries = computeCyclomaticComplexity(
				"func foo() int {\n\tiffy x\n\treturn 1\n}",
				"src/foo.go",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(1);
		});

		it("counts `if(x)` with no space as a decision (bracket class allows `(` or whitespace)", () => {
			const entries = computeCyclomaticComplexity(
				"func foo() int {\n\tif(x) {\n\t\treturn 1\n\t}\n\treturn 0\n}",
				"src/foo.go",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(2);
		});

		it("does not count a `case` substring appearing after other text (GO_CASE_LABEL requires start-of-line)", () => {
			const entries = computeCyclomaticComplexity(
				"func foo() int {\n\tx := case1(1)\n\treturn 0\n}",
				"src/foo.go",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(1);
		});

		it("still counts `case` with two leading spaces (leading \\s* is flexible, not exactly one)", () => {
			const entries = computeCyclomaticComplexity(
				"func foo() int {\n  case 1:\n\treturn 0\n}",
				"src/foo.go",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(2);
		});

		it("does not read past the end of the lines array when the 10-line lookahead is clamped by EOF", () => {
			// findOpeningBrace's `k < limit` must never become `k <= limit`: when
			// `fromIdx + 10` exceeds lines.length, `limit` clamps to lines.length,
			// and reading lines[limit] would be out of bounds — nonNull() throws
			// on the resulting undefined instead of the function returning -1.
			expect(() =>
				computeCyclomaticComplexity("func foo() int\n// pad\n// pad", "src/foo.go"),
			).not.toThrow();
			const entries = computeCyclomaticComplexity(
				"func foo() int\n// pad\n// pad",
				"src/foo.go",
			);
			expect(entries).toHaveLength(0);
		});

		it("does not count `case` (with real trailing whitespace) appearing after other code on the same line", () => {
			// The existing "case1(1)" mid-line test above has no whitespace
			// after "case" so it can't distinguish an anchored GO_CASE_LABEL
			// from an unanchored one (both fail identically). This fixture has
			// a genuine `case ` substring mid-line: an unanchored `\s*case\s+`
			// would match it anywhere in the string; the real, anchored
			// `^\s*case\s+` must not.
			const entries = computeCyclomaticComplexity(
				"func foo() int {\n\tx := 1; case 1:\n\treturn 0\n}",
				"src/foo.go",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.cyclomatic).toBe(1);
		});
	});

	describe("Rust", () => {
		it("detects `fn` and counts `if`", () => {
			const entries = computeCyclomaticComplexity(
				`fn foo(x: i32) -> i32 {
    if x > 0 {
        return 1;
    }
    0
}`,
				"src/foo.rs",
			);
			expect(entries).toHaveLength(1);
			expect(nonNull(entries[0]).name).toBe("foo");
			expect(nonNull(entries[0]).language).toBe("rust");
			expect(nonNull(entries[0]).cyclomatic).toBe(2);
		});

		it("detects `pub fn`, `async fn`, and `pub(crate) fn`", () => {
			const entries = computeCyclomaticComplexity(
				`pub fn a() -> i32 { 0 }
async fn b() -> i32 { 0 }
pub(crate) fn c() -> i32 { 0 }`,
				"src/lib.rs",
			);
			expect(entries.map((e) => e.name)).toEqual(["a", "b", "c"]);
		});

		it("counts `match` arms (`=>` tokens)", () => {
			const entries = computeCyclomaticComplexity(
				`fn foo(x: i32) -> i32 {
    match x {
        0 => 0,
        1 => 1,
        _ => 2,
    }
}`,
				"src/foo.rs",
			);
			// 1 base + 3 arms = 4
			expect(nonNull(entries[0]).cyclomatic).toBe(4);
		});

		it("counts `?` try operator", () => {
			const entries = computeCyclomaticComplexity(
				`fn foo() -> Result<i32, Error> {
    let v = parse()?;
    let w = next(v)?;
    Ok(w)
}`,
				"src/foo.rs",
			);
			// 1 base + 2 try-ops
			expect(nonNull(entries[0]).cyclomatic).toBe(3);
		});

		it("counts `&&` and `||`", () => {
			const entries = computeCyclomaticComplexity(
				`fn foo(a: bool, b: bool, c: bool) -> bool {
    if a && b || c {
        return true;
    }
    false
}`,
				"src/foo.rs",
			);
			// 1 base + 1 if + 1 && + 1 ||
			expect(nonNull(entries[0]).cyclomatic).toBe(4);
		});

		it("does not count `?Sized`-style trait bounds as the `?` try operator", () => {
			// RUST_TRY_OPERATOR excludes `?` followed by a letter/underscore, so the
			// `?Sized` bound adds nothing; only base complexity remains.
			const entries = computeCyclomaticComplexity(
				`fn store<T: ?Sized>(_value: &T) -> bool {
    true
}`,
				"src/foo.rs",
			);
			expect(nonNull(entries[0]).cyclomatic).toBe(1);
		});

		it("emits no entry when no opening brace is found within the lookahead", () => {
			const filler = Array.from({ length: 12 }, () => "    // pad").join("\n");
			const entries = computeCyclomaticComplexity(
				`fn foo(x: i32) -> i32\n${filler}\n{\n    x\n}`,
				"src/foo.rs",
			);
			expect(entries.find((e) => e.name === "foo")).toBeUndefined();
		});

		it("discards a fn whose braces never close (unbalanced body)", () => {
			const entries = computeCyclomaticComplexity(
				`fn foo() -> i32 {
    let x = 1;
    work(x);`,
				"src/foo.rs",
			);
			expect(entries).toHaveLength(0);
		});

		it("reports the `fn` line as 1-based (i + 1, not i - 1)", () => {
			const entries = computeCyclomaticComplexity(
				"let x = 1;\nfn foo() -> i32 {\n    1\n}",
				"src/foo.rs",
			);
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.line).toBe(2);
		});

		it("reports the fn body's endLine as 1-based (walk.endLine + 1, not - 1)", () => {
			const entries = computeCyclomaticComplexity("fn foo() -> i32 {\n    1\n}", "src/foo.rs");
			const foo = entries.find((e) => e.name === "foo");
			expect(foo?.endLine).toBe(3);
		});

		it("does not detect a `fn` keyword appearing mid-line (RUST_FN requires start-of-line)", () => {
			const entries = computeCyclomaticComplexity(
				"let x = 1; fn foo() -> i32 {\n    1\n}",
				"src/foo.rs",
			);
			expect(entries).toHaveLength(0);
		});

		it("detects an indented `fn` nested under other code (leading \\s* must allow real whitespace)", () => {
			const entries = computeCyclomaticComplexity(
				"mod m {\n    fn foo() -> i32 {\n        1\n    }\n}",
				"src/foo.rs",
			);
			expect(entries.map((e) => e.name)).toEqual(["foo"]);
		});

		it("recognizes RUST_FN with doubled internal whitespace, pre-paren, and pre/post-generic spacing", () => {
			const entries = computeCyclomaticComplexity(
				[
					"pub  fn withExtraSpaceAfterPub() -> i32 { 1 }",
					"async  fn withExtraSpaceAfterAsync() -> i32 { 1 }",
					"const  fn withExtraSpaceAfterConst() -> i32 { 1 }",
					"unsafe  fn withExtraSpaceAfterUnsafe() -> i32 { 1 }",
					"fn  withExtraSpaceAfterFn() -> i32 { 1 }",
					"fn withExtraSpaceBeforeParen () -> i32 { 1 }",
					"fn withSpaceBeforeGeneric <T>() -> i32 { 1 }",
					"fn withSpaceAfterGeneric<T> () -> i32 { 1 }",
				].join("\n"),
				"src/foo.rs",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withExtraSpaceAfterPub",
				"withExtraSpaceAfterAsync",
				"withExtraSpaceAfterConst",
				"withExtraSpaceAfterUnsafe",
				"withExtraSpaceAfterFn",
				"withExtraSpaceBeforeParen",
				"withSpaceBeforeGeneric",
				"withSpaceAfterGeneric",
			]);
		});
	});

	it("ignores `&&` inside string literals", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() {
				const msg = "a && b || c";
				return msg;
			}`,
			"src/foo.ts",
		);
		// 1 base, 0 decisions (string content is stripped)
		expect(nonNull(entries[0]).cyclomatic).toBe(1);
	});

	it("ignores `if` inside comments", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() {
				// if (this) were real, it would count
				/* if (not this either) */
				return 1;
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).cyclomatic).toBe(1);
	});

	it("reports start and end lines (1-based, inclusive)", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() {
				return 1;
			}`,
			"src/foo.ts",
		);
		expect(nonNull(entries[0]).line).toBe(1);
		expect(nonNull(entries[0]).endLine).toBe(3);
	});

	it("handles nested functions as independent entries", () => {
		const entries = computeCyclomaticComplexity(
			`function outer(x: number) {
				function inner(y: number) {
					return y > 0 ? 1 : 0;
				}
				return inner(x);
			}`,
			"src/foo.ts",
		);
		expect(entries.map((e) => e.name)).toEqual(
			expect.arrayContaining(["outer", "inner"]),
		);
		// outer's walker counts the whole body — outer body contains inner's `?:`
		// (the stripping doesn't differentiate nested function bodies; phase-0
		// compromise). So outer's CC counts the inner's ternary too.
		const inner = entries.find((e) => e.name === "inner");
		expect(inner?.cyclomatic).toBe(2);
	});
});

// =============================================================================
// Regex-walker fallback (mutation-registration companion)
//
// The suite above runs with `typescript` present (this repo always has it),
// so it exercises the AST pass (`computeCyclomaticAst`). This block forces
// every call through the hand-rolled regex walker instead (`walkJsTs` /
// `detectJsFunctionName` / `countJsDecisions`) — the path a published install
// takes when the optional `typescript` dep is absent. See
// `cyclomatic.coverage.test.ts` for the full walker-vs-AST behavioral
// contrast (`??` counted vs not, closures scoped vs rolled-up, etc); this
// block adds boundary-combination cases that file doesn't cover.
//
// These cases live HERE, in the exact companion stem the mutation runner
// overlays for this over-cap hub file, rather than in a fourth sibling file:
// a file named merely `*.coverage.test.ts` or `__tests__/*.test.ts` doesn't
// ship when this file's test-scope declines and the runner falls back to its
// fixed-glob guess, so kill-power placed anywhere else silently never
// registers.
//
// `vi.mock` is file-hoisted — calling it here would force EVERY test in this
// file (including the whole AST-path suite above) through the regex walker.
// `vi.doMock` is NOT hoisted: it only affects imports that happen after it
// runs, and it does not retroactively re-mock a module already loaded (the
// AST-path suite's top-level `computeCyclomaticComplexity` import already
// loaded the real `cyclomatic-ast.js` before any test runs). `resetModules()`
// discards that cached module instance so the next `import()` re-resolves
// through the mock, giving this block its own, independently-mocked function
// reference (`fallbackComplexity`) without touching the top-level one.
//
// All fixtures are synthetic identifiers — no real vendor/model/provider names.
// =============================================================================

describe("computeCyclomaticComplexity — regex-walker fallback (mutation-registration companion)", () => {
	let fallbackComplexity: typeof computeCyclomaticComplexity;

	beforeAll(async () => {
		vi.resetModules();
		vi.doMock("./cyclomatic-ast.js", () => ({
			computeCyclomaticAst: () => null,
			astComplexityAvailable: () => false,
			__resetTsCacheForTesting: () => {},
		}));
		const mod = await import("./cyclomatic.js");
		fallbackComplexity = mod.computeCyclomaticComplexity;
	});

	afterAll(() => {
		vi.doUnmock("./cyclomatic-ast.js");
		vi.resetModules();
	});

	describe("ast dispatch conditional", () => {
		it("P: falls through to the walker when the AST pass returns null, does not short-circuit to a hard-coded truthy return", () => {
			// `if (ast) return ast;` must stay conditioned on `ast` itself. With
			// the mock returning null, a condition hard-coded to `true` would
			// return that null directly instead of falling through to walkJsTs.
			const entries = fallbackComplexity(`function foo() { return 1; }`, "src/foo.ts");
			expect(entries).not.toBeNull();
			expect(Array.isArray(entries)).toBe(true);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.name).toBe("foo");
		});
	});

	describe("JS_NAMED_FUNCTION boundary combinations", () => {
		it("N: does not match a `function` keyword appearing mid-line (requires start-of-line)", () => {
			const entries = fallbackComplexity(
				`function wrapper() {\n\tx = function foo() { return 1; };\n}`,
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual(["wrapper"]);
		});
		it("P: detects an indented declaration (leading \\s* allows real whitespace)", () => {
			const entries = fallbackComplexity(`if (true) {\n\tfunction nested() { return 1; }\n}`, "src/foo.ts");
			expect(entries.map((e) => e.name)).toEqual(["nested"]);
		});
		it("P: recognizes optional export/default/async prefixes with doubled internal whitespace", () => {
			const entries = fallbackComplexity(
				[
					"export  function withExtraSpaceAfterExport() { return 1; }",
					"export default  function withExtraSpaceAfterDefault() { return 1; }",
					"async  function withExtraSpaceAfterAsync() { return 1; }",
					"function  withExtraSpaceAfterKeyword() { return 1; }",
				].join("\n"),
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withExtraSpaceAfterExport",
				"withExtraSpaceAfterDefault",
				"withExtraSpaceAfterAsync",
				"withExtraSpaceAfterKeyword",
			]);
		});
		it("P: recognizes generic type params under whitespace variation, and zero whitespace before the paren", () => {
			const entries = fallbackComplexity(
				[
					"function spacedBeforeGeneric <T>() { return 1; }",
					"function multiCharGeneric<TU>() { return 1; }",
					"function spacedAfterGeneric<T> () { return 1; }",
					"function noSpaceAtAll<T>(){ return 1; }",
					"function tight(){ return 1; }",
				].join("\n"),
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"spacedBeforeGeneric",
				"multiCharGeneric",
				"spacedAfterGeneric",
				"noSpaceAtAll",
				"tight",
			]);
		});
	});

	describe("JS_ARROW_ASSIGNED boundary combinations", () => {
		it("N: does not match a const/let/var declarator appearing mid-line (requires start-of-line)", () => {
			const entries = fallbackComplexity(
				`function wrapper() {\n\tx; const foo = () => { return 1; };\n}`,
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual(["wrapper"]);
		});
		it("P: detects an indented declarator (leading \\s* allows real whitespace)", () => {
			const entries = fallbackComplexity(`if (true) {\n\tconst nested = () => { return 1; };\n}`, "src/foo.ts");
			expect(entries.map((e) => e.name)).toEqual(["nested"]);
		});
		it("P: recognizes declarator/async keywords with doubled internal whitespace", () => {
			const entries = fallbackComplexity(
				[
					"export  const withExtraSpaceAfterExport = () => { return 1; };",
					"const  withExtraSpaceAfterKeyword = () => { return 1; };",
					"const withExtraSpaceAfterAsync = async  () => { return 1; };",
				].join("\n"),
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withExtraSpaceAfterExport",
				"withExtraSpaceAfterKeyword",
				"withExtraSpaceAfterAsync",
			]);
		});
		it("P: recognizes param and return type annotations under whitespace variation, and zero whitespace everywhere", () => {
			const entries = fallbackComplexity(
				[
					"const withSpaceBeforeColon : Type = () => { return 1; };",
					"const compactAnnotation:Type=() => { return 1; };",
					"const withSpaceBeforeReturnType = () : Type => { return 1; };",
					"const tight=()=>{ return 1; };",
				].join("\n"),
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withSpaceBeforeColon",
				"compactAnnotation",
				"withSpaceBeforeReturnType",
				"tight",
			]);
		});
		it("P: non-empty param list is still matched ([^)]* content, not just empty parens)", () => {
			const entries = fallbackComplexity(`const foo = (a,b,c) => { return 1; };`, "src/foo.ts");
			expect(entries.map((e) => e.name)).toEqual(["foo"]);
		});
		it("P: matches with zero whitespace right after the return-type colon", () => {
			const entries = fallbackComplexity(`const foo = ():Type => { return 1; };`, "src/foo.ts");
			expect(entries.map((e) => e.name)).toEqual(["foo"]);
		});
	});

	describe("JS_METHOD_LINE boundary combinations", () => {
		it("N: does not match a method-shaped fragment appearing mid-line (requires start-of-line)", () => {
			const entries = fallbackComplexity(`function wrapper() {\n\ty = bar() { return 1; }\n}`, "src/foo.ts");
			expect(entries.map((e) => e.name)).toEqual(["wrapper"]);
		});
		it("P: recognizes every modifier keyword with doubled internal whitespace", () => {
			const entries = fallbackComplexity(
				[
					"class Widget {",
					"\tasync  withExtraSpaceAfterAsync() { return 1; }",
					"\tstatic  withExtraSpaceAfterStatic() { return 1; }",
					"\tpublic  withExtraSpaceAfterPublic() { return 1; }",
					"\tprivate  withExtraSpaceAfterPrivate() { return 1; }",
					"\tprotected  withExtraSpaceAfterProtected() { return 1; }",
					"\treadonly  withExtraSpaceAfterReadonly() { return 1; }",
					"\toverride  withExtraSpaceAfterOverride() { return 1; }",
					"\tget  withExtraSpaceAfterGet() { return 1; }",
					"}",
				].join("\n"),
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"withExtraSpaceAfterAsync",
				"withExtraSpaceAfterStatic",
				"withExtraSpaceAfterPublic",
				"withExtraSpaceAfterPrivate",
				"withExtraSpaceAfterProtected",
				"withExtraSpaceAfterReadonly",
				"withExtraSpaceAfterOverride",
				"withExtraSpaceAfterGet",
			]);
		});
		it("P: recognizes generic type params under whitespace variation, and zero whitespace everywhere", () => {
			const entries = fallbackComplexity(
				[
					"class Widget {",
					"\tspacedBeforeGeneric <T>() { return 1; }",
					"\tmultiCharGeneric<TU>() { return 1; }",
					"\tspacedAfterGeneric<T> () { return 1; }",
					"\tnoSpaceAtAll<T>(){ return 1; }",
					"\ttight(){return 1;}",
					"}",
				].join("\n"),
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual([
				"spacedBeforeGeneric",
				"multiCharGeneric",
				"spacedAfterGeneric",
				"noSpaceAtAll",
				"tight",
			]);
		});
		it("P: recognizes a return-type annotation, both with whitespace and with zero whitespace after the colon", () => {
			const entries = fallbackComplexity(
				`class Widget {\n\ttyped(x) : number  { return 1; }\n\ttyped2(x):number { return 1; }\n}`,
				"src/foo.ts",
			);
			expect(entries.map((e) => e.name)).toEqual(["typed", "typed2"]);
		});
		it("P: matches a 2-character leading indent (the capture group needs 1+ whitespace chars, not exactly 1)", () => {
			const entries = fallbackComplexity(`class Widget {\n\t\ttwoTabIndent() { return 1; }\n}`, "src/foo.ts");
			expect(entries.map((e) => e.name)).toEqual(["twoTabIndent"]);
		});
	});

	it("N: rejects EVERY reserved head word as a method name (JS_RESERVED_HEAD_WORDS must be exhaustive)", () => {
		// One line per member, mirroring the set exactly. A single word
		// dropped from the set (StringLiteral blanked to "") OR the whole
		// array wiped ([]) both leak that word through as an EXTRA detected
		// "method" here — verified redundant against 41 additional
		// one-word-isolated fixtures (scratch/fleet-r3 shadow-verify:
		// removing them changed 0 kill outcomes), so this single exhaustive
		// fixture is the complete, non-duplicated kill for the whole family.
		const RESERVED_WORDS = [
			"function", "if", "for", "while", "switch", "return", "typeof", "new",
			"await", "throw", "yield", "case", "default", "break", "continue", "do",
			"else", "try", "catch", "finally", "void", "delete", "const", "let",
			"var", "class", "extends", "implements", "interface", "type", "enum",
			"import", "export", "from", "as", "in", "of", "true", "false", "null",
			"undefined",
		];
		const body = RESERVED_WORDS.map((w) => `\t${w}() { return 1; }`).join("\n");
		const entries = fallbackComplexity(`function wrapper() {\n${body}\n}`, "src/foo.ts");
		expect(entries.map((e) => e.name)).toEqual(["wrapper"]);
	});

	describe("JS_DECISION_KEYWORD / JS_CASE_LABEL / JS_TERNARY", () => {
		it("N: does not misfire on iffy(x) (needs whitespace-or-paren immediately after the keyword)", () => {
			const entries = fallbackComplexity(`function foo() {\n\tiffy(x);\n\treturn 1;\n}`, "src/foo.ts");
			expect(entries[0]?.cyclomatic).toBe(1);
		});
		it("P: counts if/for/while/catch with doubled whitespace before the paren", () => {
			const entries = fallbackComplexity(
				[
					"function foo(xs) {",
					"\tif  (xs.length) {",
					"\t\tfor (let i = 0; i < xs.length; i++) {",
					"\t\t\twhile (xs[i]) {",
					"\t\t\t\ttry { risky(); } catch (e) { handle(e); }",
					"\t\t\t}",
					"\t\t}",
					"\t}",
					"\treturn 0;",
					"}",
				].join("\n"),
				"src/foo.ts",
			);
			// base 1 + if + for + while + catch = 5
			expect(entries[0]?.cyclomatic).toBe(5);
		});
		it("P: counts case labels split from the colon by non-whitespace text (needs \\s+, not \\S+)", () => {
			const entries = fallbackComplexity(
				`function pick(x) {\n\tswitch (x) {\n\t\tcase "a": return 1;\n\t\tcase "b": return 2;\n\t\tdefault: return 0;\n\t}\n}`,
				"src/foo.ts",
			);
			// base 1 + 2 case labels (default excluded)
			expect(entries[0]?.cyclomatic).toBe(3);
		});
		it("P: counts ternary + &&/||, both compact and with doubled whitespace around case", () => {
			const entries = fallbackComplexity(
				[
					"function decide(a, b, c) {",
					'\tswitch (a) {',
					'\t\tcase  "a": return 1;',
					'\t\tcase  "b": return 2;',
					"\t}",
					"\tconst r = a && b || c ? 1 : 0;",
					"\treturn r;",
					"}",
				].join("\n"),
				"src/foo.ts",
			);
			// base 1 + 2 case + && + || + ternary = 6
			expect(entries[0]?.cyclomatic).toBe(6);
		});
		it("N: does not count ?? (nullish) or ?. (optional chaining)", () => {
			const entries = fallbackComplexity(
				`function fallbacky(x) {\n\tconst y = x ?? 0;\n\treturn x?.y;\n}`,
				"src/foo.ts",
			);
			expect(entries[0]?.cyclomatic).toBe(1);
		});
	});

	it("N: discards a function whose brace walk exhausts the file without ever balancing (closed starts false, not true)", () => {
		const entries = fallbackComplexity(
			`function unbalanced() {\n\tif (a) doThing();\n\tstillGoing();\n\tneverCloses();`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(0);
	});
});
