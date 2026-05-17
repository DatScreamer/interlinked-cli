// Smoke tests for shared helpers used by all check modules.
// Thorough coverage lives in generic-checks-extended.test.ts (tests run
// against the re-exported symbols, which come from this module).

import { describe, expect, test } from "vitest";
import {
	findEnclosingScope,
	getExtension,
	isCliFile,
	isGeneratedFile,
	isScriptOrCliPath,
	isTestFile,
	lineHasNoqaSuppression,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";

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
