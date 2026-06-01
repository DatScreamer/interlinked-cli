import { describe, expect, it } from "vitest";
import {
	checkAsyncPromiseExecutor,
	checkFloatingPromises,
	checkMisusedPromises,
	checkSilentPromiseSwallow,
} from "./agent-safety-async.js";

// Smoke-test coverage for the agent-safety async/promise check family. Each
// check has deeper coverage in `src/harness/__tests__/generic-checks-extended-*.test.ts`
// and friends — this file satisfies the harness's per-source-file test rule
// and guards the shape of the exported check functions.

describe("checkFloatingPromises — regression guards", () => {
	it("does not flag interface/type method signatures", () => {
		// Signatures look like calls but are declarations; must not fire.
		const src = [
			"async function stop() { return; }",
			"interface Handle {",
			"  stop(reason?: string): Promise<void>;",
			"}",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out).toEqual([]);
	});

	it("does not flag arrow-function concise-body return values", () => {
		// `(d) => fn(d)` returns the promise; Promise.all handles it.
		const src = [
			"async function fn(d: number) { return d; }",
			"const rows = await Promise.all(",
			"  xs.map((d) =>",
			"    fn(d),",
			"  ),",
			");",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out).toEqual([]);
	});

	it("still flags a truly floating async call at statement position", () => {
		const src = [
			"async function doIt() { return; }",
			"function caller() {",
			"  doIt();", // floating — no await, no return, no void
			"}",
		].join("\n");
		const out = checkFloatingPromises(src, "src/foo.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("agent-safety async check surface — smoke", () => {
	it("checkAsyncPromiseExecutor returns an array", () => {
		expect(Array.isArray(checkAsyncPromiseExecutor("", "a.ts"))).toBe(true);
	});

	it("checkMisusedPromises returns an array", () => {
		expect(Array.isArray(checkMisusedPromises("", "a.ts"))).toBe(true);
	});
});

describe("checkSilentPromiseSwallow", () => {
	it("flags .catch(() => {})", () => {
		const out = checkSilentPromiseSwallow(
			'fetch("/api").catch(() => {});\n',
			"src/x.ts",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .catch with bound param and empty body", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch((e) => {});\n",
			"src/x.ts",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .catch returning literal undefined / null / void 0", () => {
		const cases = [
			"foo().catch(() => undefined);\n",
			"foo().catch(_ => null);\n",
			"foo().catch(() => void 0);\n",
		];
		for (const src of cases) {
			expect(checkSilentPromiseSwallow(src, "src/x.ts").length).toBeGreaterThanOrEqual(1);
		}
	});

	it("flags .catch(function (e) {})", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(function (e) {});\n",
			"src/x.ts",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag .catch with a real handler body", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch((e) => log(e));\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag .catch with explicit param-ack body", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch((e) => { void e; });\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag .catch(handlerIdent) — unknown intent", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(handleError);\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag when an inline comment marks intent", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(() => { /* fire and forget */ });\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT run on test files", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(() => {});\n",
			"src/x.test.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		const out = checkSilentPromiseSwallow(
			"foo().catch(() => {});\n",
			"src/x.py",
		);
		expect(out).toEqual([]);
	});
});
