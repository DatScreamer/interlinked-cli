import { describe, expect, it } from "vitest";
import { checkErrorDispatchByInstanceof } from "./error-handling.js";

const TS = "src/lib/foo.ts";

describe("checkErrorDispatchByInstanceof — positive cases", () => {
	it("flags `e instanceof Error` inside catch", () => {
		const code = [
			"function bug() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    if (e instanceof Error) handle(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].text).toMatch(/instanceof\s+Error/);
	});

	it("flags `e instanceof TypeError`", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof TypeError) return;",
			"    throw e;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `err instanceof RangeError`", () => {
		const code = [
			"async function bug() {",
			"  try { await f(); }",
			"  catch (err) {",
			"    if (err instanceof RangeError) return -1;",
			"    throw err;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags multiple instanceof checks in one catch", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof SyntaxError) return 1;",
			"    if (e instanceof URIError) return 2;",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(2);
	});
});

describe("checkErrorDispatchByInstanceof — negative cases (must NOT fire)", () => {
	it("does NOT flag `instanceof Error` OUTSIDE a catch block", () => {
		const code = [
			"function check(x: unknown) {",
			"  return x instanceof Error;",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag `instanceof` against custom user-defined classes inside catch", () => {
		const code = [
			"class NetworkError {}",
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if (e instanceof NetworkError) handle(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag tag-dispatch in catch (the recommended pattern)", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    if ((e as { _tag?: string })._tag === 'NetworkError') handle();",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("skips test files entirely", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) { if (e instanceof Error) handle(e); }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, "src/lib/foo.test.ts");
		expect(out).toEqual([]);
	});

	it("skips non-JS/TS files", () => {
		const code = `try: ...\nexcept e: e instanceof Error\n`;
		const out = checkErrorDispatchByInstanceof(code, "src/lib/foo.py");
		expect(out).toEqual([]);
	});

	it("ignores `instanceof Error` in a comment", () => {
		const code = [
			"function bug() {",
			"  try { f(); }",
			"  catch (e) {",
			"    // Note: e instanceof Error fails across realms",
			"    handle(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});
});
