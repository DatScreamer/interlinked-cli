import { describe, expect, it } from "vitest";
import { getProfileForFile } from "../language-profiles.js";
import {
	__test__,
	runInlineLanguageChecks,
} from "../quality-checks/inline-language-checks.js";

// Helper: run inline checks against a synthetic file on-disk path. The
// filesystem never gets touched — runInlineLanguageChecks only reads
// content from its arguments.
function run(filePath: string, content: string) {
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error(`no profile for ${filePath}`);
	return runInlineLanguageChecks(filePath, content, profile);
}

describe("runInlineLanguageChecks — Python", () => {
	it("flags bare except", () => {
		const src = `def f():\n    try:\n        pass\n    except:\n        pass\n`;
		const results = run("/repo/src/m.py", src);
		const bareExcepts = results.filter((r) => r.name === "python_bare_except");
		expect(bareExcepts).toHaveLength(1);
		expect(bareExcepts[0].message).toContain("m.py:4");
	});

	it("does not flag `except Exception:`", () => {
		const src = `try:\n    pass\nexcept Exception:\n    pass\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});

	it("flags mutable default arguments", () => {
		const src = `def foo(x=[]):\n    pass\ndef bar(y={}):\n    pass\n`;
		const results = run("/repo/src/m.py", src);
		const mutable = results.filter((r) => r.name === "python_mutable_default");
		expect(mutable).toHaveLength(2);
	});

	it("does not flag `=None` default", () => {
		const src = `def foo(x=None):\n    pass\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_mutable_default")).toHaveLength(0);
	});

	it("does not fire on bare except inside a string literal", () => {
		const src = `msg = "    except:\\n"\nprint(msg)\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});

	it("does not fire on commented-out bare except", () => {
		const src = `# except:\nprint(1)\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — Rust", () => {
	it("flags `.unwrap()` in non-test code", () => {
		const src = `fn f() { let x = opt.unwrap(); }\n`;
		const results = run("/repo/src/lib.rs", src);
		const unwraps = results.filter((r) => r.name === "rust_unwrap_usage");
		expect(unwraps).toHaveLength(1);
	});

	it("skips `.unwrap()` in a *_test.rs file", () => {
		const src = `fn t() { foo.unwrap(); }\n`;
		const results = run("/repo/tests/lib_test.rs", src);
		expect(results.filter((r) => r.name === "rust_unwrap_usage")).toHaveLength(0);
	});

	it("flags unsafe blocks", () => {
		const src = `unsafe {\n  *ptr = 42;\n}\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_unsafe_blocks")).toHaveLength(1);
	});

	it("exempts unsafe block documented with // SAFETY:", () => {
		const src = `// SAFETY: ptr is guaranteed non-null by caller\nunsafe {\n  *ptr = 42;\n}\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_unsafe_blocks")).toHaveLength(0);
	});

	it("flags todo!() and unimplemented!()", () => {
		const src = `fn f() { todo!(); }\nfn g() { unimplemented!(); }\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_todo_macro")).toHaveLength(2);
	});

	it("does not fire on .unwrap() inside a line comment", () => {
		const src = `// old: foo.unwrap()\nfn f() {}\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_unwrap_usage")).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — Go", () => {
	it("flags `_, _ := foo()` and `_ = foo()`", () => {
		const src = `package m\n\nfunc f() {\n  _, _ := doSomething()\n  _ = another()\n}\n`;
		const results = run("/repo/src/m.go", src);
		const ignored = results.filter((r) => r.name === "go_error_ignored");
		expect(ignored.length).toBeGreaterThanOrEqual(1);
	});

	it("does not flag normal tuple assignment with a non-underscore error", () => {
		const src = `package m\nfunc f() {\n  v, err := doSomething()\n  _ = v\n  _ = err\n}\n`;
		const results = run("/repo/src/m.go", src);
		// `_ = v` and `_ = err` do match the pattern; `v, err :=` does not.
		// We only verify the v,err assignment doesn't falsely fire.
		const firstLineHits = results.filter(
			(r) => r.name === "go_error_ignored" && r.message.includes(":3"),
		);
		expect(firstLineHits).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — Swift", () => {
	it("flags force cast (as!)", () => {
		const src = `let x = y as! Int\n`;
		const results = run("/repo/src/m.swift", src);
		expect(results.filter((r) => r.name === "swift_force_cast")).toHaveLength(1);
	});

	it("flags force try (try!)", () => {
		const src = `let x = try! foo()\n`;
		const results = run("/repo/src/m.swift", src);
		expect(results.filter((r) => r.name === "swift_force_try")).toHaveLength(1);
	});

	it("flags legacy arc4random()", () => {
		const src = `let n = arc4random()\n`;
		const results = run("/repo/src/m.swift", src);
		expect(results.filter((r) => r.name === "swift_legacy_random")).toHaveLength(1);
	});
});

describe("runInlineLanguageChecks — Java", () => {
	it("flags wildcard imports", () => {
		const src = `import java.util.*;\n\nclass X {}\n`;
		const results = run("/repo/src/X.java", src);
		expect(results.filter((r) => r.name === "java_wildcard_import")).toHaveLength(1);
	});

	it("flags System.exit()", () => {
		const src = `class X { void f() { System.exit(1); } }\n`;
		const results = run("/repo/src/X.java", src);
		expect(results.filter((r) => r.name === "java_system_exit")).toHaveLength(1);
	});

	it("does not flag explicit imports", () => {
		const src = `import java.util.List;\nimport java.util.Map;\n`;
		const results = run("/repo/src/X.java", src);
		expect(results.filter((r) => r.name === "java_wildcard_import")).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — C/C++", () => {
	it("flags strcpy, sprintf, gets", () => {
		const src = `void f(char* d, const char* s) {\n  strcpy(d, s);\n  sprintf(d, "%s", s);\n  gets(d);\n}\n`;
		const results = run("/repo/src/m.c", src);
		expect(results.filter((r) => r.name === "c_unsafe_functions")).toHaveLength(3);
	});

	it("fires c_include_guard on a header without guard", () => {
		const src = `int add(int a, int b);\n`;
		const results = run("/repo/src/math.h", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(1);
	});

	it("does not fire c_include_guard when #pragma once present", () => {
		const src = `#pragma once\nint add(int a, int b);\n`;
		const results = run("/repo/src/math.h", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(0);
	});

	it("does not fire c_include_guard when #ifndef present", () => {
		const src = `#ifndef MATH_H\n#define MATH_H\nint add(int a, int b);\n#endif\n`;
		const results = run("/repo/src/math.h", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(0);
	});

	it("does not fire c_include_guard on .c files (file_types gate)", () => {
		const src = `void f() {}\n`;
		const results = run("/repo/src/m.c", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(0);
	});
});

describe("per-language comment/string stripping", () => {
	const { stripPython, stripCStyle } = __test__;

	it("stripPython blanks interiors of single-quote, double-quote, and triple-quoted strings", () => {
		const src = `s = "unwrap()"\ndoc = """unwrap()"""\nx = 'bad()'\n`;
		const stripped = stripPython(src);
		expect(stripped).not.toContain("unwrap()");
		expect(stripped).not.toContain("bad()");
	});

	it("stripPython blanks # line comments", () => {
		const src = `# except:\nprint(1)\n`;
		const stripped = stripPython(src);
		expect(stripped).not.toContain("except:");
	});

	it("stripCStyle blanks // line and /* block */ comments", () => {
		const src = `// unwrap()\n/* unwrap() */\nlet x = 1;\n`;
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("stripCStyle blanks string contents", () => {
		const src = `let x = "unwrap()";\n`;
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("offset preservation: stripped line count equals original", () => {
		const src = `# comment\nprint(1)\n# another\n`;
		expect(stripPython(src).split("\n").length).toBe(src.split("\n").length);
	});
});

describe("InlineCheckDef file_types gating", () => {
	it("Python inline checks do not run against .rs files", () => {
		const src = `except:\n  pass\n`;
		// Deliberately pass a .rs path — the .py patterns should not match
		// because their file_types is [".py"].
		const results = run("/repo/src/m.rs", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});
});

// ===========================================
// End-to-end integration through runQualityChecks dispatch loop
// ===========================================
// Confirms that the new "inline_language_checks" branch (A4) dispatches
// through runInlineLanguageChecks and the findings appear in the normal
// quality-checks pipeline.

describe("runQualityChecks: inline_language_checks branch", () => {
	it("surfaces Python bare-except finding for an edited .py file", async () => {
		// Mock fs so the dispatch branch reads our in-memory source without
		// touching the disk.
		const { vi } = await import("vitest");
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => true),
				readFileSync: vi.fn(() => "try:\n    pass\nexcept:\n    pass\n"),
			};
		});
		vi.doMock("node:child_process", () => ({
			spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", error: null })),
			execSync: vi.fn(() => ""),
		}));
		vi.doMock("../check-engine/index.js", () => ({
			configNameToToolId: vi.fn(() => null),
			getOrCreateEngine: vi.fn(() => ({
				runChecks: () => ({
					results: [],
					elapsedMs: 0,
					toolsRun: [],
					toolsSkipped: [],
					metrics: [],
					deduplicatedCount: 0,
				}),
			})),
		}));

		const { runQualityChecks } = await import("../quality-checks.js");

		const results = runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "t",
				agent_source: "claude",
				timestamp: "2026-04-24T00:00:00.000Z",
				tool_name: "Edit",
				tool_input: { file_path: "/project/src/m.py" },
			},
			{
				inline_language_checks: {
					enabled: true,
					file_types: [".py"],
					timeout_ms: 2000,
					severity: "warning",
				},
			},
			"/project",
		);

		const bareExcepts = results.filter((r) => r.name === "python_bare_except");
		expect(bareExcepts.length).toBeGreaterThanOrEqual(1);
	});
});
