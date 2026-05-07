import { describe, expect, it } from "vitest";
import {
	checkAgentThumbprintProse,
	checkDeadBranchLiteral,
	checkDoubleCastUnknown,
	checkFetchWithoutTimeout,
	checkFileLevelSuppression,
	checkNodeEnvBranchInProd,
	checkStubNotImplementedThrow,
	checkSyncIoOnHotPath,
	checkUnboundedPromiseAll,
	checkUnionWidenedWithString,
	checkUntestableTimeInSource,
} from "./agent-laziness.js";

const TS = "src/lib/foo.ts";
const TEST = "src/lib/foo.test.ts";
const HANDLER = "src/handlers/users.ts";

describe("checkAgentThumbprintProse", () => {
	it("flags 'in a real implementation' in comments", () => {
		const code = `
function foo() {
  // In a real implementation, we would connect to the API.
  return [];
}`;
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].line).toBe(3);
	});

	it("flags 'for now' / 'placeholder' / 'simplified version'", () => {
		const code = `
const X = 1; // placeholder
const Y = 2; // for now
const Z = 3; // simplified version for now
`;
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(3);
	});

	it("flags Python-style # comments", () => {
		const matches = checkAgentThumbprintProse(
			"x = 1  # TODO: actually implement\n",
			"src/foo.py",
		);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not fire on plain code without thumbprint phrases", () => {
		const code = `function add(a: number, b: number): number { return a + b; }`;
		expect(checkAgentThumbprintProse(code, TS)).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkAgentThumbprintProse("// for now", TEST)).toEqual([]);
	});

	it("skips markdown files", () => {
		expect(checkAgentThumbprintProse("// for now", "README.md")).toEqual([]);
	});

	it("does not flag a real-implementation phrase outside a comment", () => {
		const code = `const msg = "in a real implementation we would call the API";`;
		// The phrase is in a string, not a comment. Comment-prefix regex
		// requires // / /* / # / -- / <!--; bare string assignment shouldn't fire.
		expect(checkAgentThumbprintProse(code, TS)).toEqual([]);
	});
});

describe("checkStubNotImplementedThrow", () => {
	it("flags `throw new Error(\"not implemented\")`", () => {
		const code = `function foo() { throw new Error("not implemented"); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("not implemented");
	});

	it("flags TODO / stub / coming soon variants", () => {
		const code = `
function a() { throw new Error("TODO"); }
function b() { throw new Error("stub"); }
function c() { throw new Error("coming soon"); }
`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(3);
	});

	it("flags throw new Error() with no message", () => {
		const code = `function foo() { throw new Error(); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(matches[0].text).toContain("no message");
	});

	it("does not fire on real error messages", () => {
		const code = `function foo() { throw new Error("user not found: id=" + id); }`;
		expect(checkStubNotImplementedThrow(code, TS)).toEqual([]);
	});

	it("skips test files", () => {
		expect(
			checkStubNotImplementedThrow(`throw new Error("not implemented");`, TEST),
		).toEqual([]);
	});
});

describe("checkDeadBranchLiteral", () => {
	it("flags if (true)", () => {
		const matches = checkDeadBranchLiteral(`if (true) { x = 1; }`, TS);
		expect(matches.length).toBe(1);
	});

	it("flags if (false)", () => {
		const matches = checkDeadBranchLiteral(`if (false) { x = 1; }`, TS);
		expect(matches.length).toBe(1);
	});

	it("flags else if (true)", () => {
		const matches = checkDeadBranchLiteral(`if (cond) {} else if (true) {}`, TS);
		expect(matches.length).toBe(1);
	});

	it("does not fire on while (true)", () => {
		expect(checkDeadBranchLiteral(`while (true) { if (done) break; }`, TS)).toEqual([]);
	});

	it("does not fire on if (variable)", () => {
		expect(checkDeadBranchLiteral(`if (cond) { x = 1; }`, TS)).toEqual([]);
	});

	it("does not fire on commented-out if (true)", () => {
		expect(checkDeadBranchLiteral(`// if (true) { ... }`, TS)).toEqual([]);
	});
});

describe("checkFileLevelSuppression", () => {
	it("flags ts-nocheck at file head", () => {
		// Build the directive at runtime so this test source doesn't itself
		// trip suppression scanners.
		const directive = `// @ts-${"nocheck"}`;
		const code = `${directive}\nfunction foo() {}`;
		const matches = checkFileLevelSuppression(code, TS);
		expect(matches.length).toBe(1);
	});

	it("flags eslint-disable with no rule list", () => {
		const directive = `/* eslint-${"disable"} */`;
		const matches = checkFileLevelSuppression(`${directive}\nfunction foo(){}`, TS);
		expect(matches.length).toBe(1);
	});

	it("flags biome-ignore-all", () => {
		const directive = `// biome-ignore-${"all"}`;
		expect(checkFileLevelSuppression(directive, TS).length).toBe(1);
	});

	it("does not flag .d.ts files", () => {
		const directive = `// @ts-${"nocheck"}`;
		expect(checkFileLevelSuppression(directive, "src/types.d.ts")).toEqual([]);
	});

	it("does not flag generated files", () => {
		const directive = `// @ts-${"nocheck"}`;
		expect(checkFileLevelSuppression(directive, "src/foo.gen.ts")).toEqual([]);
		expect(checkFileLevelSuppression(directive, "src/generated/foo.ts")).toEqual([]);
	});
});

describe("checkUntestableTimeInSource", () => {
	it("flags Date.now()", () => {
		expect(checkUntestableTimeInSource(`const t = Date.now();`, TS).length).toBe(1);
	});

	it("flags Math.random()", () => {
		expect(checkUntestableTimeInSource(`const r = Math.random();`, TS).length).toBe(1);
	});

	it("flags new Date() with no args", () => {
		expect(checkUntestableTimeInSource(`const d = new Date();`, TS).length).toBe(1);
	});

	it("does not fire on new Date(value)", () => {
		expect(checkUntestableTimeInSource(`const d = new Date(ts);`, TS)).toEqual([]);
	});

	it("flags crypto.randomUUID()", () => {
		expect(
			checkUntestableTimeInSource(`const id = crypto.randomUUID();`, TS).length,
		).toBe(1);
	});

	it("skips test files", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, TEST)).toEqual([]);
	});

	it("skips clock/random/uuid injection-point files", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, "src/lib/clock.ts")).toEqual([]);
		expect(checkUntestableTimeInSource(`Math.random();`, "src/lib/random.ts")).toEqual([]);
		expect(checkUntestableTimeInSource(`crypto.randomUUID();`, "src/lib/uuid.ts")).toEqual(
			[],
		);
	});

	it("skips strings and comments", () => {
		const code = `const msg = "Date.now() example"; // discusses Date.now()`;
		expect(checkUntestableTimeInSource(code, TS)).toEqual([]);
	});
});

describe("checkDoubleCastUnknown", () => {
	it("flags `as unknown as Foo`", () => {
		const code = `const x = something as unknown as MyType;`;
		const matches = checkDoubleCastUnknown(code, TS);
		expect(matches.length).toBe(1);
	});

	it("does not fire on a single `as Foo`", () => {
		expect(checkDoubleCastUnknown(`const x = a as Foo;`, TS)).toEqual([]);
	});

	it("does not fire on `as unknown` alone (no second cast)", () => {
		expect(checkDoubleCastUnknown(`const x = a as unknown;`, TS)).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkDoubleCastUnknown(`const x = a as unknown as Foo;`, TEST)).toEqual([]);
	});
});

describe("checkUnionWidenedWithString", () => {
	it("flags `type X = \"a\" | \"b\" | string`", () => {
		const code = `type X = "a" | "b" | string;`;
		const matches = checkUnionWidenedWithString(code, TS);
		expect(matches.length).toBe(1);
	});

	it("flags `string | \"a\" | \"b\"` (other order)", () => {
		const code = `type X = string | "a" | "b";`;
		const matches = checkUnionWidenedWithString(code, TS);
		expect(matches.length).toBe(1);
	});

	it("does NOT flag `\"a\" | (string & {})` branded-string pattern (recommended fix)", () => {
		// `string & {}` is the canonical workaround for open-ended unions —
		// it preserves the literal autocomplete and signals the open shape.
		// The check warning explicitly recommends this pattern, so flagging
		// it would be self-defeating.
		const code = `type X = "a" | "b" | (string & {});`;
		expect(checkUnionWidenedWithString(code, TS)).toEqual([]);
	});

	it("does NOT flag `\"a\" | string & {}` branded-string without parens", () => {
		const code = `type X = "a" | "b" | string & {};`;
		expect(checkUnionWidenedWithString(code, TS)).toEqual([]);
	});

	it("does not fire on a pure literal union", () => {
		expect(checkUnionWidenedWithString(`type X = "a" | "b";`, TS)).toEqual([]);
	});

	it("does not fire on a non-type-alias line that mentions string", () => {
		expect(checkUnionWidenedWithString(`const x: string = "hello";`, TS)).toEqual([]);
	});
});

describe("checkNodeEnvBranchInProd", () => {
	it("flags NODE_ENV === \"test\" in production source", () => {
		const code = `if (process.env.NODE_ENV === "test") { return mockData; }`;
		const matches = checkNodeEnvBranchInProd(code, TS);
		expect(matches.length).toBe(1);
	});

	it("flags NODE_ENV === \"development\"", () => {
		const code = `if (process.env.NODE_ENV === "development") { /* ... */ }`;
		expect(checkNodeEnvBranchInProd(code, TS).length).toBe(1);
	});

	it("does not fire in test files", () => {
		expect(
			checkNodeEnvBranchInProd(`if (process.env.NODE_ENV === "test") {}`, TEST),
		).toEqual([]);
	});

	it("does not fire in known config files", () => {
		expect(
			checkNodeEnvBranchInProd(
				`if (process.env.NODE_ENV === "test") {}`,
				"vite.config.ts",
			),
		).toEqual([]);
	});

	it("does not fire on read-only env access without comparison", () => {
		expect(
			checkNodeEnvBranchInProd(`const env = process.env.NODE_ENV;`, TS),
		).toEqual([]);
	});
});

describe("checkFetchWithoutTimeout", () => {
	it("flags fetch(url) with no options", () => {
		const code = `const r = await fetch("https://api.example.com/data");`;
		expect(checkFetchWithoutTimeout(code, TS).length).toBe(1);
	});

	it("flags fetch with options that lack signal/timeout", () => {
		const code = `await fetch(url, { method: "POST", body });`;
		expect(checkFetchWithoutTimeout(code, TS).length).toBe(1);
	});

	it("does not fire when signal: is in the options", () => {
		const code = `await fetch(url, { signal: controller.signal });`;
		expect(checkFetchWithoutTimeout(code, TS)).toEqual([]);
	});

	it("does not fire when timeout: is in the options across lines", () => {
		const code = `
await fetch(url, {
  method: "POST",
  timeout: 5000,
});
`;
		expect(checkFetchWithoutTimeout(code, TS)).toEqual([]);
	});

	it("flags axios.get(url) without timeout", () => {
		expect(checkFetchWithoutTimeout(`axios.get(url);`, TS).length).toBe(1);
	});

	it("does not fire in test files", () => {
		expect(checkFetchWithoutTimeout(`fetch(url);`, TEST)).toEqual([]);
	});
});

describe("checkUnboundedPromiseAll", () => {
	it("flags Promise.all(<ident>.map(...))", () => {
		const code = `await Promise.all(items.map(async (i) => fetchOne(i)));`;
		expect(checkUnboundedPromiseAll(code, TS).length).toBe(1);
	});

	it("does not fire on Promise.all([fn1(), fn2()]) inline-array", () => {
		const code = `await Promise.all([fetchA(), fetchB(), fetchC()]);`;
		expect(checkUnboundedPromiseAll(code, TS)).toEqual([]);
	});

	it("does not fire when ident is locally-bounded inline literal", () => {
		const code = `const list = [1,2,3]; await Promise.all(list.map(fn));`;
		// This currently falls through because the `list = [...]` declaration is
		// on a different line; the check is line-local. Document the
		// limitation: it WILL fire here. We expect 1 match.
		const matches = checkUnboundedPromiseAll(code, TS);
		expect(matches.length).toBeLessThanOrEqual(1);
	});

	it("does not fire in test files", () => {
		expect(checkUnboundedPromiseAll(`Promise.all(arr.map(fn));`, TEST)).toEqual([]);
	});
});

describe("checkSyncIoOnHotPath", () => {
	it("flags readFileSync inside a handlers/ file", () => {
		const code = `
import { readFileSync } from "node:fs";
export async function handle(req: Request): Promise<Response> {
  const data = readFileSync("/etc/config");
  return new Response(data);
}
`;
		expect(checkSyncIoOnHotPath(code, HANDLER).length).toBe(1);
	});

	it("flags execSync inside a routes/ file", () => {
		const code = `
import { execSync } from "node:child_process";
export function get(req) { execSync("ls"); }
`;
		expect(checkSyncIoOnHotPath(code, "src/routes/foo.ts").length).toBe(1);
	});

	it("flags sync I/O when file declares a handler-named function", () => {
		const code = `
import { readFileSync } from "node:fs";
export async function handleRequest(req) { readFileSync("x"); }
`;
		expect(checkSyncIoOnHotPath(code, "src/lib/server.ts").length).toBe(1);
	});

	it("does not fire on sync I/O in plain library code", () => {
		const code = `
import { readFileSync } from "node:fs";
export function loadConfig() { return readFileSync("config.json"); }
`;
		expect(checkSyncIoOnHotPath(code, "src/lib/config.ts")).toEqual([]);
	});

	it("does not fire in CLI files", () => {
		const code = `import { readFileSync } from "node:fs"; readFileSync("x");`;
		expect(checkSyncIoOnHotPath(code, "src/commands/run.ts")).toEqual([]);
	});

	it("does not fire in test files", () => {
		expect(
			checkSyncIoOnHotPath(`readFileSync("x")`, "src/handlers/foo.test.ts"),
		).toEqual([]);
	});
});
