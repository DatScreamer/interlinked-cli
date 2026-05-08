import { describe, expect, it } from "vitest";
import {
	checkAwaitStateToctou,
	checkBoundaryCopyNoRevalidation,
	checkCleanupReentrancy,
} from "./flow-safety.js";

const TS = "src/lib/foo.ts";

// ===========================================
// checkAwaitStateToctou
// ===========================================

describe("checkAwaitStateToctou — positive cases", () => {
	it("flags `if (state.x) { await ...; state.x.foo() }` same-field deref across await", () => {
		const code = [
			"async function bug(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `if (this.conn) { await this.send(); this.conn.close(); }`", () => {
		const code = [
			"class Bug {",
			"  conn: any;",
			"  async run() {",
			"    if (this.conn) {",
			"      await this.send();",
			"      this.conn.close();",
			"    }",
			"  }",
			"  async send() {}",
			"}",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `if (cache.foo) { await delay(); cache.foo.update(); }`", () => {
		const code = [
			"async function bug(cache: any) {",
			"  if (cache.foo) {",
			"    await delay();",
			"    cache.foo.update();",
			"  }",
			"}",
		].join("\n");
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkAwaitStateToctou — negative cases (must NOT fire)", () => {
	it("ignores re-check after await", () => {
		const code = [
			"async function ok(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    if (state.entry) state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("ignores when there's no await between check and use", () => {
		const code = [
			"function ok(state: any) {",
			"  if (state.entry) {",
			"    state.entry.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("ignores when a different field is used after the await", () => {
		const code = [
			"async function ok(state: any) {",
			"  if (state.entry) {",
			"    await sync();",
			"    state.other.touch();",
			"  }",
			"}",
		].join("\n");
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkCleanupReentrancy
// ===========================================

describe("checkCleanupReentrancy — positive cases", () => {
	it("flags dispose() that calls this.dispose()", () => {
		const code = [
			"class Bug {",
			"  dispose() {",
			"    this.dispose();",
			"  }",
			"}",
		].join("\n");
		const out = checkCleanupReentrancy(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags destroy() that calls this.destroy()", () => {
		const code = [
			"class Bug {",
			"  destroy() {",
			"    this.cleanup();",
			"    this.destroy();",
			"  }",
			"  cleanup() {}",
			"}",
		].join("\n");
		const out = checkCleanupReentrancy(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags useEffect cleanup that calls setState", () => {
		const code = [
			"function Comp() {",
			"  useEffect(() => {",
			"    return () => {",
			"      setState({ count: 0 });",
			"    };",
			"  }, []);",
			"}",
		].join("\n");
		const out = checkCleanupReentrancy(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkCleanupReentrancy — negative cases (must NOT fire)", () => {
	it("ignores dispose() that doesn't recurse", () => {
		const code = [
			"class Ok {",
			"  dispose() {",
			"    this.subscription.unsubscribe();",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores useEffect cleanup with pure cleanup calls", () => {
		const code = [
			"function Comp() {",
			"  useEffect(() => {",
			"    const id = setInterval(tick, 1000);",
			"    return () => {",
			"      clearInterval(id);",
			"    };",
			"  }, []);",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("ignores destroy() that delegates without recursing", () => {
		const code = [
			"class Ok {",
			"  destroy() {",
			"    this.parent.deregister(this);",
			"  }",
			"}",
		].join("\n");
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkBoundaryCopyNoRevalidation
// ===========================================

describe("checkBoundaryCopyNoRevalidation — positive cases", () => {
	it("flags Object.assign(slot, req.body) without validator", () => {
		const code = [
			"function bug(slot: any, req: any) {",
			"  Object.assign(slot, req.body);",
			"}",
		].join("\n");
		const out = checkBoundaryCopyNoRevalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags Object.assign(config, JSON.parse(stdin))", () => {
		const code = [
			"function bug(config: any, stdin: string) {",
			"  Object.assign(config, JSON.parse(stdin));",
			"}",
		].join("\n");
		const out = checkBoundaryCopyNoRevalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags spread copy `{ ...defaults, ...req.body }` without validator", () => {
		const code = [
			"function bug(req: any) {",
			"  const merged = { foo: 1, ...req.body };",
			"  return merged;",
			"}",
		].join("\n");
		const out = checkBoundaryCopyNoRevalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkBoundaryCopyNoRevalidation — negative cases (must NOT fire)", () => {
	it("ignores Object.assign with internal-only data", () => {
		const code = [
			"function ok(slot: any, defaults: any) {",
			"  Object.assign(slot, defaults);",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores when source goes through schema parser", () => {
		const code = [
			'import { z } from "zod";',
			"const Body = z.object({ name: z.string() });",
			"function ok(slot: any, req: any) {",
			"  Object.assign(slot, Body.parse(req.body));",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores plain spread of internal value", () => {
		const code = [
			"function ok(defaults: any) {",
			"  return { ...defaults, computed: true };",
			"}",
		].join("\n");
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});
});
