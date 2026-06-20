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
import { nonNull } from "../../lib/non-null.js";

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
		expect(nonNull(matches[0]).line).toBe(3);
	});

	it("flags 'for now' / self-describing 'placeholder' / 'simplified version'", () => {
		// Bare "placeholder" is deliberately NOT a strong phrase (it over-fires
		// on input labels and doc text — see checkAgentThumbprintProse tier
		// split). A self-describing form ("this is a placeholder") still fires.
		const code = `
const X = 1; // this is a placeholder
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

	// FP refinement (2026-05): weak phrases ("in production", "in practice")
	// appear in legitimate engineering prose constantly. They are now
	// two-tiered — a weak phrase fires only when a corroborating
	// incompleteness signal (TODO, stub, throw, empty body, "for now") sits
	// on the same line or an immediate neighbour. Strong phrases still fire
	// alone.

	it("does NOT flag an informative 'in production' engineering comment", () => {
		// Regression: src/lib/local-activity.ts:374 —
		// "observed in production (a single workspace grew this file to 3 GB …)"
		// is a legitimate factual comment, not an abandoned-work thumbprint.
		const code = `
const SYNC_ERRORS_MAX_BYTES = 10 * 1024 * 1024;
// 10 MB cap — the multi-GB bloat observed in production was one workspace
// growing this log to 3 GB with one identical message per failed POST.
`;
		expect(checkAgentThumbprintProse(code, TS)).toEqual([]);
	});

	it("does NOT flag 'in practice' in a normal explanatory comment", () => {
		const code = `// in practice the buffer never exceeds 64 KB, so one chunk is enough`;
		expect(checkAgentThumbprintProse(code, TS)).toEqual([]);
	});

	it("does NOT flag the bare word 'placeholder' in normal prose", () => {
		// Known over-fire (project memory): "placeholder" appears in input
		// labels and doc text. Only self-describing forms are a thumbprint.
		const code = `// the input renders a greyed-out placeholder when empty`;
		expect(checkAgentThumbprintProse(code, TS)).toEqual([]);
	});

	it("STILL flags 'in production' when corroborated by a TODO on a neighbour line", () => {
		const code = `
function loadUser(id: string) {
  // in production this would query the database
  // TODO: wire up the real datasource
  return null;
}`;
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("STILL flags 'in practice' when the same line carries a stub throw", () => {
		const code = `function f() { throw new Error("stub"); /* in practice this calls the API */ }`;
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});

	it("STILL flags 'this is a placeholder' (self-describing strong form)", () => {
		const code = `// this is a placeholder until the real service lands`;
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});

	it("STILL flags 'placeholder implementation' (strong form)", () => {
		const code = `function compute() { return 0; } // placeholder implementation`;
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});

	it("STILL flags an 'in production' comment next to an empty-return stub body", () => {
		const code = `
function fetchConfig() {
  // in production this reads from the config service
  return {};
}`;
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});
});

describe("checkStubNotImplementedThrow", () => {
	it("flags `throw new Error(\"not implemented\")`", () => {
		const code = `function foo() { throw new Error("not implemented"); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("not implemented");
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
		expect(nonNull(matches[0]).text).toContain("no message");
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

	it("does not fire on the phrase inside a comment that documents the pattern", () => {
		const code = [
			'/** `throw new Error("not implemented")` and variants in non-test source. */',
			"export function realThing() { return 1; }",
		].join("\n");
		expect(checkStubNotImplementedThrow(code, TS)).toEqual([]);
	});

	it("does not fire on the phrase inside a // line comment", () => {
		const code = '// historically this threw new Error("not implemented") here\nconst x = 1;';
		expect(checkStubNotImplementedThrow(code, TS)).toEqual([]);
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

	// FP refinement (139-repo audit, 2026-05): the path-pattern gate
	// above (`/generated/`, `*.gen.ts`) misses files where the path
	// doesn't reveal the origin (e.g. `sdk/src/apis/DefaultApi.ts`).
	// The content-marker gate now catches that shape too.

	it("does not flag files whose first 20 lines say 'auto generated by OpenAPI Generator'", () => {
		const directive = `/* eslint-${"disable"} */`;
		const code = [
			directive,
			"/**",
			" * NOTE: This class is auto generated by OpenAPI Generator",
			" * Do not edit the class manually.",
			" */",
			"export class DefaultApi {}",
		].join("\n");
		// Path doesn't include `/generated/` — only the content marker
		// can save us.
		expect(checkFileLevelSuppression(code, "sdk/src/apis/DefaultApi.ts")).toEqual([]);
	});

	it("does not flag protoc-generated files", () => {
		const directive = `/* tslint:${"disable"} */`;
		const code = [
			"// Code generated by protoc-gen-ts. DO NOT EDIT.",
			directive,
			"export class ProtoBuf {}",
		].join("\n");
		expect(checkFileLevelSuppression(code, "proto/foo_pb.ts")).toEqual([]);
	});

	it("does not flag @generated files (Relay/codegen)", () => {
		const directive = `/* eslint-${"disable"} */`;
		const code = [
			"// @generated SignedSource<<abc123>>",
			directive,
			"export const query = `...`;",
		].join("\n");
		expect(checkFileLevelSuppression(code, "src/Schema.ts")).toEqual([]);
	});

	// Positive cases — real hand-written code with file-level
	// suppression MUST still fire.

	it("STILL flags hand-written file with eslint-disable header", () => {
		const directive = `/* eslint-${"disable"} */`;
		const code = [directive, "export function realFunction() {}"].join("\n");
		expect(checkFileLevelSuppression(code, "src/lib/auth.ts").length).toBe(1);
	});

	it("STILL flags hand-written file with @ts-nocheck", () => {
		const directive = `// @ts-${"nocheck"}`;
		const code = [directive, "function legitCode() { return 1; }"].join("\n");
		expect(checkFileLevelSuppression(code, "src/utils.ts").length).toBe(1);
	});

	it("STILL flags handwritten code where 'generated' appears later than line 20", () => {
		const directive = `/* eslint-${"disable"} */`;
		// Line 25 references generator — but past the head window.
		const lines = [
			directive,
			...Array.from({ length: 23 }, (_, i) => `const x${i} = ${i};`),
			"// uses the auto-generated client elsewhere",
		];
		expect(checkFileLevelSuppression(lines.join("\n"), "src/lib/foo.ts").length).toBe(1);
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

	it("does not fire on Cloudflare Worker entry handler (#17)", () => {
		// `async fetch(request: Request, env, ctx)` is a method declaration on the
		// default ExportedHandler — runtime invokes it on incoming requests; it's
		// not a fetch() call.
		const code = `export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return new Response("ok");
	},
};`;
		expect(checkFetchWithoutTimeout(code, TS)).toEqual([]);
	});

	it("does not fire on Worker handler without 'async' prefix", () => {
		const code = `export default {
	fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return new Response("ok");
	},
};`;
		expect(checkFetchWithoutTimeout(code, TS)).toEqual([]);
	});

	it("still fires on a real fetch() call inside a Worker handler body", () => {
		const code = `export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const upstream = await fetch("https://example.com");
		return upstream;
	},
};`;
		// Two `fetch(` occurrences — the handler (skipped) AND the call (flagged).
		const matches = checkFetchWithoutTimeout(code, TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("fetch()");
	});

	it("does not fire on a Cloudflare binding member call (env.ASSETS.fetch)", () => {
		// `env.ASSETS.fetch(request)` dispatches through the static-asset binding,
		// which does not accept a per-call AbortSignal/timeout.
		const code = `return env.ASSETS.fetch(request);`;
		expect(checkFetchWithoutTimeout(code, TS)).toEqual([]);
	});

	it("does not fire on a service/DO binding stub member call (stub.fetch)", () => {
		const code = `const res = await stub.fetch(req);`;
		expect(checkFetchWithoutTimeout(code, TS)).toEqual([]);
	});

	it("still fires on namespaced-global fetch (globalThis/self/window)", () => {
		// These ARE the global fetch — they take a timeout and must be flagged.
		expect(checkFetchWithoutTimeout(`await globalThis.fetch(url);`, TS).length).toBe(1);
		expect(checkFetchWithoutTimeout(`await self.fetch(url);`, TS).length).toBe(1);
		expect(checkFetchWithoutTimeout(`await window.fetch(url);`, TS).length).toBe(1);
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

	// FP refinement (2026-05): bare HTTP-verb names (`get`, `post`, …) were
	// matched with a `\w*` suffix, so a camelCase getter named e.g.
	// `getActivityPath` made an ordinary library module "look like" a hot
	// path. The verb must now be the WHOLE identifier. Prefix names like
	// `handle*` / `on*` are unaffected.

	it("STILL flags a file declaring `function get(` (bare-verb route handler)", () => {
		const code = `
import { readFileSync } from "node:fs";
export function get(req) { return readFileSync("x"); }
`;
		// Bare verb as the whole identifier IS a router-method shape.
		expect(checkSyncIoOnHotPath(code, "src/lib/server.ts").length).toBe(1);
	});

	it("STILL flags an arrow handler named exactly `post`", () => {
		const code = `
import { writeFileSync } from "node:fs";
export const post = async (req) => { writeFileSync("x", req.body); };
`;
		expect(checkSyncIoOnHotPath(code, "src/lib/server.ts").length).toBe(1);
	});

	it("STILL flags sync I/O in a handlers/ directory regardless of fn name", () => {
		const code = `
import { readdirSync } from "node:fs";
export function listEntries() { return readdirSync("/data"); }
`;
		// Directory match alone makes this a hot path.
		expect(checkSyncIoOnHotPath(code, "src/handlers/list.ts").length).toBe(1);
	});

	it("does NOT fire on a camelCase getter named `getActivityPath`", () => {
		// Regression: `getActivityPath` starts with `get` but is a plain
		// path helper, not a route handler. `src/lib/local-activity.ts`
		// is full of these (getSessionsDir, getSyncStatePath, …).
		const code = `
import { readFileSync } from "node:fs";
export function getActivityPath(cwd: string) { return readFileSync(cwd); }
`;
		expect(checkSyncIoOnHotPath(code, "src/lib/local-activity.ts")).toEqual([]);
	});

	it("does NOT fire on camelCase helpers `getUnsyncedEvents` / `deleteRecord`", () => {
		const code = `
import { readFileSync, unlinkSync } from "node:fs";
export function getUnsyncedEvents() { return readFileSync("log"); }
export function deleteRecord(id: string) { unlinkSync(id); }
`;
		expect(checkSyncIoOnHotPath(code, "src/lib/store.ts")).toEqual([]);
	});

	it("does NOT fire on the real local-activity.ts shape (sync JSONL library)", () => {
		// Condensed reproduction of src/lib/local-activity.ts: an
		// offline-first synchronous library module whose only verb-prefixed
		// names are getters. None of these are HTTP handlers.
		const code = `
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
function getActivityPath(cwd) { return cwd + "/activity.jsonl"; }
function getSessionsDir(cwd) { return cwd + "/sessions"; }
export function appendLocalActivity(event, cwd) {
  mkdirSync(getSessionsDir(cwd), { recursive: true });
  appendFileSync(getActivityPath(cwd), JSON.stringify(event));
}
export function readLocalSessions(cwd) {
  return readdirSync(getSessionsDir(cwd)).map((f) => readFileSync(f, "utf-8"));
}
`;
		expect(checkSyncIoOnHotPath(code, "src/lib/local-activity.ts")).toEqual([]);
	});
});
