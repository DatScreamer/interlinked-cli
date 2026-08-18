// Mutation-kill companion for language-agnostic.ts (PASS-1, W6/W9 lean-mode
// survivor sweep). Every case asserts an OBSERVABLE, exact behavior that
// distinguishes the pristine implementation from a specific surviving
// mutant. `isConsoleDebugExempt`, `consoleDebugPatternFor`, `binTargets`,
// `isPackageBinTarget`, `nearestPackageDeclaresBin`, and `packageBinIncludes`
// are module-private (not exported), so their mutants are exercised through
// the exported entry points that call them: `checkConsoleDebug`,
// `isCliEntrypoint`, `isCliCommandModule`. See the `test-contract` line
// directly above each case for what it actually pins — never "kills mutant
// X" (per contract).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkConsoleDebug, isCliCommandModule, isCliEntrypoint } from "./language-agnostic.js";

describe("checkConsoleDebug — path normalization inside the function itself", () => {
	// test-contract: boundary — a hyphen-suffixed "examples-x" segment isn't a
	// clean scripts/examples directory, so it reaches checkConsoleDebug's own
	// backslash-to-slash conversion; the C/C++ examples? word-boundary check
	// only matches after that conversion runs, not when backslashes are stripped.
	it("still applies the C/C++ examples-path skip for a hyphen-suffixed, backslash-delimited segment", () => {
		expect(checkConsoleDebug('printf("hi");\n', "aaa\\examples-x\\bbb.c")).toEqual([]);
	});

	// test-contract: public-api — content.split("\n") must split into LINES;
	// scanLinesStripped reports `text` from that per-line array, so a
	// corrupted split changes the reported text/line pairing even when the
	// match COUNT happens to survive.
	it("reports the full original line text, not a lone character", () => {
		expect(checkConsoleDebug('console.log("x");\n', "/proj/src/app.ts")).toEqual([
			{ line: 1, text: 'console.log("x");' },
		]);
	});
});

describe("checkConsoleDebug — isConsoleDebugExempt (private; exercised via the exported entry point)", () => {
	// test-contract: public-api — a genuine test file (isTestFile) is exempt
	// from console-debug scanning even when it contains a real console.log
	// call, and no OTHER exemption path (cli/script/entrypoint/substring)
	// coincidentally also fires for this path.
	it("exempts a *.test.ts file even though it contains console.log", () => {
		expect(checkConsoleDebug('console.log("debug");\n', "/proj/lib/app.test.ts")).toEqual([]);
	});

	// test-contract: public-api — a tools/ path segment (isScriptOrCliPath)
	// exempts the file on its own, independent of the test/cli/entrypoint
	// checks.
	it("exempts a tools/ path segment", () => {
		expect(checkConsoleDebug('console.log("debug");\n', "/proj/tools/foo.ts")).toEqual([]);
	});

	// test-contract: boundary — the bottom-of-function substring fallback
	// reads a backslash-normalized path; a backslash-delimited /workers/
	// segment must still exempt after that normalization runs.
	it("exempts a backslash-delimited workers path segment via normalization", () => {
		expect(checkConsoleDebug('console.log("debug");\n', "aaa\\workers\\bbb.ts")).toEqual([]);
	});

	// test-contract: boundary — /\bscripts?\b/i accepts the SINGULAR
	// "script", not only the plural.
	it("exempts a path containing the singular word 'script'", () => {
		expect(checkConsoleDebug('console.log("debug");\n', "/proj/script-tool/foo.ts")).toEqual([]);
	});

	// test-contract: boundary — /\bevals?\b/i accepts the SINGULAR "eval".
	it("exempts a path containing the singular word 'eval'", () => {
		expect(checkConsoleDebug('console.log("debug");\n', "/proj/eval-runner/foo.ts")).toEqual([]);
	});

	// test-contract: boundary — /\/workers?\//i accepts the SINGULAR
	// "/worker/" segment, not only "/workers/".
	it("exempts a path containing the singular /worker/ segment", () => {
		expect(checkConsoleDebug('console.log("debug");\n', "/proj/worker/foo.ts")).toEqual([]);
	});
});

describe("checkConsoleDebug — consoleDebugPatternFor JS/TS extension set", () => {
	// test-contract: public-api — every listed JS/TS extension resolves to
	// the console.log/debugger pattern rather than falling through to null.
	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])("flags console.log in a %s file", (ext) => {
		expect(checkConsoleDebug('console.log("x");\n', `/proj/src/app${ext}`)).toEqual([
			{ line: 1, text: 'console.log("x");' },
		]);
	});
});

describe("checkConsoleDebug — JS/TS console/debugger regex, exact boundary behavior", () => {
	// test-contract: boundary — "console.logger(" is not a console.log call;
	// only whitespace, never other identifier characters, may separate
	// "console.log" from its "(".
	it("does not flag console.logger( as a console.log call", () => {
		expect(checkConsoleDebug('console.logger("hi");\n', "/proj/src/app.ts")).toEqual([]);
	});

	// test-contract: boundary — the debugger; alternative is anchored to the
	// START of the line; a "debugger;" occurring mid-line after other code
	// must not be flagged.
	it("does not flag a mid-line debugger; that is not at the start of the line", () => {
		expect(checkConsoleDebug("if (x) debugger;\n", "/proj/src/app.ts")).toEqual([]);
	});

	// test-contract: boundary — an un-indented "debugger;" (zero leading
	// whitespace, zero space before the semicolon) is a legal match: both
	// the leading and trailing whitespace around "debugger" are optional.
	it("flags an unindented debugger; with no space before the semicolon", () => {
		expect(checkConsoleDebug("debugger;\n", "/proj/src/app.ts")).toEqual([
			{ line: 1, text: "debugger;" },
		]);
	});

	// test-contract: boundary — indentation before "debugger" may be actual
	// whitespace characters, not merely any non-whitespace filler.
	it("flags an indented debugger; (whitespace-only indentation)", () => {
		expect(checkConsoleDebug("  debugger;\n", "/proj/src/app.ts")).toEqual([
			{ line: 1, text: "debugger;" },
		]);
	});

	// test-contract: boundary — a space between "debugger" and its semicolon
	// is legal (the trailing whitespace is optional-star, not forbidden).
	it("flags debugger with a space before the semicolon", () => {
		expect(checkConsoleDebug("debugger ;\n", "/proj/src/app.ts")).toEqual([
			{ line: 1, text: "debugger ;" },
		]);
	});
});

describe("checkConsoleDebug — Python breakpoint/pdb.set_trace, exact boundary behavior", () => {
	// test-contract: boundary — "breakpointer(" is not a breakpoint() call;
	// only whitespace may separate "breakpoint" from its "(".
	it("does not flag breakpointer( as a breakpoint() call", () => {
		expect(checkConsoleDebug("breakpointer()\n", "/proj/lib/app_logic.py")).toEqual([]);
	});

	// test-contract: boundary — pdb.set_trace() with zero space before "(" is
	// a legal match; the whitespace there is optional, not mandatory.
	it("flags pdb.set_trace() with no space before the parenthesis", () => {
		expect(checkConsoleDebug("pdb.set_trace()\n", "/proj/lib/app_logic.py")).toEqual([
			{ line: 1, text: "pdb.set_trace()" },
		]);
	});

	// test-contract: boundary — "pdb.set_tracer(" is not a pdb.set_trace()
	// call.
	it("does not flag pdb.set_tracer( as a pdb.set_trace() call", () => {
		expect(checkConsoleDebug("pdb.set_tracer()\n", "/proj/lib/app_logic.py")).toEqual([]);
	});
});

describe("checkConsoleDebug — Rust dbg!", () => {
	// test-contract: public-api — a .rs file resolves to the dbg! pattern
	// (does not fall through to null via an ext check that never matches
	// ".rs").
	it("flags dbg! in an ordinary (non-CLI, non-test) .rs file", () => {
		expect(checkConsoleDebug("dbg!(x);\n", "/proj/lib/util.rs")).toEqual([
			{ line: 1, text: "dbg!(x);" },
		]);
	});
});

describe("checkConsoleDebug — Go fmt.Println count threshold and returned pattern", () => {
	// test-contract: boundary — the 3+-occurrence COUNT uses the same strict
	// whitespace-only spacing as the pattern it counts; a non-"fmt.Println("
	// near-miss (extra identifier characters before the parenthesis) must
	// not contribute to the count.
	it("does not cross the 3-occurrence threshold when one of three lines is a near-miss", () => {
		const content = 'fmt.Println("a")\nfmt.Println("b")\nfmt.PrintlnX("c")\n';
		expect(checkConsoleDebug(content, "/proj/lib/handler.go")).toEqual([]);
	});

	// test-contract: boundary — once the threshold is crossed by genuine
	// occurrences, the RETURNED scanning pattern still rejects a near-miss
	// line, flagging only the actual fmt.Println( calls.
	it("flags only the genuine fmt.Println( lines once the threshold is crossed", () => {
		const content = 'fmt.Println("a")\nfmt.Println("b")\nfmt.Println("c")\nfmt.PrintlnX("d")\n';
		expect(checkConsoleDebug(content, "/proj/lib/handler.go")).toEqual([
			{ line: 1, text: 'fmt.Println("a")' },
			{ line: 2, text: 'fmt.Println("b")' },
			{ line: 3, text: 'fmt.Println("c")' },
		]);
	});
});

describe("checkConsoleDebug — consoleDebugPatternFor C/C++ extension set", () => {
	// test-contract: public-api — every listed C/C++ extension resolves to
	// the printf pattern rather than falling through to null.
	it.each([".cc", ".cpp", ".cxx", ".h", ".hpp"])("flags printf in a %s file", (ext) => {
		expect(checkConsoleDebug('printf("hi");\n', `/proj/src/app${ext}`)).toEqual([
			{ line: 1, text: 'printf("hi");' },
		]);
	});
});

describe("checkConsoleDebug — C/C++ examples/samples/demos path skip", () => {
	// test-contract: boundary — the examples-path skip actually runs (is not
	// short-circuited to never-skip); a hyphen-suffixed "examples-data"
	// directory (not a clean isScriptOrCliPath segment) exercises it
	// directly.
	it("skips a non-clean examples-data/ directory segment", () => {
		expect(checkConsoleDebug('printf("hi");\n', "/proj/examples-data/app.c")).toEqual([]);
	});

	// test-contract: boundary — the "example" alternative accepts the
	// SINGULAR form, not only "examples".
	it("skips a directory segment using the singular 'example'", () => {
		expect(checkConsoleDebug('printf("hi");\n', "/proj/example-data/app.c")).toEqual([]);
	});

	// test-contract: boundary — the "sample" alternative accepts the
	// SINGULAR form.
	it("skips a directory segment using the singular 'sample'", () => {
		expect(checkConsoleDebug('printf("hi");\n', "/proj/sample-data/app.c")).toEqual([]);
	});

	// test-contract: boundary — the "demo" alternative accepts the SINGULAR
	// form.
	it("skips a directory segment using the singular 'demo'", () => {
		expect(checkConsoleDebug('printf("hi");\n', "/proj/demo-data/app.c")).toEqual([]);
	});

	// test-contract: boundary — "printfln(" is not a printf( call; only
	// whitespace may separate "printf" from its "(".
	it("does not flag printfln( as a printf( call", () => {
		expect(checkConsoleDebug('printfln("hi");\n', "/proj/src/app.c")).toEqual([]);
	});
});

describe('checkConsoleDebug — Swift dispatch and the ext === ".swift" guard', () => {
	// test-contract: boundary — "NSLogger(" is not an NSLog( call.
	it("does not flag NSLogger( as an NSLog( call", () => {
		expect(checkConsoleDebug('NSLogger("hi")\n', "/proj/src/App.swift")).toEqual([]);
	});

	// test-contract: public-api — an unrecognized extension (.rb) falls
	// through to null and is never dispatched to the Swift pattern.
	it("does not dispatch an unrecognized extension to the Swift pattern", () => {
		expect(checkConsoleDebug('NSLog("hi")\n', "/proj/src/app.rb")).toEqual([]);
	});
});

describe("isCliEntrypoint — scripts|bin path-segment anchor and normalization", () => {
	// test-contract: public-api — a RELATIVE path starting directly with
	// "scripts/" (no leading slash) matches via the start-of-string
	// alternative, not only via a preceding "/".
	it("matches a relative path starting directly with scripts/", () => {
		expect(isCliEntrypoint("scripts/deploy.ts", "run();")).toBe(true);
	});

	// test-contract: boundary — a backslash-delimited "bin" segment is still
	// recognized after this function's own backslash-to-slash normalization.
	it("matches a backslash-delimited bin/ segment via normalization", () => {
		expect(isCliEntrypoint("aaa\\bin\\tool.js", "run();")).toBe(true);
	});
});

describe("isCliCommandModule — backslash normalization before the commands/ check", () => {
	// test-contract: boundary — a backslash-delimited "commands" segment is
	// still recognized after this function's own normalization, and the
	// backslash-joined relative path still resolves correctly against cwd
	// for the bin lookup.
	it("resolves a backslash-delimited commands/ segment via normalization", () => {
		const dir = mkdtempSync(join(tmpdir(), "il-cmd-norm-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
			expect(isCliCommandModule("commands\\deploy.ts", dir)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isCliEntrypoint / isCliCommandModule — BIN_LOOKUP_MAX_DEPTH boundary", () => {
	// test-contract: boundary — the ancestor walk checks exactly
	// BIN_LOOKUP_MAX_DEPTH (40) directories; a package.json one level beyond
	// that boundary (the 41st ancestor) must not be found.
	it("does not find a bin-declaring package.json 41 ancestors up (isPackageBinTarget)", () => {
		const root = mkdtempSync(join(tmpdir(), "il-bin-depth-"));
		try {
			const segs = Array.from({ length: 40 }, (_, i) => String(i));
			const deepDir = join(root, ...segs);
			mkdirSync(deepDir, { recursive: true });
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: "t", bin: `${segs.join("/")}/run.js` }),
			);
			writeFileSync(join(deepDir, "run.js"), "run();\n");
			expect(isCliEntrypoint(join(deepDir, "run.js"), "run();\n")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// test-contract: boundary — same depth boundary, for the
	// nearestPackageDeclaresBin walk that isCliCommandModule relies on.
	it("does not find a bin-declaring package.json 40 ancestors up (nearestPackageDeclaresBin)", () => {
		const root = mkdtempSync(join(tmpdir(), "il-cmd-depth-"));
		try {
			const segs = ["commands", ...Array.from({ length: 39 }, (_, i) => String(i))];
			const deepDir = join(root, ...segs);
			mkdirSync(deepDir, { recursive: true });
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "t", bin: "./x.js" }));
			expect(isCliCommandModule(join(deepDir, "deploy.ts"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("isCliEntrypoint — binTargets filters non-string bin-map values", () => {
	// test-contract: boundary — an object-form bin map may mix a non-string
	// value with a valid string target; the non-string value must be filtered
	// out before the resolve/compare step, or it throws inside the comparator
	// and gets silently swallowed as "not found" by the surrounding catch.
	it("still finds the matching bin target when a non-string value precedes it in the map", () => {
		const dir = mkdtempSync(join(tmpdir(), "il-bin-filter-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "t", bin: { first: 42, tool: "./run.js" } }),
			);
			expect(isCliEntrypoint(join(dir, "run.js"), "run();")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
