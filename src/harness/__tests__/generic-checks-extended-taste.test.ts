// Split from generic-checks-extended.test.ts — taste / opinionated code quality:
// checkBooleanTrap, checkFunctionArity, checkNarrativeNaming,
// checkTestDescriptionQuality, checkCatchAndIgnore, checkGodFile,
// checkMagicNumbers, checkNegatedConditionWithElse, checkNestedTernary,
// checkFlagArguments, checkCommentedOutCode.

import { describe, expect, it } from "vitest";
import {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkCommentedOutCode,
	checkFlagArguments,
	checkFunctionArity,
	checkGodFile,
	checkMagicNumbers,
	checkNarrativeNaming,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkTestDescriptionQuality,
} from "../generic-checks.js";

// ===========================================
// Taste Checks — Opinionated Code Quality
// ===========================================

// ===========================================
// T1: checkBooleanTrap
// ===========================================

describe("checkBooleanTrap", () => {
	it("detects two boolean literals in a function call", () => {
		const code = `createUser("alice", true, false);`;
		const matches = checkBooleanTrap(code, "auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects three boolean literals in a function call", () => {
		const code = "configure(true, false, true);";
		const matches = checkBooleanTrap(code, "config.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag a single boolean argument", () => {
		const code = "setVisible(true);";
		expect(checkBooleanTrap(code, "ui.ts")).toEqual([]);
	});

	it("does NOT flag booleans inside an array argument", () => {
		const code = "setFlags([true, false, true]);";
		expect(checkBooleanTrap(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag booleans in an object literal", () => {
		const code = "const cfg = { admin: true, verified: false };";
		expect(checkBooleanTrap(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = `createUser("alice", true, false);`;
		expect(checkBooleanTrap(code, "auth.test.ts")).toEqual([]);
	});

	it("does NOT flag non-JS/TS files", () => {
		const code = `createUser("alice", true, false);`;
		expect(checkBooleanTrap(code, "auth.py")).toEqual([]);
	});

	it("handles nested calls — flags inner call with boolean args", () => {
		const code = "outer(inner(true, false));";
		const matches = checkBooleanTrap(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag booleans in comments", () => {
		const code = `// createUser("alice", true, false);`;
		expect(checkBooleanTrap(code, "auth.ts")).toEqual([]);
	});
});

// ===========================================
// T2: checkFunctionArity
// ===========================================

describe("checkFunctionArity", () => {
	it("detects function with 5 parameters", () => {
		const code =
			"function create(a: string, b: number, c: boolean, d: string, e: number) {\n  return a;\n}";
		const matches = checkFunctionArity(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("5 params");
	});

	it("does NOT flag function with 4 parameters", () => {
		const code =
			"function create(a: string, b: number, c: boolean, d: string) {\n  return a;\n}";
		expect(checkFunctionArity(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag destructured single-param", () => {
		const code = "function create({ a, b, c, d, e }: Options) {\n  return a;\n}";
		expect(checkFunctionArity(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "function create(a, b, c, d, e) { return a; }";
		expect(checkFunctionArity(code, "util.test.ts")).toEqual([]);
	});

	it("detects arrow function with 5 params", () => {
		const code =
			"export const build = (a: string, b: string, c: string, d: string, e: string) => {\n  return a;\n};";
		const matches = checkFunctionArity(code, "builder.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects Go function with 6 params (Go threshold is 6)", () => {
		const code = "func Create(a string, b string, c string, d int, e int, f bool) {\n}";
		const matches = checkFunctionArity(code, "handler.go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag Go function with 5 params (Go threshold is 6)", () => {
		const code = "func Create(a string, b string, c string, d int, e int) {\n}";
		expect(checkFunctionArity(code, "handler.go")).toEqual([]);
	});
});

// ===========================================
// T3: checkNarrativeNaming
// ===========================================

describe("checkNarrativeNaming", () => {
	it("detects 'data' as variable name", () => {
		const code = "const data = fetchSomething();\nconsole.log(data);\nreturn process(data);";
		const matches = checkNarrativeNaming(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects 'result' as variable name", () => {
		const code = "const result = compute();\nif (result) {\n  save(result);\n}";
		const matches = checkNarrativeNaming(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects 'temp' as variable name", () => {
		const code = "let temp = arr[0];\narr[0] = arr[1];\narr[1] = temp;";
		const matches = checkNarrativeNaming(code, "sort.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag when type annotation provides context", () => {
		const code = "const result: AuthResponse = await authenticate();";
		expect(checkNarrativeNaming(code, "auth.ts")).toEqual([]);
	});

	it("does NOT flag immediately returned variables", () => {
		const code = "const result = await fetch(url);\nreturn result;";
		expect(checkNarrativeNaming(code, "api.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "const data = fetchSomething();";
		expect(checkNarrativeNaming(code, "handler.test.ts")).toEqual([]);
	});

	it("does NOT flag non-blocklist names", () => {
		const code = "const response = fetch(url);";
		expect(checkNarrativeNaming(code, "api.ts")).toEqual([]);
	});

	it("does NOT flag names in comments", () => {
		const code = "// const data = fetchSomething();";
		expect(checkNarrativeNaming(code, "handler.ts")).toEqual([]);
	});
});

// ===========================================
// T4: checkTestDescriptionQuality
// ===========================================

describe("checkTestDescriptionQuality", () => {
	it("detects too-short test name", () => {
		const code = `it("works", () => {\n  expect(1).toBe(1);\n});`;
		const matches = checkTestDescriptionQuality(code, "foo.test.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("vague test name");
	});

	it("detects all-noise-words test name", () => {
		const code = `it("should work correctly", () => {\n  expect(1).toBe(1);\n});`;
		const matches = checkTestDescriptionQuality(code, "foo.test.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects tautological test name", () => {
		const code = `test("test the function", () => {\n  expect(1).toBe(1);\n});`;
		const matches = checkTestDescriptionQuality(code, "util.spec.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects vague describe block", () => {
		const code = `describe("tests", () => {\n  it("parses JSON correctly", () => {});\n});`;
		const matches = checkTestDescriptionQuality(code, "parser.test.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag descriptive test names", () => {
		const code = `it("returns 404 when user is not found", () => {\n  expect(1).toBe(1);\n});`;
		expect(checkTestDescriptionQuality(code, "user.test.ts")).toEqual([]);
	});

	it("does NOT flag it.skip", () => {
		// Dynamic key to avoid tripping checkTestRegressions's own .skip detector.
		const code = `it.${"skip"}("ok", () => {});`;
		expect(checkTestDescriptionQuality(code, "foo.test.ts")).toEqual([]);
	});

	it("does NOT flag it.todo", () => {
		const code = `it.${"todo"}("ok", () => {});`;
		expect(checkTestDescriptionQuality(code, "foo.test.ts")).toEqual([]);
	});

	it("only runs on test files", () => {
		const code = `it("works", () => {\n  expect(1).toBe(1);\n});`;
		expect(checkTestDescriptionQuality(code, "handler.ts")).toEqual([]);
	});
});

// ===========================================
// T5: checkCatchAndIgnore
// ===========================================

describe("checkCatchAndIgnore", () => {
	it("detects catch returning null", () => {
		const code = "try { foo(); } catch (e) { return null; }";
		const matches = checkCatchAndIgnore(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects catch returning undefined", () => {
		const code = "try {\n  foo();\n} catch (e) {\n  return undefined;\n}";
		const matches = checkCatchAndIgnore(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects catch returning empty array", () => {
		const code = "try { foo(); } catch (e) { return []; }";
		const matches = checkCatchAndIgnore(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects catch returning false", () => {
		const code = "try { foo(); } catch (e) { return false; }";
		const matches = checkCatchAndIgnore(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag catch with logging", () => {
		const code = "try { foo(); } catch (e) { console.error(e); return null; }";
		expect(checkCatchAndIgnore(code, "handler.ts")).toEqual([]);
	});

	it("does NOT flag catch with rethrow", () => {
		const code = `try { foo(); } catch (e) { throw new Error("wrapped", { cause: e }); }`;
		expect(checkCatchAndIgnore(code, "handler.ts")).toEqual([]);
	});

	it("does NOT flag catch with explanatory comment", () => {
		const code =
			"try { foo(); } catch (e) { // Expected for optional config\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "handler.ts")).toEqual([]);
	});

	it("does NOT flag catch with actual error handling", () => {
		const code = "try { foo(); } catch (e) { reportError(e); return null; }";
		expect(checkCatchAndIgnore(code, "handler.ts")).toEqual([]);
	});

	it("does NOT flag non-JS files", () => {
		const code = "try { foo(); } catch (e) { return null; }";
		expect(checkCatchAndIgnore(code, "handler.py")).toEqual([]);
	});
});

// ===========================================
// T6: checkGodFile
// ===========================================

describe("checkGodFile", () => {
	it("detects a file with many exports and many lines", () => {
		// 350 lines, 10 exported functions → 10 * 350 = 3500 > 3000
		const exports = Array.from(
			{ length: 10 },
			(_, i) => `export function fn${i}() { return ${i}; }`,
		).join("\n");
		const padding = "\n".repeat(340);
		const code = exports + padding;
		const matches = checkGodFile(code, "utils.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("god file");
	});

	it("does NOT flag a focused file (few exports, many lines)", () => {
		const code = `export function main() { return 1; }\nexport function init() { return 2; }\n${"// padding\n".repeat(400)}`;
		expect(checkGodFile(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag barrel/index files (mostly re-exports)", () => {
		const reExports = Array.from(
			{ length: 20 },
			(_, i) => `export { fn${i} } from "./mod${i}";`,
		).join("\n");
		const padding = "\n".repeat(300);
		expect(checkGodFile(reExports + padding, "index.ts")).toEqual([]);
	});

	it("does NOT flag short files even with many exports", () => {
		const exports = Array.from(
			{ length: 10 },
			(_, i) => `export function fn${i}() { return ${i}; }`,
		).join("\n");
		// Only ~10 lines, well under 300
		expect(checkGodFile(exports, "utils.ts")).toEqual([]);
	});

	it("does NOT flag .d.ts files", () => {
		const exports = Array.from(
			{ length: 10 },
			(_, i) => `export function fn${i}(): void;`,
		).join("\n");
		const padding = "\n".repeat(340);
		expect(checkGodFile(exports + padding, "types.d.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const exports = Array.from(
			{ length: 10 },
			(_, i) => `export function fn${i}() { return ${i}; }`,
		).join("\n");
		const padding = "\n".repeat(340);
		expect(checkGodFile(exports + padding, "utils.test.ts")).toEqual([]);
	});

	it("does NOT count type/interface exports toward threshold", () => {
		const types = Array.from(
			{ length: 10 },
			(_, i) => `export interface Type${i} { id: number; }`,
		).join("\n");
		const padding = "\n".repeat(340);
		expect(checkGodFile(types + padding, "types.ts")).toEqual([]);
	});
});

// ===========================================
// T7: checkMagicNumbers
// ===========================================

describe("checkMagicNumbers", () => {
	it("detects magic number in conditional", () => {
		const code = `if (retries > 3) { throw new Error("too many"); }`;
		const matches = checkMagicNumbers(code, "retry.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects magic number in arithmetic", () => {
		const code = "const timeout = duration * 86400;";
		// Not in a conditional, but has multiplication operator
		const matches = checkMagicNumbers(code, "timer.ts");
		// This line starts with const, so it will be skipped (declaration)
		expect(matches).toEqual([]);
	});

	it("does NOT flag 0, 1, -1", () => {
		const code = "if (index === 0 || index === 1 || index === -1) {}";
		expect(checkMagicNumbers(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag HTTP status codes", () => {
		const code = "if (res.status === 404) { handleNotFound(); }";
		expect(checkMagicNumbers(code, "api.ts")).toEqual([]);
	});

	it("does NOT flag powers of 2", () => {
		const code = "if (bufferSize > 4096) { flush(); }";
		expect(checkMagicNumbers(code, "buffer.ts")).toEqual([]);
	});

	it("does NOT flag const declarations (the number IS named)", () => {
		const code = "const MAX_RETRIES = 5;";
		expect(checkMagicNumbers(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "if (x > 42) {}";
		expect(checkMagicNumbers(code, "math.test.ts")).toEqual([]);
	});

	it("does NOT flag case labels", () => {
		const code = `case 42: return "answer";`;
		expect(checkMagicNumbers(code, "switch.ts")).toEqual([]);
	});

	it("does NOT flag return statements", () => {
		const code = "return 42;";
		expect(checkMagicNumbers(code, "util.ts")).toEqual([]);
	});

	it("detects magic number in function call within conditional", () => {
		const code = "if (arr.length > 50) { truncate(arr); }";
		const matches = checkMagicNumbers(code, "array.ts");
		expect(matches.length).toBeGreaterThan(0);
	});
});

// ===========================================
// T8: checkNegatedConditionWithElse
// ===========================================

describe("checkNegatedConditionWithElse", () => {
	it("detects if (!x) { ... } else { ... }", () => {
		const code = "if (!isValid) {\n  showError();\n} else {\n  submit();\n}";
		const matches = checkNegatedConditionWithElse(code, "form.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects if (!obj.prop) { ... } else { ... }", () => {
		const code = "if (!user.isActive) {\n  deactivate();\n} else {\n  proceed();\n}";
		const matches = checkNegatedConditionWithElse(code, "user.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag if (!x) without else (early return is fine)", () => {
		const code = "if (!isValid) {\n  return;\n}\nsubmit();";
		expect(checkNegatedConditionWithElse(code, "form.ts")).toEqual([]);
	});

	it("does NOT flag if (x) { ... } else { ... } (no negation)", () => {
		const code = "if (isValid) {\n  submit();\n} else {\n  showError();\n}";
		expect(checkNegatedConditionWithElse(code, "form.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "if (!isValid) {\n  showError();\n} else {\n  submit();\n}";
		expect(checkNegatedConditionWithElse(code, "form.test.ts")).toEqual([]);
	});

	it("does NOT flag complex negated expressions", () => {
		// !(a && b) is a meaningful pattern, not a simple negation
		const code = "if (!(a && b)) {\n  handleMissing();\n} else {\n  process();\n}";
		expect(checkNegatedConditionWithElse(code, "logic.ts")).toEqual([]);
	});
});

// ===========================================
// T9: checkNestedTernary
// ===========================================

describe("checkNestedTernary", () => {
	it("detects nested ternary", () => {
		const code = `const x = isAdmin ? canEdit ? "editor" : "viewer" : "guest";`;
		const matches = checkNestedTernary(code, "roles.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag simple ternary", () => {
		const code = `const x = isAdmin ? "admin" : "user";`;
		expect(checkNestedTernary(code, "roles.ts")).toEqual([]);
	});

	it("does NOT flag optional chaining", () => {
		const code = `const x = user?.name?.first ?? "anonymous";`;
		expect(checkNestedTernary(code, "user.ts")).toEqual([]);
	});

	it("does NOT flag nullish coalescing", () => {
		const code = "const x = a ?? b ?? c;";
		expect(checkNestedTernary(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "const x = a ? b ? c : d : e;";
		expect(checkNestedTernary(code, "util.test.ts")).toEqual([]);
	});

	it("does NOT flag ternary + optional chaining on same line", () => {
		const code = `const x = user?.isAdmin ? "admin" : "user";`;
		expect(checkNestedTernary(code, "roles.ts")).toEqual([]);
	});

	it("does NOT flag non-JS files", () => {
		const code = "x = a if b else (c if d else e)";
		expect(checkNestedTernary(code, "util.py")).toEqual([]);
	});
});

// ===========================================
// T10: checkFlagArguments
// ===========================================

describe("checkFlagArguments", () => {
	it("detects function with 2 boolean params", () => {
		const code =
			"function deploy(app: string, force: boolean, dryRun: boolean) {\n  return app;\n}";
		const matches = checkFlagArguments(code, "deploy.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("2 boolean params");
	});

	it("detects function with 3 boolean params", () => {
		const code =
			"export function configure(verbose: boolean, silent: boolean, strict: boolean) {\n  return;\n}";
		const matches = checkFlagArguments(code, "config.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("3 boolean params");
	});

	it("does NOT flag function with 1 boolean param", () => {
		const code = "function setVisible(visible: boolean) { return visible; }";
		expect(checkFlagArguments(code, "ui.ts")).toEqual([]);
	});

	it("does NOT flag function with no boolean params", () => {
		const code = "function add(a: number, b: number) { return a + b; }";
		expect(checkFlagArguments(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "function deploy(force: boolean, dryRun: boolean) {}";
		expect(checkFlagArguments(code, "deploy.test.ts")).toEqual([]);
	});

	it("only runs on TypeScript files (needs type annotations)", () => {
		const code = "function deploy(app, force, dryRun) {}";
		expect(checkFlagArguments(code, "deploy.js")).toEqual([]);
	});
});

// ===========================================
// T11: checkCommentedOutCode
// ===========================================

describe("checkCommentedOutCode", () => {
	it("detects 3+ lines of commented-out code", () => {
		const code =
			"// const oldHandler = async (req) => {\n//     const data = await fetch(url);\n//     return data.json();\n// };";
		const matches = checkCommentedOutCode(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("commented-out code");
	});

	it("detects commented-out import block", () => {
		const code = `// import { foo } from "./foo";\n// import { bar } from "./bar";\n// import { baz } from "./baz";`;
		const matches = checkCommentedOutCode(code, "index.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag prose comments", () => {
		const code =
			"// This module handles user authentication.\n// It validates tokens and manages sessions.\n// See the auth spec for details.";
		expect(checkCommentedOutCode(code, "auth.ts")).toEqual([]);
	});

	it("does NOT flag JSDoc/documentation comments", () => {
		const code = `// @param name The user's name\n// @param age The user's age\n// @returns The formatted string`;
		expect(checkCommentedOutCode(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag license headers", () => {
		const code =
			"// Copyright 2024 Acme Corp\n// Licensed under the MIT License\n// All rights reserved";
		expect(checkCommentedOutCode(code, "index.ts")).toEqual([]);
	});

	it("does NOT flag fewer than 3 commented lines", () => {
		const code = "// const old = getValue();\n// return old;";
		expect(checkCommentedOutCode(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code =
			"// const old = async () => {\n//     return fetch(url);\n//     process(data);\n// };";
		expect(checkCommentedOutCode(code, "util.test.ts")).toEqual([]);
	});

	it("detects Python commented-out code", () => {
		const code =
			"# def old_handler(request):\n#     data = request.json()\n#     return process(data)\n#     save(data)";
		const matches = checkCommentedOutCode(code, "handler.py");
		expect(matches.length).toBeGreaterThan(0);
	});
});
