import { describe, expect, it } from "vitest";
import { checkErrorDispatchByInstanceof, checkLossyErrorRethrow } from "./error-handling.js";
import { nonNull } from "../../lib/non-null.js";

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
		expect(nonNull(out[0]).text).toMatch(/instanceof\s+Error/);
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

	it("still flags subtype `e instanceof TypeError` in a ternary (only base Error is exempt)", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    const msg = e instanceof TypeError ? e.message : String(e);",
			"    log(msg);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("still flags base `instanceof Error` used for real dispatch, not extraction", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    if (e instanceof Error) { retry(); } else { giveUp(); }",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
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

	it("does NOT flag the message-extraction guard `e instanceof Error ? e.message : String(e)`", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    const msg = e instanceof Error ? e.message : String(e);",
			"    log(msg);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag the multi-line message-extraction guard", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (err) {",
			"    return err instanceof Error",
			"      ? err.message",
			"      : String(err);",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});

	it("does NOT flag the `.stack` extraction guard", () => {
		const code = [
			"function f() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    report(e instanceof Error ? e.stack : String(e));",
			"  }",
			"}",
		].join("\n");
		const out = checkErrorDispatchByInstanceof(code, TS);
		expect(out).toEqual([]);
	});
});

// ===========================================
// checkLossyErrorRethrow
// ===========================================

describe("checkLossyErrorRethrow — positive cases", () => {
	it("flags throw new Error in catch without cause", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("wrapped: " + err.message);',
			"  }",
			"}",
		].join("\n");
		const out = checkLossyErrorRethrow(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("without { cause: err }");
	});

	it("flags throw new TypeError with a template message but no cause", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			"    throw new TypeError(`bad input: ${e}`);",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("still fires when `cause` appears only inside the message string, not as an option", () => {
		// `cause` inside the message must NOT count as preserving the cause —
		// the string content is blanked before the option check.
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			'    throw new Error("root cause: bad state");',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS).length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkLossyErrorRethrow — negative cases (must NOT fire)", () => {
	it("ignores throw with single-line { cause }", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (e) {",
			'    throw new Error("wrapped", { cause: e });',
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("ignores throw with a MULTI-LINE { cause } after a string-heavy preamble", () => {
		// Regression (trajectory.ts shape): stripStrings collapsed earlier
		// literals and mis-sliced the cause window, falsely flagging this.
		const code = [
			"function g(target: { path: string }, raw: string) {",
			'  console.log("loading");',
			'  console.log("parsing the snapshot file now");',
			"  try {",
			"    JSON.parse(raw);",
			"  } catch (err) {",
			"    throw new Error(`snapshot ${target.path} is malformed`, {",
			"      cause: err,",
			"    });",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("ignores a catch/throw pattern that lives inside a string literal", () => {
		// Regression (section-table-agent-safety.ts shape): the check's own
		// description string must not be mistaken for code.
		const code = [
			"const SPEC = {",
			'  noun: "catch (e) { throw new Error(...) } without { cause: e }",',
			"};",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});

	it("ignores `throw err` rethrow by reference", () => {
		const code = [
			"function g() {",
			"  try { risky(); }",
			"  catch (err) {",
			"    throw err;",
			"  }",
			"}",
		].join("\n");
		expect(checkLossyErrorRethrow(code, TS)).toEqual([]);
	});
});
