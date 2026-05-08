// Split from generic-checks-extended.test.ts — pattern-oriented checks:
// checkUnvalidatedJsonBoundary, checkPromiseRejectNonError,
// checkMagicLiteralInConditional, checkBroadObjectTypes,
// checkFloatingPromises, checkSyncIoInAsync.

import { describe, expect, it } from "vitest";
import {
	checkBroadObjectTypes,
	checkFloatingPromises,
	checkMagicLiteralInConditional,
	checkPromiseRejectNonError,
	checkSyncIoInAsync,
	checkUnvalidatedJsonBoundary,
} from "../generic-checks.js";

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

	it('does NOT flag `typeof x === "string"` (canonical TS narrowing)', () => {
		// The typeof operator returns a fixed 8-string set
		// (string/number/bigint/boolean/symbol/undefined/object/function);
		// extracting any of them to a constant is pure noise. Each is the
		// idiomatic narrowing form.
		const cases = [
			'if (typeof v === "string") return;',
			'if (typeof v !== "string") return;',
			'if (typeof v === "number") return;',
			'if (typeof v === "boolean") return;',
			'if (typeof v === "undefined") return;',
			'if (typeof v === "object") return;',
			'if (typeof v === "function") return;',
			'if (typeof v === "bigint") return;',
			'if (typeof v === "symbol") return;',
		];
		for (const code of cases) {
			expect(checkMagicLiteralInConditional(code, "x.ts")).toEqual([]);
		}
	});

	it('still flags `=== "string"` when there is no `typeof`', () => {
		// The exemption is gated on the line containing `typeof`. A bare
		// string compare like `mode === "string"` is exactly the kind of
		// stringly-typed conditional the check is meant to catch.
		const code = 'if (mode === "string") return;';
		expect(checkMagicLiteralInConditional(code, "x.ts").length).toBe(1);
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
