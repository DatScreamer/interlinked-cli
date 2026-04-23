// Smoke tests for project-graph/parser-imports.ts.

import { describe, expect, it } from "vitest";
import { parseImports } from "./parser-imports.js";

describe("parser-imports (smoke)", () => {
	it("exports a function", () => {
		expect(typeof parseImports).toBe("function");
	});

	it("returns an empty array for files with no imports", () => {
		expect(parseImports("const x = 1", "/tmp/foo.ts")).toEqual([]);
	});

	it("extracts a named import with symbols", () => {
		const out = parseImports(`import { foo, bar } from "./baz.js"`, "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			fromFile: "/tmp/src.ts",
			specifier: "./baz.js",
			symbols: ["foo", "bar"],
		});
	});

	it("marks type-only imports", () => {
		const out = parseImports(`import type { Foo } from "./foo.js"`, "/tmp/src.ts");
		expect(out[0]?.isTypeOnly).toBe(true);
	});

	it("handles require() calls", () => {
		const out = parseImports(`const x = require("./x.js")`, "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.specifier).toBe("./x.js");
	});

	it("captures destructured symbols from an awaited dynamic import", () => {
		const out = parseImports(
			'const { telemetryShowCommand } = await import("./commands/telemetry.js");',
			"/tmp/src/index.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			fromFile: "/tmp/src/index.ts",
			specifier: "./commands/telemetry.js",
			symbols: ["telemetryShowCommand"],
			isTypeOnly: false,
		});
	});

	it("captures multiple destructured symbols from a dynamic import", () => {
		const out = parseImports(
			'const { checkpointListCommand, checkpointShowCommand } = await import("./commands/checkpoint.js");',
			"/tmp/src/index.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.symbols).toEqual(["checkpointListCommand", "checkpointShowCommand"]);
		expect(out[0]?.specifier).toBe("./commands/checkpoint.js");
	});

	it("captures renamed destructured symbols by their export name", () => {
		const out = parseImports(
			'const { originalName: localAlias } = await import("./mod.js");',
			"/tmp/src.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.symbols).toEqual(["originalName"]);
	});

	it("records namespace-style dynamic imports with empty symbols", () => {
		const out = parseImports(
			'const mod = await import("./commands/completions.js");',
			"/tmp/src/index.ts",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			specifier: "./commands/completions.js",
			symbols: [],
			isTypeOnly: false,
		});
	});

	it("records non-awaited dynamic namespace imports", () => {
		const out = parseImports('const mod = import("./mod.js");', "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.specifier).toBe("./mod.js");
		expect(out[0]?.symbols).toEqual([]);
	});

	it("accepts let and var destructures as well as const", () => {
		const outLet = parseImports('let { foo } = await import("./x.js");', "/tmp/src.ts");
		const outVar = parseImports('var { bar } = await import("./y.js");', "/tmp/src.ts");
		expect(outLet[0]?.symbols).toEqual(["foo"]);
		expect(outVar[0]?.symbols).toEqual(["bar"]);
	});

	it("still matches bare dynamic imports (no assignment)", () => {
		const out = parseImports('void import("./side-effect.js");', "/tmp/src.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.specifier).toBe("./side-effect.js");
		expect(out[0]?.symbols).toEqual([]);
	});

	it("does not match dynamic imports inside string literals", () => {
		const content = "const code = 'const { x } = await import(\"./nope.js\")';";
		const out = parseImports(content, "/tmp/src.ts");
		expect(out).toEqual([]);
	});

	it("parses static and dynamic imports side by side", () => {
		const content = [
			'import { staticSym } from "./static.js";',
			"export async function load() {",
			'  const { dynSym } = await import("./dyn.js");',
			"  return dynSym;",
			"}",
		].join("\n");
		const out = parseImports(content, "/tmp/src.ts");
		expect(out).toHaveLength(2);
		const byPath = Object.fromEntries(out.map((e) => [e.specifier, e]));
		expect(byPath["./static.js"]?.symbols).toEqual(["staticSym"]);
		expect(byPath["./dyn.js"]?.symbols).toEqual(["dynSym"]);
	});
});
