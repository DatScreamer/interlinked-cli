// Split from generic-checks-extended.test.ts — deletion hygiene + error handling:
// checkNotImplementedStubs, checkEmptyFunctionBody, checkDeprecationNotice,
// checkOrphanedTestStub, checkDeletionComments, checkMixedErrorStrategy,
// checkBareCatchBlock, checkCatchReturnNull, checkThrowAsControlFlow,
// checkUntypedCatch, checkErrorStringComparison, checkInconsistentErrorStrategy.

import { describe, expect, it } from "vitest";
import {
	checkBareCatchBlock,
	checkCatchReturnNull,
	checkDeletionComments,
	checkDeprecationNotice,
	checkEmptyFunctionBody,
	checkErrorStringComparison,
	checkInconsistentErrorStrategy,
	checkMixedErrorStrategy,
	checkNotImplementedStubs,
	checkOrphanedTestStub,
	checkThrowAsControlFlow,
	checkUntypedCatch,
} from "../generic-checks.js";

// ===========================================
// Deletion Hygiene — Layer 1 Zombie Detectors
// ===========================================

// ===========================================
// D1: checkNotImplementedStubs
// ===========================================

describe("checkNotImplementedStubs", () => {
	it("detects throw new Error('Not implemented')", () => {
		const code = 'function foo() {\n  throw new Error("Not implemented");\n}';
		const matches = checkNotImplementedStubs(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects throw new Error('TODO')", () => {
		const code = "function bar() {\n  throw new Error('TODO');\n}";
		const matches = checkNotImplementedStubs(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects throw new Error('stub')", () => {
		const code = 'function baz() {\n  throw new Error("stub");\n}';
		const matches = checkNotImplementedStubs(code, "service.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects return null with TODO comment", () => {
		const code = "function get() {\n  return null; // TODO: implement\n}";
		const matches = checkNotImplementedStubs(code, "api.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag test files", () => {
		const code = 'throw new Error("Not implemented");';
		expect(checkNotImplementedStubs(code, "handler.test.ts")).toEqual([]);
	});

	it("does NOT flag real throw statements", () => {
		const code = 'throw new Error("Invalid input: expected string");';
		expect(checkNotImplementedStubs(code, "validator.ts")).toEqual([]);
	});

	it("does NOT flag non-JS files", () => {
		const code = 'throw new Error("Not implemented");';
		expect(checkNotImplementedStubs(code, "handler.py")).toEqual([]);
	});
});

// ===========================================
// D2: checkEmptyFunctionBody
// ===========================================

describe("checkEmptyFunctionBody", () => {
	it("detects empty function body", () => {
		const code = "export function processData() {}";
		const matches = checkEmptyFunctionBody(code, "processor.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("empty function body");
	});

	it("detects function returning only null", () => {
		const code = "function getData() {\n  return null;\n}";
		const matches = checkEmptyFunctionBody(code, "data.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects function returning only undefined", () => {
		const code = "function fetch() {\n  return undefined;\n}";
		const matches = checkEmptyFunctionBody(code, "api.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag functions with real code", () => {
		const code = "function add(a: number, b: number) {\n  return a + b;\n}";
		expect(checkEmptyFunctionBody(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag constructors", () => {
		const code = "constructor() {}";
		expect(checkEmptyFunctionBody(code, "service.ts")).toEqual([]);
	});

	it("does NOT flag _ prefixed functions (intentional noop)", () => {
		const code = "function _noop() {}";
		expect(checkEmptyFunctionBody(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "function setup() {}";
		expect(checkEmptyFunctionBody(code, "util.test.ts")).toEqual([]);
	});

	it("does NOT flag .d.ts files", () => {
		const code = "export function foo(): void;";
		expect(checkEmptyFunctionBody(code, "types.d.ts")).toEqual([]);
	});
});

// ===========================================
// D3: checkDeprecationNotice
// ===========================================

describe("checkDeprecationNotice", () => {
	it("detects console.warn with deprecated message", () => {
		const code = 'console.warn("This function is deprecated");';
		const matches = checkDeprecationNotice(code, "api.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("deprecation ceremony");
	});

	it("detects console.log with removed message", () => {
		const code = 'console.log("Feature X has been removed");';
		const matches = checkDeprecationNotice(code, "feature.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects @deprecated on empty function", () => {
		const code = "/** @deprecated */\nexport function oldApi() {}";
		const matches = checkDeprecationNotice(code, "api.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("@deprecated on empty/stub");
	});

	it("does NOT flag @deprecated on function with real body", () => {
		const code =
			"/** @deprecated Use newApi() instead */\nexport function oldApi() {\n  return newApi();\n  logUsage();\n}";
		expect(checkDeprecationNotice(code, "api.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = 'console.warn("deprecated");';
		expect(checkDeprecationNotice(code, "api.test.ts")).toEqual([]);
	});
});

// ===========================================
// D4: checkOrphanedTestStub
// ===========================================

describe("checkOrphanedTestStub", () => {
	it("detects test with empty body", () => {
		const code = 'it("should process data", () => {});';
		const matches = checkOrphanedTestStub(code, "data.test.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("empty test body");
	});

	it("detects test with only return", () => {
		const code = 'it("should validate", () => {\n  return;\n});';
		const matches = checkOrphanedTestStub(code, "valid.test.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag tests with assertions", () => {
		const code = 'it("should add", () => {\n  expect(1 + 1).toBe(2);\n});';
		expect(checkOrphanedTestStub(code, "math.test.ts")).toEqual([]);
	});

	it("does NOT flag it.skip (covered by checkTestRegressions)", () => {
		const code = `it.${"skip"}("should process", () => {});`;
		expect(checkOrphanedTestStub(code, "data.test.ts")).toEqual([]);
	});

	it("does NOT flag it.todo", () => {
		const code = `it.${"todo"}("should handle errors", () => {});`;
		expect(checkOrphanedTestStub(code, "error.test.ts")).toEqual([]);
	});

	it("only runs on test files", () => {
		const code = 'it("should process", () => {});';
		expect(checkOrphanedTestStub(code, "handler.ts")).toEqual([]);
	});
});

// ===========================================
// D5: checkDeletionComments
// ===========================================

describe("checkDeletionComments", () => {
	it("detects 'Removed the old auth handler'", () => {
		const code = "// Removed the old auth handler";
		const matches = checkDeletionComments(code, "auth.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].text).toContain("deletion narration");
	});

	it("detects 'No longer needed'", () => {
		const code = "// No longer needed after migration";
		const matches = checkDeletionComments(code, "migrate.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects 'Previously this called X()'", () => {
		const code = "// Previously this called validateToken()";
		const matches = checkDeletionComments(code, "auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects 'Used to call X'", () => {
		const code = "// Used to call fetchData before refactor";
		const matches = checkDeletionComments(code, "api.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects 'Was: oldFunction()'", () => {
		const code = "// Was: processLegacy()";
		const matches = checkDeletionComments(code, "handler.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag TODO comments", () => {
		const code = "// TODO: Remove this after migration";
		expect(checkDeletionComments(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag regular comments", () => {
		const code = "// This function processes incoming data";
		expect(checkDeletionComments(code, "data.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = "// Removed the old handler";
		expect(checkDeletionComments(code, "handler.test.ts")).toEqual([]);
	});

	it("detects Python deletion comments", () => {
		const code = "# Removed the old validation logic";
		const matches = checkDeletionComments(code, "validate.py");
		expect(matches.length).toBeGreaterThan(0);
	});
});

// ===========================================
// checkMixedErrorStrategy
// ===========================================

describe("checkMixedErrorStrategy", () => {
	it("detects function that both throws and returns error object", () => {
		const code = `
function handleRequest(input) {
  if (!input.name) {
    return { success: false, error: "name required" };
  }
  if (!input.id) {
    throw new Error("id is required");
  }
  return { success: true };
}`;
		const matches = checkMixedErrorStrategy(code, "handler.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("mixed error strategy");
	});

	it("detects function that throws and returns { error: }", () => {
		const code = `
async function fetchUser(id) {
  if (!id) throw new Error("missing id");
  const res = await fetch(url);
  if (!res.ok) return { error: "fetch failed" };
  return { data: await res.json() };
}`;
		const matches = checkMixedErrorStrategy(code, "api.ts");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag function that only throws", () => {
		const code = `
function validate(input) {
  if (!input.name) throw new Error("name required");
  if (!input.id) throw new Error("id required");
  return input;
}`;
		expect(checkMixedErrorStrategy(code, "validate.ts")).toEqual([]);
	});

	it("does NOT flag function that only returns error objects", () => {
		const code = `
function validate(input) {
  if (!input.name) return { success: false, error: "name required" };
  if (!input.id) return { success: false, error: "id required" };
  return { success: true, data: input };
}`;
		expect(checkMixedErrorStrategy(code, "validate.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const code = `
function handler(x) {
  if (!x) return { success: false, error: "bad" };
  throw new Error("boom");
}`;
		expect(checkMixedErrorStrategy(code, "handler.test.ts")).toEqual([]);
	});

	it("does NOT flag non-JS/TS files", () => {
		const code = `
def handler(x):
    if not x: return {"error": "bad"}
    raise ValueError("boom")`;
		expect(checkMixedErrorStrategy(code, "handler.py")).toEqual([]);
	});

	it("handles multiple functions independently", () => {
		const code = `
function clean(x) {
  if (!x) throw new Error("bad");
  return x;
}

function mixed(x) {
  if (!x) throw new Error("bad");
  return { success: false, error: "also bad" };
}

function alsoClean(x) {
  if (!x) return { error: "bad" };
  return { data: x };
}`;
		const matches = checkMixedErrorStrategy(code, "utils.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("mixed");
	});

	it("does NOT flag short files", () => {
		const code = "throw new Error('x');\nreturn { error: 'y' };";
		expect(checkMixedErrorStrategy(code, "tiny.ts")).toEqual([]);
	});
});

// ===========================================
// Taste Enforcement: Error Handling Quality
// ===========================================

describe("checkBareCatchBlock", () => {
	it("detects empty catch block on same line", () => {
		const code = "try { foo(); } catch (e) { }";
		expect(checkBareCatchBlock(code, "app.ts").length).toBeGreaterThan(0);
	});

	it("detects catch block with only a comment", () => {
		const code = "try { foo(); } catch (e) {\n  // ignore\n}";
		expect(checkBareCatchBlock(code, "app.ts").length).toBeGreaterThan(0);
	});

	it("does NOT flag catch with real handling", () => {
		const code = "try { foo(); } catch (e) {\n  console.error(e);\n}";
		expect(checkBareCatchBlock(code, "app.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "try { foo(); } catch (e) { }";
		expect(checkBareCatchBlock(code, "app.test.ts")).toEqual([]);
	});

	it("detects Python bare except/pass", () => {
		const code = "try:\n    foo()\nexcept Exception:\n    pass";
		expect(checkBareCatchBlock(code, "app.py").length).toBeGreaterThan(0);
	});

	it("does NOT flag Python except with handling", () => {
		const code = "try:\n    foo()\nexcept Exception as e:\n    logger.error(e)";
		expect(checkBareCatchBlock(code, "app.py")).toEqual([]);
	});
});

describe("checkCatchReturnNull", () => {
	it("detects return null in catch", () => {
		const code = "try {\n  return parse(x);\n} catch (e) {\n  return null;\n}";
		expect(checkCatchReturnNull(code, "utils.ts").length).toBeGreaterThan(0);
	});

	it("detects return undefined in catch", () => {
		const code = "try {\n  return parse(x);\n} catch (e) {\n  return undefined;\n}";
		expect(checkCatchReturnNull(code, "utils.ts").length).toBeGreaterThan(0);
	});

	it("does NOT flag return with error info", () => {
		const code = "try {\n  return parse(x);\n} catch (e) {\n  return { error: e.message };\n}";
		expect(checkCatchReturnNull(code, "utils.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "try { x(); } catch (e) { return null; }";
		expect(checkCatchReturnNull(code, "utils.test.ts")).toEqual([]);
	});
});

describe("checkThrowAsControlFlow", () => {
	it("detects throw for not-found condition", () => {
		const code = 'throw new Error("not found: user 123");';
		expect(checkThrowAsControlFlow(code, "api.ts").length).toBeGreaterThan(0);
	});

	it("detects throw for validation failure", () => {
		const code = 'throw new TypeError("invalid input: expected number");';
		expect(checkThrowAsControlFlow(code, "validate.ts").length).toBeGreaterThan(0);
	});

	it("does NOT flag throw for unexpected errors", () => {
		const code = 'throw new Error("Internal server error");';
		expect(checkThrowAsControlFlow(code, "server.ts")).toEqual([]);
	});

	it("does NOT flag throw in comments", () => {
		const code = '// throw new Error("not found");\nconsole.log("ok");';
		expect(checkThrowAsControlFlow(code, "app.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = 'throw new Error("not found");';
		expect(checkThrowAsControlFlow(code, "api.test.ts")).toEqual([]);
	});
});

describe("checkUntypedCatch", () => {
	it("detects catch without narrowing", () => {
		const code = "try { foo(); } catch (e) {\n  console.log(e);\n}";
		expect(checkUntypedCatch(code, "app.ts").length).toBeGreaterThan(0);
	});

	it("does NOT flag catch with instanceof", () => {
		const code = "try { foo(); } catch (e) {\n  if (e instanceof TypeError) { handle(e); }\n}";
		expect(checkUntypedCatch(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag catch with _tag check", () => {
		const code = "try { foo(); } catch (e) {\n  if (e._tag === 'NotFound') { return; }\n}";
		expect(checkUntypedCatch(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag catch with typeof narrowing", () => {
		const code = "try { foo(); } catch (e) {\n  if (typeof e === 'string') { return; }\n}";
		expect(checkUntypedCatch(code, "app.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "try { foo(); } catch (e) { console.log(e); }";
		expect(checkUntypedCatch(code, "app.test.ts")).toEqual([]);
	});
});

describe("checkErrorStringComparison", () => {
	it("detects err.message === string", () => {
		const code = 'if (err.message === "ENOENT") { handle(); }';
		expect(checkErrorStringComparison(code, "fs.ts").length).toBeGreaterThan(0);
	});

	it("detects err.message.includes(string)", () => {
		const code = 'if (err.message.includes("timeout")) { retry(); }';
		expect(checkErrorStringComparison(code, "net.ts").length).toBeGreaterThan(0);
	});

	it("does NOT flag err.code comparison", () => {
		const code = 'if (err.code === "ENOENT") { handle(); }';
		expect(checkErrorStringComparison(code, "fs.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = 'expect(err.message === "foo").toBe(true);';
		expect(checkErrorStringComparison(code, "fs.test.ts")).toEqual([]);
	});
});

describe("checkInconsistentErrorStrategy", () => {
	it("detects 3+ strategies in one file", () => {
		const lines = new Array(25).fill("const x = 1;");
		lines[5] = 'throw new Error("boom");';
		lines[10] = "return null;";
		lines[11] = "return null;";
		lines[20] = "return { error: 'fail' };";
		expect(checkInconsistentErrorStrategy(lines.join("\n"), "mixed.ts").length).toBeGreaterThan(
			0,
		);
	});

	it("does NOT flag single strategy", () => {
		const lines = new Array(25).fill("const x = 1;");
		lines[5] = 'throw new Error("a");';
		lines[10] = 'throw new Error("b");';
		expect(checkInconsistentErrorStrategy(lines.join("\n"), "clean.ts")).toEqual([]);
	});

	it("does NOT flag short files", () => {
		const code = 'throw new Error("x");\nreturn null;\nreturn { error: "y" };';
		expect(checkInconsistentErrorStrategy(code, "tiny.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const lines = new Array(25).fill("const x = 1;");
		lines[5] = 'throw new Error("boom");';
		lines[10] = "return null;";
		lines[11] = "return null;";
		lines[20] = "return { error: 'fail' };";
		expect(checkInconsistentErrorStrategy(lines.join("\n"), "mixed.test.ts")).toEqual([]);
	});
});
