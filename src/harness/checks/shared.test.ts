// Smoke tests for shared helpers used by all check modules.
// Thorough coverage lives in generic-checks-extended.test.ts (tests run
// against the re-exported symbols, which come from this module).

import { afterEach, describe, expect, test } from "vitest";
import {
	__setPackageRootForTesting,
	findEnclosingScope,
	getExtension,
	isCliFile,
	isGeneratedFile,
	isPatternDataFile,
	isScriptOrCliPath,
	isStrictTestFile,
	isTestSourcePath,
	isTestFile,
	JS_TS_ALL_EXTS,
	JS_TS_EXTS,
	isTypeOnlyModule,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";

// Boundary receipts for shared predicates: every case below pins a public
// contract that callers rely on, including both the positive and adjacent
// negative shape. This keeps path/data exemptions observable without copying
// private implementation details into the assertions.

describe("findEnclosingScope", () => {
	test("names the enclosing function declaration", () => {
		const src = [
			"// comment",
			"function safeReadCopilotConfig(path: string): CopilotConfig | null {",
			"    if (!existsSync(path)) return null;",
			"    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));", // line 4
			"    return parsed;",
			"}",
		].join("\n");
		expect(findEnclosingScope(src, 4)).toBe("safeReadCopilotConfig");
	});

	test("names the enclosing arrow function bound to a const", () => {
		const src = [
			"export const buildClaudeContext = (input) => {",
			"    return { input, env: envelopeFieldsClaude(input) };", // line 2
			"};",
		].join("\n");
		expect(findEnclosingScope(src, 2)).toBe("buildClaudeContext");
	});

	test("names the enclosing class", () => {
		const src = [
			"class HarnessServer {",
			"    constructor() {",
			"        this.port = 0;", // line 3
			"    }",
			"}",
		].join("\n");
		// constructor is closer than the class, but methods take precedence.
		// "constructor" is in the keyword blacklist so it falls back.
		const scope = findEnclosingScope(src, 3);
		expect(scope === "HarnessServer" || scope === "constructor").toBe(true);
	});

	test("names the enclosing method inside a class", () => {
		const src = [
			"class HarnessServer {",
			"    handleConnection(socket) {",
			"        socket.write('hello');", // line 3
			"    }",
			"}",
		].join("\n");
		expect(findEnclosingScope(src, 3)).toBe("handleConnection");
	});

	test("returns null at the top level outside any function/class", () => {
		const src = ["const x = 1;", "const y = x + 1;"].join("\n");
		expect(findEnclosingScope(src, 1)).toBeNull();
	});

	test("does not match function-like content inside string literals", () => {
		const src = [
			"const real = 'class FakeClass {';",
			"function actualScope() {",
			"    return real;", // line 3
			"}",
		].join("\n");
		expect(findEnclosingScope(src, 3)).toBe("actualScope");
	});
});

describe("shared helpers", () => {
	test("isTestFile detects common conventions", () => {
		expect(isTestFile("src/foo.test.ts")).toBe(true);
		expect(isTestFile("src/foo.spec.ts")).toBe(true);
		expect(isTestFile("pkg/tests/foo.py")).toBe(true);
		expect(isTestFile("app/src/test/FooTest.java")).toBe(true);
		expect(isTestFile("src/FooTest.swift")).toBe(true);
		expect(isTestFile("src/foo.go")).toBe(false);
		expect(isTestFile("src/foo.ts")).toBe(false);
	});

	test("JS/TS extension exports stay in lockstep and include every supported suffix", () => {
		const expected = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];
		expect(JS_TS_ALL_EXTS).toEqual(expected);
		expect([...JS_TS_EXTS].sort()).toEqual([...expected].sort());
		expect(JS_TS_ALL_EXTS.every((ext) => JS_TS_EXTS.has(ext))).toBe(true);
	});

	test("isStrictTestFile recognizes each filename convention without widening nearby source files", () => {
		const testPaths = [
			"test_parser.py",
			"parser_test.py",
			"parser_test.go",
			"widget.test.ts",
			"widget.spec.tsx",
			"WidgetTest.java",
			"WidgetTests.java",
			"WidgetTest.swift",
			"WidgetTests.swift",
			"test_widget.swift",
		];
		for (const path of testPaths) expect(isStrictTestFile(path)).toBe(true);

		const sourcePaths = [
			"mytests/helper.ts",
			"test_parser.js",
			"parser_test.rb",
			"parser.go",
			"widget.test.ts.bak",
			"widget.spec.css",
			"WidgetTester.java",
			"WidgetTester.swift",
			"contest_widget.swift",
		];
		for (const path of sourcePaths) expect(isStrictTestFile(path)).toBe(false);
		expect(isStrictTestFile("src\\__tests__\\fixture.ts")).toBe(true);
	});

	test("isTestSourcePath uses anchored directories and the broad test/spec suffix contract", () => {
		const testPaths = [
			"tests/helper.ts",
			"test/fixture.ts",
			"__tests__/fixture.rb",
			"src/fixture.test.rb",
			"src/test_fixture.py",
			"src/fixture_test.go",
			"src/FixtureTests.swift",
		];
		for (const path of testPaths) expect(isTestSourcePath(path)).toBe(true);

		const sourcePaths = [
			"mytests/helper.ts",
			"contest/fixture.ts",
			"src/testimony.ts",
			"src/fixture.testing.ts",
		];
		for (const path of sourcePaths) expect(isTestSourcePath(path)).toBe(false);
	});

	test("isVendoredOrFixturePath requires directory boundaries and recognizes generated asset suffixes", () => {
		const exemptPaths = [
			"node_modules/pkg/index.js",
			"vendor/lib.ts",
			"third_party/lib.cjs",
			"src/__fixtures__/payload.ts",
			"src/__mocks__/client.ts",
			"dist/app.js",
			"build/app.mjs",
			"coverage/report.js",
			"src/app.min.js",
			"src/app.bundle.css",
		];
		for (const path of exemptPaths) expect(isVendoredOrFixturePath(path)).toBe(true);
		expect(isVendoredOrFixturePath("src/myvendor/app.ts")).toBe(false);
		expect(isVendoredOrFixturePath("src/app.min.ts")).toBe(false);
		expect(isVendoredOrFixturePath("src/app.bundle.ts")).toBe(false);
	});

		test("pattern-data exemptions are scoped to the package root and fail closed", () => {
		__setPackageRootForTesting("/workspace/interlinked-cli");
		expect(
			isPatternDataFile("/workspace/interlinked-cli/src/harness/rules/catalog.ts"),
		).toBe(true);
		expect(
			isPatternDataFile("/workspace/interlinked-cli/src/harness/check-registry/catalog.ts"),
		).toBe(true);
		expect(
			isPatternDataFile("/workspace/interlinked-cli/src/harness/check-metadata.ts"),
		).toBe(true);
		expect(
			isPatternDataFile("/workspace/interlinked-cli/src/harness/checks/catalog.ts"),
		).toBe(true);
		expect(
			isPatternDataFile("/workspace/interlinked-cli/src/harness/evaluator/write-content-guards-extra.ts"),
		).toBe(true);
		for (const path of [
			"/workspace/interlinked-cli/src/harness/signatures-patterns.ts",
			"/workspace/interlinked-cli/src/harness/signatures.ts",
			"/workspace/interlinked-cli/src/harness/quality-checks/secret-detection.ts",
			"/workspace/interlinked-cli/src/harness/verification-stop-checks.ts",
			"/workspace/interlinked-cli/src/hook-template-chunks/guards-inline.ts",
		]) {
			expect(isPatternDataFile(path)).toBe(true);
		}
		expect(
			isPatternDataFile("\\workspace\\interlinked-cli\\src\\harness\\checks\\catalog.ts"),
		).toBe(true);
		expect(isPatternDataFile("/workspace/user-project/src/harness/rules/catalog.ts")).toBe(false);

		__setPackageRootForTesting(null);
		expect(isPatternDataFile("/workspace/interlinked-cli/src/harness/checks/catalog.ts")).toBe(false);
		expect(isTestFile("/workspace/interlinked-cli/src/harness/checks/catalog.test.ts")).toBe(true);
	});

	test("relative pattern-data paths are resolved against the active package root", () => {
		__setPackageRootForTesting(process.cwd());
		expect(isPatternDataFile("src/harness/checks/shared.ts")).toBe(true);
		expect(isPatternDataFile("src/lib/ordinary-source.ts")).toBe(false);
	});

	test("package-root discovery finds this checkout when the override is cleared", () => {
		__setPackageRootForTesting(undefined);
		expect(isPatternDataFile("src/harness/checks/shared.ts")).toBe(true);
		expect(isPatternDataFile("src/lib/ordinary-source.ts")).toBe(false);
	});

	afterEach(() => {
		__setPackageRootForTesting(undefined);
	});

	// Harness-internals exemption (`src/harness/rules/*`, `*/check-registry/*`,
	// `*/check-metadata*`, `*/ubs-language-specific.*`) is now scoped to
	// interlinked-cli's resolved package root — the relative-path form this
	// test used to assert was unsafe (a user repo with `src/harness/rules/`
	// was inheriting the exemption). Coverage moved to
	// `__tests__/shared-test-file-scoping.test.ts`, which exercises both the
	// scoped-positive and scoped-negative branches with absolute paths.

	test("isCliFile detects CLI entry points", () => {
		expect(isCliFile("src/commands/foo.ts")).toBe(true);
		expect(isCliFile("src/cmd/foo.go")).toBe(true);
		expect(isCliFile("repo/bin/tool")).toBe(true);
		expect(isCliFile("cli/src/index.ts")).toBe(true);
		expect(isCliFile("lib/util.ts")).toBe(false);
	});

	test("isCliFile recognizes rooted CLI directories but not lookalike segments", () => {
		for (const path of [
			"/cli/src/index.ts",
			"/bin/index.js",
			"/cmd/index.py",
			"/commands/run.ts",
		]) {
			expect(isCliFile(path)).toBe(true);
		}
		expect(isCliFile("src/cli-helper.ts")).toBe(false);
		expect(isCliFile("src/index.ts.bak")).toBe(false);
		expect(isCliFile("lib/tools/index.ts")).toBe(false);
		expect(isCliFile("lib/index.ts")).toBe(false);
		expect(isCliFile("/cli/lib/index.ts")).toBe(true);
		expect(isCliFile("src\\commands\\run.ts")).toBe(true);
	});

	test("getExtension returns lowercase extension with dot", () => {
		expect(getExtension("foo.TS")).toBe(".ts");
		expect(getExtension("foo.tsx")).toBe(".tsx");
		expect(getExtension("Makefile")).toBe("");
	});

	test("stripComments preserves line count", () => {
		const input = "a // HELLO_COMMENT\nb /* BLOCKMARKER */ c\nd";
		const out = stripComments(input);
		expect(out.split("\n").length).toBe(3);
		expect(out).not.toContain("HELLO_COMMENT");
		expect(out).not.toContain("BLOCKMARKER");
	});

	test("stripStrings preserves line count and blanks string content", () => {
		const input = 'const x = "SECRETTOKEN";\nconst y = `TPLMARKER`;';
		const out = stripStrings(input);
		expect(out.split("\n").length).toBe(2);
		expect(out).not.toContain("SECRETTOKEN");
	});

	test("stripCommentsAndStrings composes", () => {
		const input = 'const x = "STRMARKER"; // LINECOMMENT\nconst y = /* BLKCOMMENT */ "STR2";';
		const out = stripCommentsAndStrings(input);
		expect(out).not.toContain("STRMARKER");
		expect(out).not.toContain("LINECOMMENT");
		expect(out).not.toContain("BLKCOMMENT");
		expect(out).not.toContain("STR2");
	});

	test("stripComments keeps a // inside a URL string literal", () => {
		// Regression: indexOf("//") found the // in https:// and blanked the
		// rest of the line, destroying the string's closing quote.
		const src = 'const u = "https://example.com/path";';
		expect(stripComments(src)).toBe(src);
	});

	test("stripComments keeps a # inside a string literal", () => {
		const src = 'const tag = "#hashtag";';
		expect(stripComments(src)).toBe(src);
	});

	test("stripComments still strips a real comment after a URL string literal", () => {
		const input = 'const u = "https://example.com"; // SECRETNOTE';
		const out = stripComments(input);
		expect(out.startsWith('const u = "https://example.com";')).toBe(true);
		expect(out).not.toContain("SECRETNOTE");
		expect(out.length).toBe(input.length);
	});

	test("stripCommentsAndStrings keeps code after a URL string literal visible", () => {
		const out = stripCommentsAndStrings('fetch("https://api.example.com"); cleanup();');
		expect(out).toContain("cleanup()");
		expect(out).toContain("fetch(");
		expect(out).not.toContain("api.example.com");
	});

	test("isGeneratedFile scans the first 20 lines rather than only the first characters", () => {
		const code = ["header", "// auto-generated", "export const value = 1;"].join("\n");
		expect(isGeneratedFile(code)).toBe(true);
	});

	test("scanLinesStripped reports original text but tests stripped", () => {
		const original = ["const x = 1; // hit", "const y = 2;"];
		const stripped = ["const x = 1;      ", "const y = 2;"];
		const found = scanLinesStripped(original, stripped, /x = 1/, 10);
		expect(found).toHaveLength(1);
		expect(found[0]).toEqual({ line: 1, text: "const x = 1; // hit" });
	});
});

// FP-refinement helpers from the 139-repo audit (2026-05). Each helper
// gates a specific FP shape — generator output, script/CLI output, and
// Bandit-acknowledged suppressions — so checks downstream can short-
// circuit before producing noise. Negative cases exercise the FP
// shapes that must be suppressed; positive cases exercise the
// hand-written real code that must still flow through.

describe("isGeneratedFile", () => {
	// Negative cases — these MUST be detected as generated.

	test("OpenAPI Generator header (Supermodel sdk/DefaultApi.ts shape)", () => {
		const code = [
			"/* tslint:disable */",
			"/* eslint-disable */",
			"/**",
			" * NOTE: This class is auto generated by OpenAPI Generator",
			" * https://openapi-generator.tech",
			" * Do not edit the class manually.",
			" */",
			"",
			"export class DefaultApi {}",
		].join("\n");
		expect(isGeneratedFile(code)).toBe(true);
	});

	test("Protobuf-generated header", () => {
		const code = [
			"// Code generated by protoc-gen-go. DO NOT EDIT.",
			"// versions:",
			"//   protoc-gen-go v1.31.0",
			"package foo",
		].join("\n");
		expect(isGeneratedFile(code)).toBe(true);
	});

	test("@generated tag (TypeScript / GraphQL codegen convention)", () => {
		const code = [
			"// @generated SignedSource<<...>>",
			"// Do not modify by hand.",
			"export type Foo = { id: string };",
		].join("\n");
		expect(isGeneratedFile(code)).toBe(true);
	});

	test("swagger-codegen header", () => {
		const code = [
			"/**",
			" * Swagger Petstore",
			" * This file was generated by the swagger-codegen project",
			" */",
			"export class Pet {}",
		].join("\n");
		expect(isGeneratedFile(code)).toBe(true);
	});

	// Positive cases — these MUST NOT be detected as generated (real code).

	test("hand-written app code with `as any`", () => {
		const code = [
			"// Application logic for the user dashboard.",
			"export function fetchUser(id: string): Promise<unknown> {",
			"  return api.get(`/users/${id}`) as any;",
			"}",
		].join("\n");
		expect(isGeneratedFile(code)).toBe(false);
	});

	test("file mentioning 'generator' in middle of file (not header)", () => {
		// `generator` appears past the 20-line head — must NOT match.
		const lines = Array.from({ length: 25 }, (_, i) => `const x${i} = ${i};`);
		lines[24] = "// This is the random generator helper.";
		expect(isGeneratedFile(lines.join("\n"))).toBe(false);
	});

	test("file with `// auto` on a line but not a generator marker", () => {
		const code = [
			"// auto-saving the cursor position before nav.",
			"export function saveCursor() {}",
		].join("\n");
		// `auto` alone doesn't match — needs `auto generated` / `auto-generated`.
		expect(isGeneratedFile(code)).toBe(false);
	});
});

describe("isScriptOrCliPath", () => {
	// Negative cases — these MUST be classified as script/CLI paths.

	test("scripts/ directory (Python sync_version.py shape)", () => {
		expect(isScriptOrCliPath("mcpbr/scripts/sync_version.py")).toBe(true);
	});

	test("script/ singular form", () => {
		expect(isScriptOrCliPath("repo/script/build.sh")).toBe(true);
	});

	test("bin/ entry-point directory", () => {
		expect(isScriptOrCliPath("repo/bin/migrate.ts")).toBe(true);
	});

	test("cli/ directory (Supermodel wizard.go shape)", () => {
		expect(isScriptOrCliPath("cli/internal/setup/wizard.go")).toBe(true);
	});

	test("tools/ directory (build-tools, code-mod scripts)", () => {
		expect(isScriptOrCliPath("repo/tools/codegen.ts")).toBe(true);
	});

	test("tutorial/ and tutorials/ directories", () => {
		expect(isScriptOrCliPath("repo/tutorial/intro.py")).toBe(true);
		expect(isScriptOrCliPath("docs/tutorials/getting-started.md")).toBe(true);
	});

	test("root-level singular and plural script-like directories are recognized", () => {
		for (const path of [
			"scripts/build.ts",
			"script/build.ts",
			"bin/tool.ts",
			"cli/tool.ts",
			"tools/tool.ts",
			"tool/tool.ts",
			"tutorial/intro.md",
			"tutorials/intro.md",
			"example/demo.ts",
			"examples/demo.ts",
			"demo/run.ts",
			"demos/run.ts",
			"sample/data.ts",
			"samples/data.ts",
		]) {
			expect(isScriptOrCliPath(path)).toBe(true);
		}
	});

	// Positive cases — real source paths must NOT be matched.

	test("src/ application code", () => {
		expect(isScriptOrCliPath("src/lib/foo.ts")).toBe(false);
	});

	test("app/ directory (Next.js)", () => {
		expect(isScriptOrCliPath("app/handlers/users.ts")).toBe(false);
	});

	test("lib/ directory (library source)", () => {
		expect(isScriptOrCliPath("lib/auth.ts")).toBe(false);
	});

	test("a path containing 'binary' but not as a path segment", () => {
		// `binary/` is not `bin/` — the regex anchors `bin` at a path
		// boundary, so deeper words containing the substring stay
		// unaffected.
		expect(isScriptOrCliPath("src/binary-encoding.ts")).toBe(false);
	});

	test("a directory named `myscripts` does NOT match `scripts`", () => {
		// Anchored regex contract — a non-slash prefix before `scripts`
		// breaks the segment match.
		expect(isScriptOrCliPath("repo/myscripts/foo.py")).toBe(false);
	});
});

describe("lineHasNoqaSuppression", () => {
	// Negative cases — these MUST be treated as suppressed.

	test("`# noqa: S307` suppresses ubs_eval_input_tainted", () => {
		const line = `value = float(eval(metric_def.compute_fn, {"__builtins__": {}}, ns))  # noqa: S307`;
		expect(lineHasNoqaSuppression(line, "ubs_eval_input_tainted")).toBe(true);
	});

	test("`# noqa: S602 -- reason text` suppresses ubs_subprocess_shell_true", () => {
		const line = `result = subprocess.run(  # noqa: S602 -- tutorial validation runs user-defined shell commands by design`;
		expect(lineHasNoqaSuppression(line, "ubs_subprocess_shell_true")).toBe(true);
	});

	test("`# noqa: S301` suppresses ubs_pickle_untrusted_load", () => {
		const line = `data = pickle.loads(buf)  # noqa: S301`;
		expect(lineHasNoqaSuppression(line, "ubs_pickle_untrusted_load")).toBe(true);
	});

	test("`# noqa: S314` suppresses ubs_xml_external_entity", () => {
		const line = `tree = ET.parse(path)  # noqa: S314`;
		expect(lineHasNoqaSuppression(line, "ubs_xml_external_entity")).toBe(true);
	});

	test("comma-separated codes — `# noqa: S602, S605`", () => {
		const line = `subprocess.run(cmd, shell=True)  # noqa: S602, S605`;
		expect(lineHasNoqaSuppression(line, "ubs_subprocess_shell_true")).toBe(true);
		expect(lineHasNoqaSuppression(line, "child_process_exec_user_input")).toBe(true);
	});

	test("comma-separated codes also allow no whitespace after the comma", () => {
		const line = "subprocess.run(cmd, shell=True)  # noqa: S602,S605";
		expect(lineHasNoqaSuppression(line, "child_process_exec_user_input")).toBe(true);
	});

	test("every mapped Bandit code suppresses only its documented check", () => {
		const cases: Array<[string, string]> = [
			["S102", "ubs_eval_input_tainted"],
			["S301", "ubs_pickle_untrusted_load"],
			["S307", "ubs_eval_input_tainted"],
			["S310", "ubs_unchecked_redirect"],
			["S314", "ubs_xml_external_entity"],
			["S320", "ubs_xml_external_entity"],
			["S324", "weak_hash"],
			["S501", "tls_verify_disabled"],
			["S602", "ubs_subprocess_shell_true"],
			["S603", "ubs_subprocess_shell_true"],
			["S605", "child_process_exec_user_input"],
			["S608", "ubs_sql_string_concat"],
		];
		for (const [code, checkId] of cases) {
			expect(lineHasNoqaSuppression(`# noqa: ${code}`, checkId)).toBe(true);
		}
		expect(lineHasNoqaSuppression("# noqa: S311", "ubs_eval_input_tainted")).toBe(false);
	});

	test("bare `# noqa` suppresses any check (flake8 convention)", () => {
		const line = `result = subprocess.run(cmd, shell=True)  # noqa`;
		expect(lineHasNoqaSuppression(line, "ubs_subprocess_shell_true")).toBe(true);
		expect(lineHasNoqaSuppression(line, "ubs_eval_input_tainted")).toBe(true);
	});

	// Positive cases — these MUST NOT suppress (real positives must fire).

	test("no noqa comment at all — does NOT suppress", () => {
		const line = `value = eval(user_input)`;
		expect(lineHasNoqaSuppression(line, "ubs_eval_input_tainted")).toBe(false);
	});

	test("noqa with a different code does NOT suppress", () => {
		// E501 is line-length — has no entry in the bandit map, so it
		// must NOT suppress an eval check.
		const line = `value = eval(user_input)  # noqa: E501`;
		expect(lineHasNoqaSuppression(line, "ubs_eval_input_tainted")).toBe(false);
	});

	test("noqa with unrelated bandit code does NOT suppress", () => {
		// S301 (pickle) must NOT suppress a SQL-concat finding.
		const line = `query = "SELECT * FROM " + table  # noqa: S301`;
		expect(lineHasNoqaSuppression(line, "ubs_sql_string_concat")).toBe(false);
	});

	test("`# nope: S307` (typo, not noqa) does NOT suppress", () => {
		const line = `value = eval(x)  # nope: S307`;
		expect(lineHasNoqaSuppression(line, "ubs_eval_input_tainted")).toBe(false);
	});
});

// `isTypeOnlyModule` gates the `no_test_file` and TDD-cycle checks: a
// TypeScript module that declares only types has nothing to unit-test, so
// demanding a `.test.<ext>` sibling is pure noise. Negative cases are the
// type-only modules that MUST be detected; positive cases are modules with
// runtime code that MUST still flow through to the check.

describe("isTypeOnlyModule", () => {
	// Negative cases — pure type-definition modules MUST be detected.

	test("a module of only interface declarations", () => {
		const code = [
			"export interface Config {",
			"  enabled: boolean;",
			"}",
			"export interface Server { url: string; }",
		].join("\n");
		expect(isTypeOnlyModule("src/harness/types/config.ts", code)).toBe(true);
	});

	test("a module of only type aliases", () => {
		const code = [
			'export type SyncMode = "realtime" | "local";',
			"type Internal = { id: string };",
		].join("\n");
		expect(isTypeOnlyModule("types.ts", code)).toBe(true);
	});

	test("a type re-export barrel", () => {
		const code = [
			'export type { Config } from "./config.js";',
			'import type { Base } from "./base.js";',
			"export type Wrapped = Base;",
		].join("\n");
		expect(isTypeOnlyModule("index.ts", code)).toBe(true);
	});

	test("runtime keywords inside comments and strings do not disqualify", () => {
		// The exact FP shape: a type module whose doc comment and string
		// members spell out `const` / `function` / `class`.
		const code = [
			"/** Holds a frozen const built by a factory function. */",
			'export type Keyword = "const" | "function" | "class" | "enum";',
			"export interface Spec { enabled: boolean; }",
		].join("\n");
		expect(isTypeOnlyModule("keywords.ts", code)).toBe(true);
	});

	// Positive cases — a module with ANY runtime code MUST NOT be type-only.

	test("a module with an exported const is not type-only", () => {
		const code = [
			'export type Mode = "on" | "off";',
			'export const DEFAULT: Mode = "on";',
		].join("\n");
		expect(isTypeOnlyModule("config.ts", code)).toBe(false);
	});

	test("a module with a function is not type-only", () => {
		const code = [
			"export interface Result { ok: boolean; }",
			"export function check(): Result { return { ok: true }; }",
		].join("\n");
		expect(isTypeOnlyModule("check.ts", code)).toBe(false);
	});

	test("a module with a class is not type-only", () => {
		const code = [
			'export type State = "idle" | "busy";',
			'export class Machine { state: State = "idle"; }',
		].join("\n");
		expect(isTypeOnlyModule("machine.ts", code)).toBe(false);
	});

	test("a module with an enum is not type-only (enums emit runtime code)", () => {
		const code = ["export type Alias = number;", "export enum Color { Red, Green }"].join("\n");
		expect(isTypeOnlyModule("color.ts", code)).toBe(false);
	});

	test("a module with a default export is not type-only", () => {
		const code = [
			"export type Settings = { debug: boolean };",
			"export default { debug: false };",
		].join("\n");
		expect(isTypeOnlyModule("settings.ts", code)).toBe(false);
	});

	test("a module with a side-effect import is not type-only", () => {
		const code = [
			"export interface Options { enabled: boolean; }",
			'import "./polyfill.js";',
		].join("\n");
		expect(isTypeOnlyModule("bootstrap.ts", code)).toBe(false);
	});

	test("a module with a runtime re-export is not type-only", () => {
		const code = [
			"export type Options = { enabled: boolean };",
			'export { start } from "./server.js";',
		].join("\n");
		expect(isTypeOnlyModule("server.ts", code)).toBe(false);
	});

	test("a module with an expression statement is not type-only", () => {
		const code = [
			"export interface Options { enabled: boolean; }",
			"init();",
		].join("\n");
		expect(isTypeOnlyModule("init.ts", code)).toBe(false);
	});

	test("same-line runtime code after a type declaration is not type-only", () => {
		const code = "export type Options = { enabled: boolean }; init();";
		expect(isTypeOnlyModule("inline-init.ts", code)).toBe(false);
	});

	test("a non-TS file is never type-only (Go `type X struct`)", () => {
		const code = ["type Point struct {", "  X int", "}"].join("\n");
		expect(isTypeOnlyModule("point.go", code)).toBe(false);
	});

	test("a file with no type declaration is not type-only", () => {
		const code = ['import "./side-effects.js";', "// no interface or type here"].join("\n");
		expect(isTypeOnlyModule("bootstrap.ts", code)).toBe(false);
	});
});
