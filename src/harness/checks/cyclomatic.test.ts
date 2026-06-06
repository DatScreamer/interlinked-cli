import { describe, expect, it } from "vitest";
import { computeCyclomaticComplexity } from "./cyclomatic.js";

describe("computeCyclomaticComplexity", () => {
	it("returns CC=1 for a trivial function with no decisions", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() { return 1; }`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("foo");
		expect(entries[0].cyclomatic).toBe(1);
		expect(entries[0].line).toBe(1);
	});

	it("counts `if` as +1", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: number) {
				if (x > 0) return 1;
				return 0;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(2);
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
		expect(entries[0].cyclomatic).toBe(3);
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
		expect(entries[0].cyclomatic).toBe(3);
	});

	it("counts `catch` as +1", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() {
				try { risky(); }
				catch (e) { handle(e); }
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(2);
	});

	it("counts ternaries", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: number) {
				return x > 0 ? 1 : 0;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(2);
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
		expect(entries[0].cyclomatic).toBe(2); // base 1 + one `??`
	});

	it("does not count `?.` optional chaining on its own", () => {
		const entries = computeCyclomaticComplexity(
			`function foo(x: { v?: number } | null) {
				return x?.v;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].cyclomatic).toBe(1);
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
		expect(entries[0].cyclomatic).toBe(4);
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
		expect(entries[0].cyclomatic).toBe(3);
	});

	it("detects arrow functions assigned to const", () => {
		const entries = computeCyclomaticComplexity(
			`const foo = (x: number) => {
				return x > 0 ? 1 : 0;
			};`,
			"src/foo.ts",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("foo");
		expect(entries[0].cyclomatic).toBe(2);
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
		expect(entries[0].name).toBe("wrapper");
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
		expect(entries[0].name).toBe("wrapper");
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
			expect(entries[0].name).toBe("foo");
			expect(entries[0].language).toBe("python");
			expect(entries[0].cyclomatic).toBe(2);
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
			expect(entries[0].cyclomatic).toBe(6);
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
			expect(entries[0].cyclomatic).toBe(4);
		});

		it("detects `async def`", () => {
			const entries = computeCyclomaticComplexity(
				`async def fetch(url):
    if url:
        return await get(url)
`,
				"src/foo.py",
			);
			expect(entries[0].name).toBe("fetch");
			expect(entries[0].cyclomatic).toBe(2);
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
			expect(entries[0].name).toBe("foo");
			expect(entries[0].language).toBe("go");
			expect(entries[0].cyclomatic).toBe(2);
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
			expect(entries[0].name).toBe("Handle");
			expect(entries[0].cyclomatic).toBe(2);
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
			expect(entries[0].cyclomatic).toBe(3);
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
			expect(entries[0].cyclomatic).toBe(4);
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
			expect(entries[0].name).toBe("foo");
			expect(entries[0].language).toBe("rust");
			expect(entries[0].cyclomatic).toBe(2);
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
			expect(entries[0].cyclomatic).toBe(4);
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
			expect(entries[0].cyclomatic).toBe(3);
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
			expect(entries[0].cyclomatic).toBe(4);
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
		expect(entries[0].cyclomatic).toBe(1);
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
		expect(entries[0].cyclomatic).toBe(1);
	});

	it("reports start and end lines (1-based, inclusive)", () => {
		const entries = computeCyclomaticComplexity(
			`function foo() {
				return 1;
			}`,
			"src/foo.ts",
		);
		expect(entries[0].line).toBe(1);
		expect(entries[0].endLine).toBe(3);
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
