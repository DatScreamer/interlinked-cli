// Split from generic-checks-extended.test.ts — taste / opinionated code quality:
// checkBooleanTrap, checkFunctionArity, checkNarrativeNaming,
// checkTestDescriptionQuality, checkCatchAndIgnore, checkGodFile,
// checkMagicNumbers, checkNegatedConditionWithElse, checkNestedTernary,
// checkFlagArguments, checkCommentedOutCode.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkCommentedOutCode,
	checkFlagArguments,
	checkFunctionArity,
	checkGodFile,
	checkMagicNumbers,
	checkManyOptionalParams,
	checkNarrativeNaming,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkPositionalOptionalBoolean,
	checkSameTypedPrimitiveParams,
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
		expect(nonNull(matches[0]).text).toContain("5 params");
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
// T2b: checkPositionalOptionalBoolean — signature-side twin of checkBooleanTrap
// ===========================================

describe("checkPositionalOptionalBoolean", () => {
	// --- positive cases (must fire) ---

	it("detects `flag?: boolean` as positional optional boolean", () => {
		const code = "export function setUser(name: string, force?: boolean) {\n  return name;\n}";
		const matches = checkPositionalOptionalBoolean(code, "user.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("force");
	});

	it("detects `flag: boolean = false` (typed default)", () => {
		const code =
			"export function configure(host: string, verbose: boolean = false) {\n  return host;\n}";
		const matches = checkPositionalOptionalBoolean(code, "cfg.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("verbose");
	});

	it("detects `flag = false` (inferred default, no annotation)", () => {
		const code = "function send(msg: string, retry = true) {\n  return msg;\n}";
		const matches = checkPositionalOptionalBoolean(code, "send.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("retry");
	});

	it("detects positional optional boolean in arrow function", () => {
		const code = "export const send = (msg: string, retry?: boolean) => msg;";
		const matches = checkPositionalOptionalBoolean(code, "send.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects positional optional boolean across a multi-line signature", () => {
		const code = [
			"export function build(",
			"  name: string,",
			"  cache?: boolean,",
			") {",
			"  return name;",
			"}",
		].join("\n");
		const matches = checkPositionalOptionalBoolean(code, "build.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	// --- negative cases (must NOT fire) ---

	it("does NOT flag boolean inside an options object", () => {
		const code =
			"export function setUser(name: string, opts: { force?: boolean }) {\n  return name;\n}";
		expect(checkPositionalOptionalBoolean(code, "user.ts")).toEqual([]);
	});

	it("does NOT flag a required (non-optional) boolean", () => {
		const code = "export function setUser(name: string, force: boolean) {\n  return name;\n}";
		expect(checkPositionalOptionalBoolean(code, "user.ts")).toEqual([]);
	});

	it("does NOT flag a union-typed optional (`flag?: boolean | null`)", () => {
		const code =
			"export function setUser(name: string, force?: boolean | null) {\n  return name;\n}";
		expect(checkPositionalOptionalBoolean(code, "user.ts")).toEqual([]);
	});

	it("does NOT flag an optional string", () => {
		const code = "export function greet(name: string, suffix?: string) {\n  return name + suffix;\n}";
		expect(checkPositionalOptionalBoolean(code, "greet.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "export function setUser(name: string, force?: boolean) {\n  return name;\n}";
		expect(checkPositionalOptionalBoolean(code, "user.test.ts")).toEqual([]);
	});

	it("does NOT flag non-JS/TS files", () => {
		const code = "fn set_user(name: &str, force: Option<bool>) { }";
		expect(checkPositionalOptionalBoolean(code, "user.rs")).toEqual([]);
	});
});

// ===========================================
// T2c: checkManyOptionalParams — combinatorial explosion at the signature
// ===========================================

describe("checkManyOptionalParams", () => {
	// --- positive cases (must fire) ---

	it("detects 3 optional `?:` params", () => {
		const code =
			"export function build(name: string, a?: number, b?: string, c?: boolean) {\n  return name;\n}";
		const matches = checkManyOptionalParams(code, "build.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("3 optional params");
	});

	it("detects a mix of `?:` and `=` defaults adding up to 3", () => {
		const code =
			"function send(msg: string, retry?: boolean, timeout = 1000, host: string = 'localhost') {\n  return msg;\n}";
		const matches = checkManyOptionalParams(code, "send.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects 4+ optional params (ride-along nudge for higher counts)", () => {
		const code =
			"export function create(name: string, a?: number, b?: number, c?: number, d?: number) {\n  return name;\n}";
		const matches = checkManyOptionalParams(code, "create.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("4 optional params");
	});

	// --- negative cases (must NOT fire) ---

	it("does NOT flag 2 optional params (under threshold)", () => {
		const code =
			"export function build(name: string, a?: number, b?: string) {\n  return name;\n}";
		expect(checkManyOptionalParams(code, "build.ts")).toEqual([]);
	});

	it("does NOT flag a signature with no optional params", () => {
		const code =
			"export function transfer(from: string, to: string, amount: number) {\n  return from;\n}";
		expect(checkManyOptionalParams(code, "tx.ts")).toEqual([]);
	});

	it("does NOT count a rest param as optional (variadic, not combinatorial)", () => {
		const code =
			"export function logAll(prefix: string, a?: number, b?: number, ...rest: string[]) {\n  return prefix;\n}";
		expect(checkManyOptionalParams(code, "log.ts")).toEqual([]);
	});

	it("does NOT flag when optionality is inside an options object (one positional param)", () => {
		const code =
			"export function build(name: string, opts: { a?: number; b?: string; c?: boolean }) {\n  return name;\n}";
		expect(checkManyOptionalParams(code, "build.ts")).toEqual([]);
	});

	it("does NOT confuse a default-value object literal for additional params", () => {
		const code = "export function build(opts: Opts = { a: 1, b: 2, c: 3 }) {\n  return opts;\n}";
		expect(checkManyOptionalParams(code, "build.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code =
			"export function build(name: string, a?: number, b?: string, c?: boolean) {\n  return name;\n}";
		expect(checkManyOptionalParams(code, "build.test.ts")).toEqual([]);
	});

	it("does NOT flag callback-shaped params (function type with internal optionality)", () => {
		const code =
			"export function listen(handler: (msg?: string, code?: number) => void) {\n  return handler;\n}";
		expect(checkManyOptionalParams(code, "listen.ts")).toEqual([]);
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
		expect(nonNull(matches[0]).text).toContain("vague test name");
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
		expect(nonNull(matches[0]).text).toContain("god file");
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
		expect(nonNull(matches[0]).text).toContain("2 boolean params");
	});

	it("detects function with 3 boolean params", () => {
		const code =
			"export function configure(verbose: boolean, silent: boolean, strict: boolean) {\n  return;\n}";
		const matches = checkFlagArguments(code, "config.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("3 boolean params");
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
		expect(nonNull(matches[0]).text).toContain("commented-out code");
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

	// --- Additional positive cases: genuinely disabled executable code ---

	it("detects a commented-out if/return statement block", () => {
		const code = ["// if (y) {", "//   doThing();", "//   return;", "// }"].join("\n");
		expect(checkCommentedOutCode(code, "handler.ts").length).toBeGreaterThan(0);
	});

	it("detects a block of commented-out const declarations and calls", () => {
		const code = [
			"// const cache = new Map();",
			"// loadConfig(cache);",
			"// startServer(port);",
		].join("\n");
		expect(checkCommentedOutCode(code, "server.ts").length).toBeGreaterThan(0);
	});

	it("detects commented-out assignment statements", () => {
		const code = [
			"// this.retries = 3;",
			'// this.endpoint = "https://api.example.com";',
			"// this.timeout = computeTimeout();",
		].join("\n");
		expect(checkCommentedOutCode(code, "client.ts").length).toBeGreaterThan(0);
	});

	// --- FP regression cases: documentation comments must NEVER fire ------

	it("does NOT flag an illustrative record-shape doc comment (event-normalizers FP)", () => {
		// This is the exact false-positive class from
		// src/lib/hook-template-chunks/event-normalizers.ts: a doc comment
		// drawing a canonical event record. Braces, colons, and parentheticals
		// are illustrative, not disabled code.
		const code = [
			"// Each client maps the raw payload to a canonical record:",
			"//",
			"//   {",
			'//     event_type: "session_start" | "tool_use" | ...',
			"//     tool_name: string | null",
			"//     hook_event: <original native event name, preserved verbatim>",
			"//     ...event-specific fields (tool_input, tokens, prompt, etc.)",
			"//     ...envelope fields (cwd, transcript_path, session_id_hint)",
			"//   }",
		].join("\n");
		expect(checkCommentedOutCode(code, "event-normalizers.ts")).toEqual([]);
	});

	it("does NOT flag an ASCII diagram in a comment", () => {
		const code = [
			"// +--------+      +--------+",
			"// | client | ---> | server |",
			"// +--------+      +--------+",
		].join("\n");
		expect(checkCommentedOutCode(code, "arch.ts")).toEqual([]);
	});

	it("does NOT flag a multi-line prose paragraph", () => {
		const code = [
			"// The downstream pipeline (local JSONL append, harness forwarding,",
			"// server POST) speaks only this canonical shape. Adding a new client",
			"// means authoring exactly one normalizer and one detector entry.",
		].join("\n");
		expect(checkCommentedOutCode(code, "pipeline.ts")).toEqual([]);
	});

	it("does NOT flag a JSDoc-style illustrative API block", () => {
		const code = [
			"// Example usage:",
			"//   getUser(id): Promise<User>",
			"//   listUsers(): Promise<User[]>",
			"//   deleteUser(id): void",
		].join("\n");
		expect(checkCommentedOutCode(code, "api.ts")).toEqual([]);
	});

	it("does NOT flag a bare type-annotation shape list", () => {
		const code = [
			"// Config fields:",
			"//   name: string",
			"//   retries: number",
			"//   verbose: boolean",
		].join("\n");
		expect(checkCommentedOutCode(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag prose with incidental parentheticals", () => {
		const code = [
			"// The parser accepts JSON (objects, arrays, and scalars).",
			"// It rejects trailing commas (a common authoring mistake).",
			"// Every error carries the byte offset (1-indexed) for context.",
		].join("\n");
		expect(checkCommentedOutCode(code, "parser.ts")).toEqual([]);
	});
});

// ===========================================
// T12: checkSameTypedPrimitiveParams
// ===========================================

describe("checkSameTypedPrimitiveParams", () => {
	// --- Positive cases (must fire) ---

	it("flags exported function with two consecutive string params", () => {
		const code = `export function transfer(fromId: string, toId: string, amount: number) {\n  return amount;\n}`;
		const matches = checkSameTypedPrimitiveParams(code, "transfers.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("string");
		expect(nonNull(matches[0]).text).toContain("fromId");
		expect(nonNull(matches[0]).text).toContain("toId");
	});

	it("flags exported function with two consecutive number params (names NOT in allowlist)", () => {
		const code = `export function range(start: number, end: number) {\n  return end - start;\n}`;
		const matches = checkSameTypedPrimitiveParams(code, "range.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("number");
		expect(nonNull(matches[0]).text).toContain("start");
		expect(nonNull(matches[0]).text).toContain("end");
	});

	it("flags public method on an exported class", () => {
		const code =
			"export class API {\n" +
			"  fetch(url: string, token: string) {\n" +
			"    return url + token;\n" +
			"  }\n" +
			"}";
		const matches = checkSameTypedPrimitiveParams(code, "api.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("string");
		expect(nonNull(matches[0]).text).toContain("url");
		expect(nonNull(matches[0]).text).toContain("token");
	});

	it("flags exported arrow function with two same-typed params", () => {
		const code = `export const concat = (left: string, right: string) => left + right;`;
		const matches = checkSameTypedPrimitiveParams(code, "concat.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags three consecutive same-typed primitives but only emits one finding", () => {
		const code = `export function compare(a: number, b: number, c: number) {\n  return a + b + c;\n}`;
		const matches = checkSameTypedPrimitiveParams(code, "math.ts");
		expect(matches.length).toBe(1);
	});

	// --- Negative cases (must NOT fire) ---

	it("does NOT flag non-exported function", () => {
		const code = `function _internal(a: string, b: string) {\n  return a + b;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "internal.ts")).toEqual([]);
	});

	it("does NOT flag coordinate-shaped params (x, y)", () => {
		const code = `export function setPoint(x: number, y: number) {\n  return x + y;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "geom.ts")).toEqual([]);
	});

	it("does NOT flag RGB color-shaped params (r, g, b)", () => {
		const code = `export function rgb(r: number, g: number, b: number) {\n  return r + g + b;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "color.ts")).toEqual([]);
	});

	it("does NOT flag width/height pair", () => {
		const code = `export function size(width: number, height: number) {\n  return width * height;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "layout.ts")).toEqual([]);
	});

	it("does NOT flag lat/lng pair", () => {
		const code = `export function project(lat: number, lng: number) {\n  return [lat, lng];\n}`;
		expect(checkSameTypedPrimitiveParams(code, "geo.ts")).toEqual([]);
	});

	it("does NOT flag branded / named-type params", () => {
		const code = `export function transfer(from: UserId, to: AccountId, amount: number) {\n  return amount;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "transfers.ts")).toEqual([]);
	});

	it("does NOT flag params of different primitive types", () => {
		const code = `export function pair(name: string, age: number) {\n  return name + age;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "people.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = `export function transfer(fromId: string, toId: string) {\n  return fromId;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "transfers.test.ts")).toEqual([]);
	});

	it("does NOT flag non-TS files", () => {
		const code = `export function transfer(fromId, toId) {\n  return fromId;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "transfers.js")).toEqual([]);
	});

	it("does NOT flag rest params even when same-typed", () => {
		const code = `export function logAll(prefix: string, ...args: string[]) {\n  return prefix + args.join(',');\n}`;
		expect(checkSameTypedPrimitiveParams(code, "logger.ts")).toEqual([]);
	});

	it("does NOT flag array params even when same-typed underlying element", () => {
		const code = `export function joinPair(a: string[], b: string[]) {\n  return a.concat(b);\n}`;
		expect(checkSameTypedPrimitiveParams(code, "arr.ts")).toEqual([]);
	});

	it("does NOT flag constructors on exported classes (value-object holder convention)", () => {
		const code =
			"export class Point {\n" +
			"  constructor(public x: string, public y: string) {}\n" +
			"}";
		expect(checkSameTypedPrimitiveParams(code, "point.ts")).toEqual([]);
	});

	it("does NOT flag private methods on exported classes", () => {
		const code =
			"export class API {\n" +
			"  private build(a: string, b: string) {\n" +
			"    return a + b;\n" +
			"  }\n" +
			"}";
		expect(checkSameTypedPrimitiveParams(code, "api.ts")).toEqual([]);
	});

	it("does NOT flag methods on non-exported classes", () => {
		const code =
			"class Internal {\n" +
			"  fetch(a: string, b: string) {\n" +
			"    return a + b;\n" +
			"  }\n" +
			"}";
		expect(checkSameTypedPrimitiveParams(code, "internal.ts")).toEqual([]);
	});

	it("does NOT flag single-letter index-pair (i, j)", () => {
		const code = `export function swap(i: number, j: number) {\n  return i + j;\n}`;
		expect(checkSameTypedPrimitiveParams(code, "swap.ts")).toEqual([]);
	});

	it("does NOT flag min/max pair", () => {
		const code = `export function clampRange(min: number, max: number) {\n  return [min, max];\n}`;
		expect(checkSameTypedPrimitiveParams(code, "clamp.ts")).toEqual([]);
	});

	it("flags exported function whose signature wraps across lines", () => {
		const code =
			"export function deposit(\n" +
			"  fromAccount: string,\n" +
			"  toAccount: string,\n" +
			"  amount: number,\n" +
			") {\n  return amount;\n}";
		const matches = checkSameTypedPrimitiveParams(code, "deposit.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag union-typed params even when one branch is a primitive", () => {
		const code = `export function set(key: string | null, value: string | null) {\n  return [key, value];\n}`;
		expect(checkSameTypedPrimitiveParams(code, "kv.ts")).toEqual([]);
	});

	it("does NOT flag two boolean params (handled by flag_argument)", () => {
		// Two booleans are still orderable-by-mistake, but the flag_argument
		// detector owns that pattern with a more specific fix instruction.
		// Confirm we DO flag it — keeping the negative form here would
		// double-claim the boolean case.
		const code = `export function configure(verbose: boolean, silent: boolean) {\n  return verbose;\n}`;
		const matches = checkSameTypedPrimitiveParams(code, "config.ts");
		// We do fire — same orderable-by-mistake structural issue — and the
		// agent gets both nudges (struct param OR options object). Confirm
		// the message tags `boolean`.
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text).toContain("boolean");
	});
});
