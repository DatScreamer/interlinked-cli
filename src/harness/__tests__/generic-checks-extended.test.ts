import { describe, expect, it } from "vitest";
import {
	checkAssertionFreeTests,
	checkAwaitInLoop,
	checkBareCatchBlock,
	checkBooleanTrap,
	checkBroadObjectTypes,
	checkCatchAndIgnore,
	checkCatchReturnNull,
	checkCommentedOutCode,
	checkConsoleDebug,
	checkDeadExports,
	checkDefaultExport,
	checkDeletionComments,
	checkDeprecationNotice,
	checkEmptyFunctionBody,
	checkErrorStringComparison,
	checkFlagArguments,
	checkFloatEquality,
	checkFloatingPromises,
	checkFunctionArity,
	checkGodFile,
	checkHardcodedCredentials,
	checkInconsistentErrorStrategy,
	checkInfiniteRecursion,
	checkLifecycleCleanup,
	checkMagicLiteralInConditional,
	checkMagicNumbers,
	checkMixedErrorStrategy,
	checkNarrativeNaming,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkNotImplementedStubs,
	checkOrphanedTestStub,
	checkParseIntRadix,
	checkPromiseRejectNonError,
	checkSilentCatch,
	checkSuppressionDensity,
	checkSyncIoInAsync,
	checkTestDescriptionQuality,
	checkThrowAsControlFlow,
	checkTrivialAssertions,
	checkUnreachableCode,
	checkUntypedCatch,
	checkUnvalidatedJsonBoundary,
} from "../generic-checks.js";

// ===========================================
// B1: checkUnreachableCode
// ===========================================

describe("checkUnreachableCode", () => {
	it("detects code after return statement", () => {
		const code = `function foo() {\n    return 42;\n    console.log("dead");\n}`;
		const matches = checkUnreachableCode(code, "test.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].line).toBe(3);
	});

	it("does NOT flag closing brace after return", () => {
		const code = "function foo() {\n    return 42;\n}";
		expect(checkUnreachableCode(code, "test.ts")).toEqual([]);
	});

	it("returns empty for non-JS files", () => {
		const code = `return 42\nprint("hello")`;
		expect(checkUnreachableCode(code, "test.py")).toEqual([]);
	});

	it("does NOT flag case/default after break", () => {
		const code = "switch(x) {\n    case 1:\n        break;\n    case 2:\n        break;\n}";
		expect(checkUnreachableCode(code, "test.ts")).toEqual([]);
	});

	it("detects code after throw statement", () => {
		const code = `function bar() {\n    throw new Error("fail");\n    cleanup();\n}`;
		const matches = checkUnreachableCode(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].line).toBe(3);
	});

	it("does NOT flag closing }; after return", () => {
		const code = "const fn = () => {\n    return 1;\n};";
		expect(checkUnreachableCode(code, "test.ts")).toEqual([]);
	});
});

// ===========================================
// B2: checkSilentCatch
// ===========================================

describe("checkSilentCatch", () => {
	it("detects empty catch block", () => {
		const code = "try { foo(); } catch (e) {}";
		const matches = checkSilentCatch(code, "test.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects catch without binding", () => {
		const code = "try { foo(); } catch {}";
		const matches = checkSilentCatch(code, "test.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag catch with content", () => {
		const code = "try { foo(); } catch (e) { console.error(e); }";
		expect(checkSilentCatch(code, "test.ts")).toEqual([]);
	});

	it("returns empty for non-JS files", () => {
		expect(checkSilentCatch("catch {}", "test.py")).toEqual([]);
	});

	it("does NOT flag catch-shaped text inside string literals", () => {
		const code = 'const fixture = "try { foo(); } catch {}";';
		expect(checkSilentCatch(code, "fixture.test.ts")).toEqual([]);
	});

	it("does NOT flag catch with logging on next line", () => {
		const code = "try {\n    foo();\n} catch (e) {\n    logger.error(e);\n}";
		expect(checkSilentCatch(code, "handler.ts")).toEqual([]);
	});
});

// ===========================================
// B3: checkAssertionFreeTests
// ===========================================

describe("checkAssertionFreeTests", () => {
	it("detects test without assertions", () => {
		const code = `it("should work", () => {\n    const x = 1;\n    const y = 2;\n});`;
		const matches = checkAssertionFreeTests(code, "foo.test.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag test with expect", () => {
		const code = `it("should work", () => {\n    expect(1).toBe(1);\n});`;
		expect(checkAssertionFreeTests(code, "foo.test.ts")).toEqual([]);
	});

	it("only runs on test files", () => {
		const code = `it("should work", () => {\n    const x = 1;\n});`;
		expect(checkAssertionFreeTests(code, "foo.ts")).toEqual([]);
	});

	it("does NOT flag test with assert call", () => {
		const code = `test("validates", () => {\n    assert(true);\n});`;
		expect(checkAssertionFreeTests(code, "util.test.ts")).toEqual([]);
	});

	it("does NOT flag test with .should. chain", () => {
		const code = `it("works", () => {\n    result.should.equal(42);\n});`;
		expect(checkAssertionFreeTests(code, "app.spec.js")).toEqual([]);
	});

	it("does NOT flag test when expect is on same line as braces in strings", () => {
		const code = `it("parses JSON", () => {\n    expect(tryParse('{"a":1}')).toEqual({ a: 1 });\n});`;
		expect(checkAssertionFreeTests(code, "parser.test.ts")).toEqual([]);
	});
});

// ===========================================
// B3b: checkTrivialAssertions
// ===========================================

describe("checkTrivialAssertions", () => {
	it("detects expect(true).toBe(true)", () => {
		const code = `it("works", () => {\n    expect(true).toBe(true);\n});`;
		const matches = checkTrivialAssertions(code, "foo.test.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("Tautological");
	});

	it("detects expect(1).toBe(1)", () => {
		const code = `it("works", () => {\n    expect(1).toBe(1);\n});`;
		const matches = checkTrivialAssertions(code, "foo.test.ts");
		expect(matches.length).toBe(1);
	});

	it("detects expect('a').toEqual('a')", () => {
		const code = `it("works", () => {\n    expect('hello').toEqual('hello');\n});`;
		const matches = checkTrivialAssertions(code, "foo.test.ts");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag expect(result).toBe(true)", () => {
		const code = `it("works", () => {\n    expect(result).toBe(true);\n});`;
		expect(checkTrivialAssertions(code, "foo.test.ts")).toEqual([]);
	});

	it("does NOT flag expect(1).toBe(2) — different values", () => {
		const code = `it("works", () => {\n    expect(1).toBe(2);\n});`;
		expect(checkTrivialAssertions(code, "foo.test.ts")).toEqual([]);
	});

	it("only runs on test files", () => {
		const code = "expect(true).toBe(true);";
		expect(checkTrivialAssertions(code, "util.ts")).toEqual([]);
	});

	it("detects assert(true)", () => {
		const code = `it("works", () => {\n    assert(true);\n});`;
		const matches = checkTrivialAssertions(code, "foo.test.ts");
		expect(matches.length).toBe(1);
	});
});

// ===========================================
// B3c: checkSuppressionDensity
// ===========================================

describe("checkSuppressionDensity", () => {
	it("flags file with high suppression density", () => {
		const lines = Array.from({ length: 50 }, (_, i) =>
			i % 10 === 0 ? "// @ts-ignore" : "const x = 1;",
		);
		const code = lines.join("\n");
		const matches = checkSuppressionDensity(code, "util.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("suppression density");
	});

	it("does NOT flag file with low suppression density", () => {
		const lines = Array.from({ length: 100 }, () => "const x = 1;");
		lines[50] = "// @ts-ignore";
		const code = lines.join("\n");
		expect(checkSuppressionDensity(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag test files", () => {
		const lines = Array.from({ length: 20 }, () => "// @ts-ignore");
		const code = lines.join("\n");
		expect(checkSuppressionDensity(code, "util.test.ts")).toEqual([]);
	});

	it("does NOT flag very small files", () => {
		const code = "// @ts-ignore\nconst x = 1;";
		expect(checkSuppressionDensity(code, "util.ts")).toEqual([]);
	});

	// FP refinement (139-repo audit, 2026-05): generator output
	// frequently emits high-density suppression headers — that's the
	// generator's design, not a quality smell. Flagging produces 66 FPs
	// in one Supermodel sdk/ file.

	it("does NOT flag generator-output files (OpenAPI Generator header)", () => {
		const generated = [
			"/* tslint:disable */",
			"/* eslint-disable */",
			"/**",
			" * NOTE: This class is auto generated by OpenAPI Generator",
			" */",
			...Array.from({ length: 30 }, () => "// @ts-ignore"),
		].join("\n");
		expect(checkSuppressionDensity(generated, "sdk/DefaultApi.ts")).toEqual([]);
	});

	it("does NOT flag protoc-generated files with dense suppressions", () => {
		const generated = [
			"// Code generated by protoc-gen-ts. DO NOT EDIT.",
			...Array.from({ length: 30 }, () => "// @ts-ignore"),
		].join("\n");
		expect(checkSuppressionDensity(generated, "proto/foo_pb.ts")).toEqual([]);
	});

	it("does NOT flag @generated relay files", () => {
		const generated = [
			"// @generated SignedSource<<abc123>>",
			...Array.from({ length: 30 }, () => "// eslint-disable-next-line"),
		].join("\n");
		expect(checkSuppressionDensity(generated, "src/Schema.ts")).toEqual([]);
	});

	// Positive cases — hand-written code with high density MUST still
	// fire (the entire point of the check is to catch this).

	it("STILL flags hand-written file with high suppression density", () => {
		const handwritten = [
			"// Application module — needs cleanup.",
			...Array.from({ length: 30 }, (_, i) =>
				i % 3 === 0 ? "// @ts-ignore" : "const x = 1;",
			),
		].join("\n");
		expect(checkSuppressionDensity(handwritten, "src/lib/util.ts").length).toBe(1);
	});

	it("STILL flags file mentioning 'generated' past line 20", () => {
		const handwritten = [
			...Array.from({ length: 30 }, (_, i) =>
				i % 3 === 0 ? "// eslint-disable-next-line" : "const x = 1;",
			),
			"// uses the auto-generated client elsewhere",
		].join("\n");
		expect(checkSuppressionDensity(handwritten, "src/lib/api.ts").length).toBe(1);
	});
});

// ===========================================
// B4: checkHardcodedCredentials
// ===========================================

describe("checkHardcodedCredentials", () => {
	it("detects hardcoded password", () => {
		const code = `const password = "supersecret123";`;
		const matches = checkHardcodedCredentials(code, "config.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects hardcoded api_key", () => {
		const code = `const apiKey = "sk-abc123def456";`;
		const matches = checkHardcodedCredentials(code, "config.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag in test files", () => {
		const code = `const password = "testpassword";`;
		expect(checkHardcodedCredentials(code, "config.test.ts")).toEqual([]);
	});

	it("does NOT flag env var assignment", () => {
		const code = "const password = process.env.DB_PASSWORD;";
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("detects hardcoded secret", () => {
		const code = `const secret = "my-super-secret-value";`;
		const matches = checkHardcodedCredentials(code, "auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag short values (< 4 chars)", () => {
		const code = `const password = "ab";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});
});

// ===========================================
// B5: checkParseIntRadix
// ===========================================

describe("checkParseIntRadix", () => {
	it("detects parseInt without radix", () => {
		const code = "const n = parseInt(value);";
		const matches = checkParseIntRadix(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag parseInt with radix", () => {
		const code = "const n = parseInt(value, 10);";
		expect(checkParseIntRadix(code, "util.ts")).toEqual([]);
	});

	it("returns empty for non-JS files", () => {
		expect(checkParseIntRadix("parseInt(x)", "util.py")).toEqual([]);
	});

	it("detects parseInt with variable but no radix", () => {
		const code = "const port = parseInt(process.env.PORT);";
		const matches = checkParseIntRadix(code, "server.ts");
		expect(matches.length).toBeGreaterThan(0);
	});
});

// ===========================================
// B6: checkFloatEquality
// ===========================================

describe("checkFloatEquality", () => {
	it("detects === with float literal", () => {
		const code = "if (x === 0.1) {}";
		const matches = checkFloatEquality(code, "math.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag integer comparisons", () => {
		const code = "if (x === 42) {}";
		expect(checkFloatEquality(code, "math.ts")).toEqual([]);
	});

	it("returns empty for non-JS files", () => {
		expect(checkFloatEquality("x === 0.1", "math.py")).toEqual([]);
	});

	it("detects !== with float literal", () => {
		const code = "if (result !== 3.14) { throw new Error(); }";
		const matches = checkFloatEquality(code, "calc.js");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects float on left side of comparison", () => {
		const code = "if (0.3 === ratio) {}";
		const matches = checkFloatEquality(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
	});
});

// ===========================================
// B7: checkInfiniteRecursion
// ===========================================

describe("checkInfiniteRecursion", () => {
	it("detects self-call without guard", () => {
		const code = "function recurse() {\n    recurse();\n}";
		const matches = checkInfiniteRecursion(code, "util.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag self-call with if guard", () => {
		const code = "function recurse(n) {\n    if (n <= 0) return;\n    recurse(n - 1);\n}";
		expect(checkInfiniteRecursion(code, "util.ts")).toEqual([]);
	});

	it("returns empty for non-JS files", () => {
		expect(checkInfiniteRecursion("def recurse(): recurse()", "util.py")).toEqual([]);
	});

	it("does NOT flag self-call with return guard", () => {
		const code = "function traverse(node) {\n    return node ? traverse(node.next) : null;\n}";
		expect(checkInfiniteRecursion(code, "tree.ts")).toEqual([]);
	});

	it("does NOT flag call at module scope after one-liner function", () => {
		const code = `async function processAsync(data) { return data; }\nprocessAsync("test");`;
		expect(checkInfiniteRecursion(code, "util.ts")).toEqual([]);
	});
});

// ===========================================
// B9: checkSyncIoInAsync
// ===========================================

describe("checkDefaultExport", () => {
	// --- True positives ---

	it("flags anonymous default function", () => {
		const code = "export default function () { return 1; }";
		expect(checkDefaultExport(code, "/tmp/foo.ts").length).toBe(1);
	});

	it("flags anonymous arrow default", () => {
		const code = "export default (x) => x + 1;";
		expect(checkDefaultExport(code, "/tmp/foo.ts").length).toBe(1);
	});

	it("flags anonymous object-literal default", () => {
		const code = "export default { a: 1, b: 2 };";
		expect(checkDefaultExport(code, "/tmp/foo.ts").length).toBe(1);
	});

	it("flags named default that does not match filename", () => {
		const code = "export default Widget;";
		expect(checkDefaultExport(code, "/tmp/foo.ts").length).toBe(1);
	});

	it("flags named function default whose name does not match filename", () => {
		const code = "export default function Widget() {}";
		expect(checkDefaultExport(code, "/tmp/foo.ts").length).toBe(1);
	});

	// --- False positives we must avoid ---

	it("does NOT flag named default matching filename", () => {
		const code = "export default function Foo() {}";
		expect(checkDefaultExport(code, "/tmp/foo.ts")).toEqual([]);
	});

	it("does NOT flag named class default matching filename (case-insensitive)", () => {
		const code = "export default class MyComponent {}";
		expect(checkDefaultExport(code, "/tmp/mycomponent.ts")).toEqual([]);
	});

	it("does NOT flag in vite.config.ts", () => {
		const code = "export default { plugins: [] };";
		expect(checkDefaultExport(code, "/tmp/vite.config.ts")).toEqual([]);
	});

	it("does NOT flag in next.config.ts", () => {
		const code = "export default () => ({});";
		expect(checkDefaultExport(code, "/tmp/next.config.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = "export default function () {}";
		expect(checkDefaultExport(code, "/tmp/foo.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-JS/TS files", () => {
		const code = "export default function () {}";
		expect(checkDefaultExport(code, "/tmp/foo.py")).toEqual([]);
	});

	it("caps matches at 10", () => {
		const many = Array(15).fill("export default function () {}").join("\n");
		expect(checkDefaultExport(many, "/tmp/foo.ts").length).toBe(10);
	});

	// --- Cloudflare Workers handler exemptions ---
	// The Workers runtime dispatches on the default export's `fetch` /
	// `email` / `queue` / `scheduled` / `tail` / `trace` methods, so the
	// "name must match filename" rule cannot apply.

	it("does NOT flag anonymous Worker handler with method shorthand", () => {
		const code = `
			export default {
				async fetch(request, env) { return env.ASSETS.fetch(request); },
			};
		`;
		expect(checkDefaultExport(code, "/tmp/index.ts")).toEqual([]);
	});

	it("does NOT flag anonymous Worker handler with property assignment", () => {
		const code = `
			export default {
				fetch: async (request, env) => new Response("ok"),
			};
		`;
		expect(checkDefaultExport(code, "/tmp/index.ts")).toEqual([]);
	});

	it("does NOT flag Worker handler annotated with satisfies ExportedHandler", () => {
		const code = `
			export default {
				async fetch(request, env) { return new Response("ok"); },
			} satisfies ExportedHandler<Env>;
		`;
		expect(checkDefaultExport(code, "/tmp/index.ts")).toEqual([]);
	});

	it("does NOT flag named Worker handler whose name doesn't match filename", () => {
		const code = `
			const handler = {
				async fetch(request, env) { return new Response("ok"); },
			} satisfies ExportedHandler<Env>;
			export default handler;
		`;
		expect(checkDefaultExport(code, "/tmp/index.ts")).toEqual([]);
	});

	it("does NOT flag scheduled-only Worker handler", () => {
		const code = `
			export default {
				async scheduled(controller, env, ctx) { /* cron */ },
			};
		`;
		expect(checkDefaultExport(code, "/tmp/cron.ts")).toEqual([]);
	});

	it("does NOT flag email Worker handler", () => {
		const code = `
			export default {
				async email(message, env, ctx) { /* email routing */ },
			};
		`;
		expect(checkDefaultExport(code, "/tmp/inbox.ts")).toEqual([]);
	});

	it("DOES still flag a non-Worker anonymous object default in the same project", () => {
		const code = "export default { a: 1, b: 2 };";
		expect(checkDefaultExport(code, "/tmp/index.ts").length).toBe(1);
	});
});

describe("checkLifecycleCleanup", () => {
	// --- True positives ---

	it("flags setInterval without clearInterval in dispose", () => {
		const code = [
			"class Worker {",
			"    start() {",
			"        setInterval(() => tick(), 1000);",
			"    }",
			"    dispose() {",
			"        this.done = true;",
			"    }",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "worker.ts").length).toBeGreaterThan(0);
	});

	it("flags addEventListener without removeEventListener in destroy", () => {
		const code = [
			"class View {",
			"    mount() {",
			'        window.addEventListener("resize", this.onResize);',
			"    }",
			"    destroy() {",
			"        this.dead = true;",
			"    }",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "view.ts").length).toBeGreaterThan(0);
	});

	// --- False positives we must avoid ---

	it("does NOT flag when cleanup is paired in dispose", () => {
		const code = [
			"class Worker {",
			"    start() {",
			"        this.handle = setInterval(() => tick(), 1000);",
			"    }",
			"    dispose() {",
			"        clearInterval(this.handle);",
			"    }",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "worker.ts")).toEqual([]);
	});

	it("does NOT flag class without a lifecycle method", () => {
		const code = [
			"class Plain {",
			"    run() {",
			"        setInterval(() => tick(), 1000);",
			"    }",
			"}",
		].join("\n");
		// We cannot claim every class must have a lifecycle method.
		expect(checkLifecycleCleanup(code, "plain.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = [
			"class Worker {",
			"    start() { setInterval(() => tick(), 1000); }",
			"    dispose() {}",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "worker.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-JS/TS files", () => {
		const code = "class Worker { start() { setInterval(f, 1000); } dispose() {} }";
		expect(checkLifecycleCleanup(code, "worker.py")).toEqual([]);
	});
});

describe("checkDeadExports", () => {
	// Unit tests here hit the real fs via getGitSourceFiles — we can only
	// assert that the function is well-behaved on edge inputs. Heavier coverage
	// comes from manual runs against fixture repos.

	it("returns empty for non-JS/TS files", () => {
		expect(checkDeadExports("export const x = 1;", "/tmp/file.py", "/tmp")).toEqual([]);
	});

	it("returns empty for .d.ts files", () => {
		expect(checkDeadExports("export const x = 1;", "/tmp/file.d.ts", "/tmp")).toEqual([]);
	});

	it("returns empty for test files", () => {
		expect(checkDeadExports("export const x = 1;", "/tmp/foo.test.ts", "/tmp")).toEqual([]);
	});

	it("returns empty for barrel files (index.ts)", () => {
		expect(checkDeadExports("export const x = 1;", "/tmp/index.ts", "/tmp")).toEqual([]);
	});

	it("returns empty when file has no exports", () => {
		expect(checkDeadExports("const x = 1;", "/tmp/foo.ts", "/tmp")).toEqual([]);
	});

	it("returns empty when file is outside project root", () => {
		// When the file isn't under cwd, relFromRoot starts with '..' and we bail.
		expect(checkDeadExports("export const x = 1;", "/other/root/foo.ts", "/tmp")).toEqual([]);
	});

	it("skips type-only exports", () => {
		const code = "export type Foo = { x: number };";
		// Even if nothing imports Foo, type-only exports often form public API.
		expect(checkDeadExports(code, "/tmp/foo.ts", "/tmp")).toEqual([]);
	});
});

describe("checkUnvalidatedJsonBoundary", () => {
	// --- True positives ---

	it("flags JSON.parse result followed by property access without schema", () => {
		const code = [
			"function read(raw: string) {",
			"    const data = JSON.parse(raw);",
			"    return data.userId;",
			"}",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "x.ts").length).toBe(1);
	});

	it("flags await res.json() result followed by property access", () => {
		const code = [
			"async function fetchUser(res: Response) {",
			"    const body = await res.json();",
			"    return body.name;",
			"}",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "x.ts").length).toBe(1);
	});

	// --- False positives we must avoid ---

	it("does NOT flag when result passes through a schema parser", () => {
		const code = [
			"function read(raw: string) {",
			"    const data = JSON.parse(raw);",
			"    const parsed = UserSchema.parse(data);",
			"    return parsed.userId;",
			"}",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag when safeParse is used", () => {
		const code = [
			"function read(raw: string) {",
			"    const data = JSON.parse(raw);",
			"    const result = Schema.safeParse(data);",
			"    return result;",
			"}",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag when value is just returned / passed on", () => {
		const code = [
			"function read(raw: string) {",
			"    const data = JSON.parse(raw);",
			"    return data;",
			"}",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag JSON.parse without assignment", () => {
		const code = "doSomething(JSON.parse(raw));";
		expect(checkUnvalidatedJsonBoundary(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = [
			"function read(raw: string) {",
			"    const data = JSON.parse(raw);",
			"    return data.userId;",
			"}",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "x.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-JS/TS files", () => {
		const code = "const data = JSON.parse(raw); data.x;";
		expect(checkUnvalidatedJsonBoundary(code, "x.py")).toEqual([]);
	});

	it("caps matches at 10", () => {
		const many = Array(15)
			.fill(0)
			.map((_, idx) => `const d${idx} = JSON.parse(raw);\nconsole.log(d${idx}.x);`)
			.join("\n");
		expect(checkUnvalidatedJsonBoundary(many, "x.ts").length).toBe(10);
	});
});

describe("checkPromiseRejectNonError", () => {
	// --- True positives ---

	it("flags Promise.reject with a string", () => {
		const code = 'function fail() { return Promise.reject("oh no"); }';
		expect(checkPromiseRejectNonError(code, "x.ts").length).toBe(1);
	});

	it("flags Promise.reject with a number", () => {
		const code = "function fail() { return Promise.reject(42); }";
		expect(checkPromiseRejectNonError(code, "x.ts").length).toBe(1);
	});

	it("flags Promise.reject(null) and Promise.reject(undefined) on separate lines", () => {
		const code = "Promise.reject(null);\nPromise.reject(undefined);";
		expect(checkPromiseRejectNonError(code, "x.ts").length).toBe(2);
	});

	// --- False positives we must avoid ---

	it("does NOT flag Promise.reject(new Error(...))", () => {
		const code = 'function fail() { return Promise.reject(new Error("boom")); }';
		expect(checkPromiseRejectNonError(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag Promise.reject(someErr) (variable)", () => {
		const code = "function fail(err: Error) { return Promise.reject(err); }";
		expect(checkPromiseRejectNonError(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag bare reject() inside a Promise executor", () => {
		const code = 'const p = new Promise((resolve, reject) => reject("x"));';
		// Intentional under-detection: without AST we can't tell whether
		// `reject` is the Promise-executor binding. Under-detect to avoid FP on
		// unrelated `reject` functions.
		expect(checkPromiseRejectNonError(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = 'Promise.reject("expected failure");';
		expect(checkPromiseRejectNonError(code, "x.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-JS/TS files", () => {
		const code = 'Promise.reject("x");';
		expect(checkPromiseRejectNonError(code, "x.py")).toEqual([]);
	});

	it("caps matches at 10", () => {
		const lines = Array(15).fill('Promise.reject("x");').join("\n");
		expect(checkPromiseRejectNonError(lines, "x.ts").length).toBe(10);
	});
});

describe("checkMagicLiteralInConditional", () => {
	// --- True positives ---

	it("flags `if (x === 42)` with magic number", () => {
		const code = "function check(x: number) {\n    if (x === 42) return true;\n}";
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	it('flags `if (s === "fulfilled")` with magic string', () => {
		const code = 'function check(s: string) {\n    if (s === "fulfilled") return;\n}';
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	it("flags `case <magic>:` in a switch", () => {
		const code = [
			"function check(n: number) {",
			"    switch (n) {",
			"        case 42: return true;",
			"    }",
			"}",
		].join("\n");
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	it("flags !== with magic literal", () => {
		const code = "function check(x: number) {\n    if (x !== 100) return;\n}";
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	// --- False positives we must avoid ---

	it("does NOT flag `=== 0` (common length check)", () => {
		const code = "if (xs.length === 0) return;";
		expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag `=== 1`", () => {
		const code = "if (count === 1) return;";
		expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag `=== null`", () => {
		const code = "if (x === null) return;";
		expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag `=== undefined`", () => {
		const code = "if (x === undefined) return;";
		expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
	});

	it('does NOT flag `=== "true"` / `=== "false"` (typeof-style)', () => {
		const code = 'if (v === "true" || v === "false") return;';
		expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
	});

	it('does NOT flag short strings like `=== "x"`', () => {
		const code = 'if (c === "x") return;';
		expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = "if (status === 42) return;";
		expect(checkMagicLiteralInConditional(code, "x.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-JS/TS files", () => {
		const code = "if (status === 42) return;";
		expect(checkMagicLiteralInConditional(code, "x.py")).toEqual([]);
	});

	it("caps matches at 10 per file", () => {
		const lines = Array(15).fill("if (x === 42) return;").join("\n");
		expect(checkMagicLiteralInConditional(lines, "x.ts").length).toBe(10);
	});

	// --- Self-describing case labels (enum-like tokens) ---

	it('does NOT flag `case "bash":` / `case "zsh":` / `case "fish":` (shell names)', () => {
		const code = [
			"switch (shell) {",
			'    case "bash": return bash();',
			'    case "zsh": return zsh();',
			'    case "fish": return fish();',
			"}",
		].join("\n");
		expect(checkMagicLiteralInConditional(code, "completions.ts")).toEqual([]);
	});

	it('does NOT flag `case "hook_decision":` (multi-word lowercase identifier)', () => {
		const code = [
			"switch (e.kind) {",
			'    case "hook_decision": return handle(e);',
			'    case "session_start": return init(e);',
			"}",
		].join("\n");
		expect(checkMagicLiteralInConditional(code, "telemetry.ts")).toEqual([]);
	});

	it("does NOT flag kebab-case enum-like case labels", () => {
		const code = [
			"switch (kind) {",
			'    case "pre-commit": return run();',
			'    case "post-merge": return done();',
			"}",
		].join("\n");
		expect(checkMagicLiteralInConditional(code, "hooks.ts")).toEqual([]);
	});

	it("does NOT flag HTTP method case labels (uppercase allowlist)", () => {
		const code = [
			"switch (method) {",
			'    case "GET": return read();',
			'    case "DELETE": return remove();',
			"}",
		].join("\n");
		expect(checkMagicLiteralInConditional(code, "router.ts")).toEqual([]);
	});

	it("STILL flags `case <magic-number>:` — heuristic applies only to strings", () => {
		const code = ["switch (status) {", "    case 42: return done();", "}"].join("\n");
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	it("STILL flags `if (status === 2)` — skip is case-label-only, not === comparisons", () => {
		const code = "if (status === 2) return;";
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	it("STILL flags non-enum-like case label strings (spaces, punctuation)", () => {
		const code = [
			"switch (msg) {",
			'    case "Order fulfilled successfully": return ok();',
			"}",
		].join("\n");
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});

	it('documents: `if (mode === "bash")` IS still flagged — fix is case-label-only', () => {
		// Intentional: the `===` path keeps its behavior. A future refinement
		// could broaden this, but the current task scope is case-label noise.
		const code = 'if (mode === "bash") return run();';
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
	});
});

describe("checkBroadObjectTypes", () => {
	// --- True positives ---

	it("flags Record<string, any>", () => {
		const code = "export type Props = Record<string, any>;";
		expect(checkBroadObjectTypes(code, "props.ts").length).toBe(1);
	});

	it("flags Record<string, unknown>", () => {
		const code = "function merge(x: Record<string, unknown>) {}";
		expect(checkBroadObjectTypes(code, "merge.ts").length).toBe(1);
	});

	it("flags { [k: string]: any } index signature", () => {
		const code = "export type Bag = { [k: string]: any };";
		expect(checkBroadObjectTypes(code, "bag.ts").length).toBe(1);
	});

	it("flags bare Function type annotation", () => {
		const code = "function call(cb: Function) { cb(); }";
		expect(checkBroadObjectTypes(code, "call.ts").length).toBe(1);
	});

	it("flags bare object type annotation", () => {
		const code = "function inspect(x: object) {}";
		expect(checkBroadObjectTypes(code, "inspect.ts").length).toBe(1);
	});

	it("flags `as Function` cast", () => {
		const code = "const f = x as Function;";
		expect(checkBroadObjectTypes(code, "cast.ts").length).toBe(1);
	});

	// --- False positives we must avoid ---

	it("does NOT flag Record<K, SpecificType>", () => {
		const code = "export type Users = Record<UserId, UserProfile>;";
		expect(checkBroadObjectTypes(code, "users.ts")).toEqual([]);
	});

	it("does NOT flag { [k: string]: SpecificType } index signatures", () => {
		const code = "export type Bag = { [k: string]: number };";
		expect(checkBroadObjectTypes(code, "bag.ts")).toEqual([]);
	});

	it("does NOT flag typed function signatures", () => {
		const code = "function call(cb: (x: number) => string) {}";
		expect(checkBroadObjectTypes(code, "call.ts")).toEqual([]);
	});

	it("does NOT flag the word `function`", () => {
		const code = "function inspect(x: number) {}";
		expect(checkBroadObjectTypes(code, "inspect.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = "export type Props = Record<string, any>;";
		expect(checkBroadObjectTypes(code, "props.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-TS files", () => {
		const code = "export type Props = Record<string, any>;";
		expect(checkBroadObjectTypes(code, "props.js")).toEqual([]);
	});

	it("caps matches at 10 per file", () => {
		const lines = Array(15).fill("type T = Record<string, any>;").join("\n");
		expect(checkBroadObjectTypes(lines, "bulk.ts").length).toBe(10);
	});
});

describe("checkFloatingPromises", () => {
	// --- True positives ---

	it("detects bare call to in-file async function", () => {
		const code = "async function load() { return 1; }\n\nload();";
		const matches = checkFloatingPromises(code, "app.ts");
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(3);
	});

	it("detects bare call to async arrow assignment", () => {
		const code = "const save = async () => { return 1; };\n\nsave();";
		expect(checkFloatingPromises(code, "app.ts").length).toBe(1);
	});

	it("detects bare call to async class method via this.", () => {
		const code = [
			"class Loader {",
			"    async fetchData() { return 1; }",
			"    start() {",
			"        this.fetchData();",
			"    }",
			"}",
		].join("\n");
		expect(checkFloatingPromises(code, "loader.ts").length).toBe(1);
	});

	it("detects bare fetch() at statement position", () => {
		const code = `function ping() {\n    fetch("https://example.com");\n}`;
		expect(checkFloatingPromises(code, "ping.ts").length).toBe(1);
	});

	it("detects chain with .then but no .catch", () => {
		const code = "async function load() { return 1; }\n\nload().then(x => x);";
		expect(checkFloatingPromises(code, "app.ts").length).toBe(1);
	});

	// --- False positives we must avoid ---

	it("does NOT flag awaited call", () => {
		const code = "async function load() { return 1; }\nasync function run() { await load(); }";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag returned call", () => {
		const code = "async function load() { return 1; }\nasync function run() { return load(); }";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag void-prefixed call", () => {
		const code = "async function load() { return 1; }\n\nvoid load();";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag assigned call", () => {
		const code = "async function load() { return 1; }\n\nconst p = load();";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag chain ending in .catch()", () => {
		const code =
			"async function load() { return 1; }\n\nload().catch(err => console.error(err));";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag chain ending in .finally()", () => {
		const code = "async function load() { return 1; }\n\nload().finally(() => cleanup());";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag unknown third-party calls (no type info)", () => {
		const code = `import { unknownFn } from "some-lib";\n\nunknownFn();`;
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag calls inside Promise.all argument list", () => {
		const code = [
			"async function a() { return 1; }",
			"async function b() { return 2; }",
			"async function run() {",
			"    await Promise.all([",
			"        a(),",
			"        b(),",
			"    ]);",
			"}",
		].join("\n");
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag multi-line chains where .catch is later", () => {
		const code = [
			"async function load() { return 1; }",
			"",
			"load()",
			"    .then(x => x)",
			"    .catch(err => console.error(err));",
		].join("\n");
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("does NOT flag in test files", () => {
		const code = "async function load() { return 1; }\n\nload();";
		expect(checkFloatingPromises(code, "app.test.ts")).toEqual([]);
	});

	it("does NOT flag in non-JS/TS files", () => {
		const code = "async function load() { return 1; }\n\nload();";
		expect(checkFloatingPromises(code, "app.py")).toEqual([]);
	});

	it("does NOT flag bare sync function call", () => {
		const code = "function load() { return 1; }\n\nload();";
		expect(checkFloatingPromises(code, "app.ts")).toEqual([]);
	});

	it("caps matches at 10 per file", () => {
		const calls = Array(15).fill("load();").join("\n");
		const code = `async function load() { return 1; }\n\n${calls}`;
		expect(checkFloatingPromises(code, "app.ts").length).toBe(10);
	});
});

describe("checkSyncIoInAsync", () => {
	it("detects readFileSync in async function", () => {
		const code = `async function load() {\n    const data = readFileSync("file.txt");\n}`;
		const matches = checkSyncIoInAsync(code, "loader.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag readFileSync in sync function", () => {
		const code = `function load() {\n    const data = readFileSync("file.txt");\n}`;
		expect(checkSyncIoInAsync(code, "loader.ts")).toEqual([]);
	});

	it("returns empty for non-JS files", () => {
		expect(checkSyncIoInAsync("readFileSync()", "loader.py")).toEqual([]);
	});

	it("detects writeFileSync in async arrow function", () => {
		const code = `const save = async (data) => {\n    writeFileSync("out.txt", data);\n};`;
		const matches = checkSyncIoInAsync(code, "writer.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("detects multiple sync calls in async function", () => {
		const code = `async function setup() {\n    mkdirSync("tmp");\n    writeFileSync("tmp/file", "data");\n}`;
		const matches = checkSyncIoInAsync(code, "setup.js");
		expect(matches.length).toBe(2);
	});
});

// ===========================================
// FP Reduction: checkHardcodedCredentials
// ===========================================

describe("checkHardcodedCredentials — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag placeholder value 'changeme'", () => {
		const code = `const password = "changeme";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag 'your-api-key-here' placeholder", () => {
		const code = `const apiKey = "your-api-key-here";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag 'example-secret' prefix", () => {
		const code = `const secret = "example-secret-value";`;
		expect(checkHardcodedCredentials(code, "auth.ts")).toEqual([]);
	});

	it("does NOT flag 'test_key_for_demo' prefix", () => {
		const code = `const API_KEY = "test_key_for_demo";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag Zod schema annotation", () => {
		const code = "password: z.string().min(8)";
		expect(checkHardcodedCredentials(code, "schema.ts")).toEqual([]);
	});

	it("does NOT flag variable with Pattern suffix", () => {
		const code = `const passwordPattern = "^[A-Za-z0-9]{8,}$";`;
		expect(checkHardcodedCredentials(code, "validation.ts")).toEqual([]);
	});

	it("does NOT flag variable with Validator suffix", () => {
		const code = `const passwordValidator = "must-contain-special";`;
		expect(checkHardcodedCredentials(code, "validation.ts")).toEqual([]);
	});

	it("does NOT flag variable with Name suffix", () => {
		const code = `const secretName = "my-secret-vault-key";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag variable with Schema suffix", () => {
		const code = `const apiKeySchema = "string-uuid-format";`;
		expect(checkHardcodedCredentials(code, "types.ts")).toEqual([]);
	});

	it("does NOT flag 'mock' prefix values", () => {
		const code = `const password = "mock-password-value";`;
		expect(checkHardcodedCredentials(code, "setup.ts")).toEqual([]);
	});

	it("does NOT flag 'dummy' prefix values", () => {
		const code = `const secret = "dummy-secret-for-dev";`;
		expect(checkHardcodedCredentials(code, "dev.ts")).toEqual([]);
	});

	it("does NOT flag exact value 'disabled'", () => {
		const code = `const API_KEY = "disabled";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag exact value 'redacted'", () => {
		const code = `const secret = "redacted";`;
		expect(checkHardcodedCredentials(code, "config.ts")).toEqual([]);
	});

	it("does NOT flag variable with Header suffix", () => {
		const code = `const authTokenHeader = "X-Auth-Token-Value";`;
		expect(checkHardcodedCredentials(code, "http.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects real-looking password", () => {
		const code = `const password = "supersecret123";`;
		expect(checkHardcodedCredentials(code, "config.ts").length).toBeGreaterThan(0);
	});

	it("still detects Stripe-style API key", () => {
		const code = `const apiKey = "sk-abc123def456";`;
		expect(checkHardcodedCredentials(code, "payment.ts").length).toBeGreaterThan(0);
	});

	it("still detects generic secret value", () => {
		const code = `const secret = "my-super-secret-value";`;
		expect(checkHardcodedCredentials(code, "auth.ts").length).toBeGreaterThan(0);
	});

	it("still detects hex string secret", () => {
		// Reason: test fixture — a synthetic hex string used to exercise
		// the hardcoded-credentials detector.
		// nosemgrep: generic.secrets.security.detected-generic-secret.detected-generic-secret
		const code = `API_SECRET = "a8f2e9b1c3d4567890abcdef12345678"`;
		expect(checkHardcodedCredentials(code, "config.ts").length).toBeGreaterThan(0);
	});

	it("still detects access_token with real value", () => {
		const code = `const access_token = "ghp_realtoken1234567890abcdef";`;
		expect(checkHardcodedCredentials(code, "github.ts").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkFloatEquality
// ===========================================

describe("checkFloatEquality — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag === 0.0 (exact zero)", () => {
		const code = "if (x === 0.0) {}";
		expect(checkFloatEquality(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag === 0.5 (binary-representable)", () => {
		const code = "if (opacity === 0.5) {}";
		expect(checkFloatEquality(code, "style.ts")).toEqual([]);
	});

	it("does NOT flag !== 1.0 (binary-representable)", () => {
		const code = "if (scale !== 1.0) {}";
		expect(checkFloatEquality(code, "transform.ts")).toEqual([]);
	});

	it("does NOT flag === 0.25 (binary-representable)", () => {
		const code = "if (factor === 0.25) {}";
		expect(checkFloatEquality(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag === 2.0 (integer-valued float)", () => {
		const code = "if (x === 2.0) {}";
		expect(checkFloatEquality(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag === 0.75 (binary-representable)", () => {
		const code = "if (progress === 0.75) {}";
		expect(checkFloatEquality(code, "ui.ts")).toEqual([]);
	});

	it("does NOT flag === 0.125 (binary-representable)", () => {
		const code = "if (step === 0.125) {}";
		expect(checkFloatEquality(code, "grid.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects === 0.1 (NOT binary-representable)", () => {
		const code = "if (x === 0.1) {}";
		expect(checkFloatEquality(code, "math.ts").length).toBeGreaterThan(0);
	});

	it("still detects !== 3.14 (NOT binary-representable)", () => {
		const code = "if (result !== 3.14) { throw new Error(); }";
		expect(checkFloatEquality(code, "calc.js").length).toBeGreaterThan(0);
	});

	it("still detects 0.3 === sum (NOT binary-representable)", () => {
		const code = "if (0.3 === sum) {}";
		expect(checkFloatEquality(code, "math.ts").length).toBeGreaterThan(0);
	});

	it("still detects === 9.99 (NOT binary-representable)", () => {
		const code = "if (price === 9.99) {}";
		expect(checkFloatEquality(code, "billing.ts").length).toBeGreaterThan(0);
	});

	it("still detects === 0.7 (NOT binary-representable)", () => {
		const code = "if (ratio === 0.7) {}";
		expect(checkFloatEquality(code, "util.ts").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkInfiniteRecursion
// ===========================================

describe("checkInfiniteRecursion — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag function name in a comment", () => {
		const code = "function helper() {\n  // Call helper() to reset\n  return 42;\n}";
		expect(checkInfiniteRecursion(code, "util.ts")).toEqual([]);
	});

	it("does NOT flag function name in a string", () => {
		const code =
			'function render() {\n  console.log("call render() for update");\n  return null;\n}';
		expect(checkInfiniteRecursion(code, "ui.ts")).toEqual([]);
	});

	it("does NOT flag guard via logical AND operator", () => {
		const code = "function walk(n) {\n  n > 0 && walk(n - 1);\n}";
		expect(checkInfiniteRecursion(code, "traverse.ts")).toEqual([]);
	});

	it("does NOT flag guard via logical OR operator", () => {
		const code = "function proc(arr) {\n  arr.length === 0 || proc(arr.slice(1));\n}";
		expect(checkInfiniteRecursion(code, "list.ts")).toEqual([]);
	});

	it("does NOT flag guard via comparison operator", () => {
		const code = "function count(n) {\n  if (n <= 0) return 0;\n  return 1 + count(n - 1);\n}";
		expect(checkInfiniteRecursion(code, "math.ts")).toEqual([]);
	});

	it("does NOT flag guard via .length check", () => {
		const code =
			"function flatten(arr) {\n  if (arr.length === 0) return [];\n  return [arr[0], ...flatten(arr.slice(1))];\n}";
		expect(checkInfiniteRecursion(code, "array.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects self-call without any guard", () => {
		const code = "function recurse() {\n    recurse();\n}";
		expect(checkInfiniteRecursion(code, "util.ts").length).toBeGreaterThan(0);
	});

	it("still detects self-call with only logging (no guard)", () => {
		const code = "function loop(x) {\n    console.log(x);\n    loop(x);\n}";
		expect(checkInfiniteRecursion(code, "debug.ts").length).toBeGreaterThan(0);
	});

	it("still detects arrow function self-call without guard", () => {
		const code = "const tick = () => {\n    doWork();\n    tick();\n}";
		expect(checkInfiniteRecursion(code, "timer.ts").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkConsoleDebug (Go/C)
// ===========================================

describe("checkConsoleDebug — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag Go file with 1 fmt.Println (intentional output)", () => {
		const code = `package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Server started on :8080")\n}`;
		expect(checkConsoleDebug(code, "src/app.go")).toEqual([]);
	});

	it("does NOT flag Go file with 2 fmt.Println (intentional output)", () => {
		const code = `package main\n\nimport "fmt"\n\nfunc run() {\n    fmt.Println("Starting...")\n    fmt.Println("Ready")\n}`;
		expect(checkConsoleDebug(code, "src/app.go")).toEqual([]);
	});

	it("does NOT flag C file in examples directory", () => {
		const code = `#include <stdio.h>\nvoid demo() {\n    printf("result: %d\\n", 42);\n}`;
		expect(checkConsoleDebug(code, "examples/demo.c")).toEqual([]);
	});

	it("does NOT flag C file with 'example' in name", () => {
		const code = `#include <stdio.h>\nvoid show() {\n    printf("output: %s\\n", msg);\n}`;
		expect(checkConsoleDebug(code, "src/example_usage.c")).toEqual([]);
	});

	it("does NOT flag C file in samples directory", () => {
		const code = `void sample() {\n    printf("value = %d\\n", x);\n}`;
		expect(checkConsoleDebug(code, "samples/test.c")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects Go file with 4+ fmt.Println (debug sprawl)", () => {
		const code = `package main\nimport "fmt"\nfunc debug() {\n    fmt.Println("a")\n    fmt.Println("b")\n    fmt.Println("c")\n    fmt.Println("d")\n}`;
		expect(checkConsoleDebug(code, "src/handler.go").length).toBeGreaterThan(0);
	});

	it("still detects JS console.log", () => {
		const code = `function process() {\n    console.log("debug value:", x);\n}`;
		expect(checkConsoleDebug(code, "src/utils.ts").length).toBeGreaterThan(0);
	});

	it("still detects Rust dbg! macro", () => {
		const code = "fn process(x: i32) {\n    dbg!(x);\n}";
		expect(checkConsoleDebug(code, "src/lib.rs").length).toBeGreaterThan(0);
	});

	it("still detects C printf in regular src file", () => {
		const code = `void parse() {\n    printf("x=%d\\n", x);\n}`;
		expect(checkConsoleDebug(code, "src/parser.c").length).toBeGreaterThan(0);
	});
});

// ===========================================
// FP Reduction: checkAwaitInLoop
// ===========================================

describe("checkAwaitInLoop — false positive reduction", () => {
	// --- False positives (should NOT fire) ---

	it("does NOT flag await inside nested async arrow in loop (promise collection)", () => {
		const code = `for (const id of ids) {
    promises.push(async () => {
        await api.get(id);
    });
}`;
		expect(checkAwaitInLoop(code, "fetch.ts")).toEqual([]);
	});

	it("does NOT flag await inside nested async callback in loop", () => {
		const code = `for (const item of items) {
    queue.add(async () => {
        const result = await process(item);
        return result;
    });
}`;
		expect(checkAwaitInLoop(code, "queue.ts")).toEqual([]);
	});

	it("does NOT flag await inside nested async function in loop", () => {
		const code = `for (const task of tasks) {
    const handler = async function() {
        await task.execute();
    };
    handlers.push(handler());
}`;
		expect(checkAwaitInLoop(code, "runner.ts")).toEqual([]);
	});

	// --- True positive regressions (MUST still fire) ---

	it("still detects direct await in for-of loop", () => {
		const code = "for (const x of xs) {\n    await fetch(x);\n}";
		expect(checkAwaitInLoop(code, "api.ts").length).toBeGreaterThan(0);
	});

	it("still detects direct await in for loop", () => {
		const code =
			"for (let i = 0; i < items.length; i++) {\n    const r = await db.query(items[i]);\n}";
		expect(checkAwaitInLoop(code, "data.ts").length).toBeGreaterThan(0);
	});

	it("still detects direct await in while loop", () => {
		const code =
			"while (hasMore) {\n    const page = await fetchPage(cursor);\n    hasMore = page.next;\n}";
		expect(checkAwaitInLoop(code, "paginate.ts").length).toBeGreaterThan(0);
	});
});

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
