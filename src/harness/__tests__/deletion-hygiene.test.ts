import { describe, expect, it } from "vitest";
import {
	checkDeletionCommentAdded,
	checkDeprecationAdded,
	checkOrphanedTests,
	checkReplacedWithStub,
	checkTestGutted,
} from "../deletion-hygiene.js";
import { nonNull } from "../../lib/non-null.js";

// ===========================================
// Layer 2: Diff-Aware Zombie Detectors
// ===========================================

describe("checkReplacedWithStub", () => {
	it("detects working code replaced with throw Not implemented", () => {
		const oldStr =
			"function process(data) {\n  if (data.valid) {\n    return transform(data);\n  }\n  return fallback();\n}";
		const newStr = 'function process(data) {\n  throw new Error("Not implemented");\n}';
		const findings = checkReplacedWithStub(oldStr, newStr, "handler.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("replaced-with-stub");
	});

	it("detects working code replaced with return null", () => {
		const oldStr =
			"function getData() {\n  const res = await fetch(url);\n  if (!res.ok) throw new Error();\n  return res.json();\n}";
		const newStr = "function getData() {\n  return null;\n}";
		const findings = checkReplacedWithStub(oldStr, newStr, "api.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when old code was already trivial", () => {
		const oldStr = "function noop() {\n  return;\n}";
		const newStr = "function noop() {\n  return null;\n}";
		expect(checkReplacedWithStub(oldStr, newStr, "util.ts")).toEqual([]);
	});

	it("does NOT flag when new code has real logic", () => {
		const oldStr = "function old() {\n  if (x) return a;\n  return b;\n}";
		const newStr = "function updated() {\n  if (y) return c;\n  return d;\n}";
		expect(checkReplacedWithStub(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const oldStr = "function process() {\n  if (x) return a;\n  return b;\n}";
		const newStr = 'function process() {\n  throw new Error("Not implemented");\n}';
		expect(checkReplacedWithStub(oldStr, newStr, "handler.test.ts")).toEqual([]);
	});
});

describe("checkTestGutted", () => {
	it("detects test converted to it.skip", () => {
		const oldStr = 'it("validates input", () => {\n  expect(validate("x")).toBe(true);\n});';
		const newStr = `it.${"skip"}("validates input", () => {\n});`;
		const findings = checkTestGutted(oldStr, newStr, "validate.test.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("test-gutted");
	});

	it("detects test body emptied", () => {
		const oldStr =
			'it("parses JSON", () => {\n  const result = parse("{}");\n  expect(result).toEqual({});\n});';
		const newStr = 'it("parses JSON", () => {\n});';
		const findings = checkTestGutted(oldStr, newStr, "parser.test.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when assertions remain", () => {
		const oldStr = 'it("adds", () => {\n  expect(1+1).toBe(2);\n  expect(2+2).toBe(4);\n});';
		const newStr = 'it("adds", () => {\n  expect(1+1).toBe(2);\n});';
		expect(checkTestGutted(oldStr, newStr, "math.test.ts")).toEqual([]);
	});

	it("does NOT flag non-test files", () => {
		const oldStr = 'it("validates", () => {\n  expect(true).toBe(true);\n});';
		const newStr = `it.${"skip"}("validates", () => {});`;
		expect(checkTestGutted(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("does NOT flag when old code had no assertions", () => {
		const oldStr = 'it("logs", () => {\n  console.log("test");\n});';
		const newStr = 'it("logs", () => {});';
		expect(checkTestGutted(oldStr, newStr, "log.test.ts")).toEqual([]);
	});
});

describe("checkDeprecationAdded", () => {
	it("detects new @deprecated annotation", () => {
		const oldStr = "/** Helper function */\nexport function old() { return 1; }";
		const newStr = "/** @deprecated */\nexport function old() { return 1; }";
		const findings = checkDeprecationAdded(oldStr, newStr, "api.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("deprecation-added");
	});

	it("detects new console.warn with deprecated", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr =
			'function handler() {\n  console.warn("handler is deprecated");\n  return process();\n}';
		const findings = checkDeprecationAdded(oldStr, newStr, "handler.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when @deprecated already existed", () => {
		const oldStr = "/** @deprecated */\nexport function old() { return 1; }";
		const newStr = "/** @deprecated Use new() */\nexport function old() { return 2; }";
		expect(checkDeprecationAdded(oldStr, newStr, "api.ts")).toEqual([]);
	});

	it("does NOT flag when no deprecation is added", () => {
		const oldStr = "function a() { return 1; }";
		const newStr = "function a() { return 2; }";
		expect(checkDeprecationAdded(oldStr, newStr, "util.ts")).toEqual([]);
	});
});

describe("checkDeletionCommentAdded", () => {
	it("detects new deletion narration comment", () => {
		const oldStr = "function handler() {\n  return process();\n}";
		const newStr =
			"// Removed the old validation logic\nfunction handler() {\n  return process();\n}";
		const findings = checkDeletionCommentAdded(oldStr, newStr, "handler.ts");
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("deletion-comment-added");
	});

	it("detects 'no longer needed' comment added", () => {
		const oldStr = "return data;";
		const newStr = "// No longer needed after refactor\nreturn data;";
		const findings = checkDeletionCommentAdded(oldStr, newStr, "api.ts");
		expect(findings.length).toBeGreaterThan(0);
	});

	it("does NOT flag when deletion comment already existed", () => {
		const oldStr = "// Previously this called oldFunc()\nreturn newFunc();";
		const newStr = "// Previously this called oldFunc()\nreturn updatedFunc();";
		expect(checkDeletionCommentAdded(oldStr, newStr, "handler.ts")).toEqual([]);
	});

	it("does NOT flag regular comments", () => {
		const oldStr = "return data;";
		const newStr = "// Process the incoming data\nreturn data;";
		expect(checkDeletionCommentAdded(oldStr, newStr, "handler.ts")).toEqual([]);
	});
});

// ===========================================
// Layer 3: Session-Level Orphaned Tests
// ===========================================

describe("checkOrphanedTests", () => {
	it("detects removed symbol still referenced in test file", () => {
		const testContent =
			'import { validateToken } from "../auth";\n\ndescribe("validateToken", () => {\n  it("validates", () => {\n    expect(validateToken("x")).toBe(true);\n  });\n});';
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(findings.length).toBeGreaterThan(0);
		expect(nonNull(findings[0]).check).toBe("orphaned-test-reference");
		expect(nonNull(findings[0]).message).toContain("validateToken");
	});

	it("detects multiple removed symbols", () => {
		const testContent =
			"describe('auth', () => {\n  it('validates', () => validateToken());\n  it('refreshes', () => refreshToken());\n});";
		const findings = checkOrphanedTests(
			["validateToken", "refreshToken"],
			"auth.test.ts",
			testContent,
			false,
		);
		expect(findings.length).toBe(2);
	});

	it("does NOT flag when test file was already edited", () => {
		const testContent = "validateToken();";
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, true);
		expect(findings).toEqual([]);
	});

	it("does NOT flag when symbol is not referenced in test", () => {
		const testContent =
			'describe("other", () => {\n  it("works", () => expect(1).toBe(1));\n});';
		const findings = checkOrphanedTests(["validateToken"], "auth.test.ts", testContent, false);
		expect(findings).toEqual([]);
	});

	it("does NOT flag with empty removed symbols list", () => {
		const findings = checkOrphanedTests([], "auth.test.ts", "anything", false);
		expect(findings).toEqual([]);
	});

	it("uses word boundaries to avoid partial matches", () => {
		const testContent = "getUserById(); getUser();";
		const findings = checkOrphanedTests(["get"], "user.test.ts", testContent, false);
		// "get" should NOT match "getUser" or "getUserById" due to word boundaries
		expect(findings).toEqual([]);
	});
});
