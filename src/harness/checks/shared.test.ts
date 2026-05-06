// Smoke tests for shared helpers used by all check modules.
// Thorough coverage lives in generic-checks-extended.test.ts (tests run
// against the re-exported symbols, which come from this module).

import { describe, expect, test } from "vitest";
import {
	findEnclosingScope,
	getExtension,
	isCliFile,
	isTestFile,
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

	test("scanLinesStripped reports original text but tests stripped", () => {
		const original = ["const x = 1; // hit", "const y = 2;"];
		const stripped = ["const x = 1;      ", "const y = 2;"];
		const found = scanLinesStripped(original, stripped, /x = 1/, 10);
		expect(found).toHaveLength(1);
		expect(found[0]).toEqual({ line: 1, text: "const x = 1; // hit" });
	});
});
