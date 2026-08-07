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

	it("continues past an if-block whose brace never closes within budget", () => {
		const code = `if (state.entry) {${"x".repeat(6000)}`;
		expect(checkAwaitStateToctou(code, TS)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) when 10+ distinct blocks match", () => {
		const blocks: string[] = [];
		for (let i = 0; i < 12; i++) {
			blocks.push(`if (s${i}.entry) { await sync(); s${i}.entry.touch(); }`);
		}
		const out = checkAwaitStateToctou(blocks.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("dedupes two matches landing on the same reported line", () => {
		const code =
			"if (a.b) { await c(); a.b.d(); } if (a.b) { await c(); a.b.e(); }";
		const out = checkAwaitStateToctou(code, TS);
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(1);
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

	it("continues past a method header whose brace never closes within budget", () => {
		const code = `dispose() {${"x".repeat(9000)}`;
		expect(checkCleanupReentrancy(code, TS)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ recursing methods", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push("dispose() { this.dispose(); }");
		}
		const out = checkCleanupReentrancy(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ useEffect state-mutating cleanups", () => {
		const blocks: string[] = [];
		for (let i = 0; i < 12; i++) {
			blocks.push(
				[
					"useEffect(() => {",
					"  return () => {",
					`    setState(${i});`,
					"  };",
					"}, []);",
				].join("\n"),
			);
		}
		const out = checkCleanupReentrancy(blocks.join("\n"), TS);
		expect(out.length).toBe(10);
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

	it("ignores Object.assign whose closing paren never appears within budget", () => {
		const code = `Object.assign(${"a,".repeat(3000)}`;
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores Object.assign with a single argument (no comma, no source)", () => {
		const code = "Object.assign(slot);";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("ignores spread when the enclosing call is a validator", () => {
		const code = "function ok(req: any) { return schema.validate({ ...req.body }); }";
		expect(checkBoundaryCopyNoRevalidation(code, TS)).toEqual([]);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ Object.assign hits", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`Object.assign(slot${i}, req.body);`);
		}
		const out = checkBoundaryCopyNoRevalidation(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});

	it("caps at MAX_MATCHES_PER_FILE (10) for 10+ spread hits", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`const m${i} = { ...req.body };`);
		}
		const out = checkBoundaryCopyNoRevalidation(lines.join("\n"), TS);
		expect(out.length).toBe(10);
	});
});
