import { describe, expect, it } from "vitest";
import {
	checkAsyncPromiseExecutor,
	checkFloatingPromises,
	checkMisusedPromises,
	checkSelfImport,
} from "./agent-safety.js";

// Smoke-test coverage for the agent-safety check family. Each check has
// deeper coverage in `src/harness/__tests__/generic-checks-extended-*.test.ts`
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

describe("agent-safety check surface — smoke", () => {
	it("checkAsyncPromiseExecutor returns an array", () => {
		expect(Array.isArray(checkAsyncPromiseExecutor("", "a.ts"))).toBe(true);
	});

	it("checkMisusedPromises returns an array", () => {
		expect(Array.isArray(checkMisusedPromises("", "a.ts"))).toBe(true);
	});

	it("checkSelfImport returns an array", () => {
		expect(Array.isArray(checkSelfImport("", "a.ts"))).toBe(true);
	});
});
