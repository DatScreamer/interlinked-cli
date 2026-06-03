import { describe, expect, it } from "vitest";
import {
	checkFreshCollectionKeyLookup,
	checkIteratorInvalidation,
} from "./iteration-safety.js";

const TS = "src/lib/foo.ts";

// ===========================================
// checkIteratorInvalidation
// ===========================================

describe("checkIteratorInvalidation — positive cases", () => {
	it("flags array.push inside for-of over the same array", () => {
		const code = [
			"function bug(items: number[]) {",
			"  for (const x of items) {",
			"    items.push(x * 2);",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].text).toContain("items.push");
	});

	it("flags Set.delete inside .forEach over the same Set", () => {
		const code = [
			"function bug(set: Set<number>) {",
			"  set.forEach((v) => {",
			"    set.delete(v);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].text).toContain("set.delete");
	});

	it("flags Map.set inside .forEach over the same Map", () => {
		const code = [
			"function bug(m: Map<string, number>) {",
			"  m.forEach((v, k) => {",
			"    m.set(k, v + 1);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags `delete obj[k]` inside for-in over the same object", () => {
		const code = [
			"function bug(obj: Record<string, number>) {",
			"  for (const k in obj) {",
			"    delete obj[k];",
			"  }",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].text).toContain("delete obj");
	});

	it("flags array.splice inside .forEach over the same array", () => {
		const code = [
			"function bug(rows: any[]) {",
			"  rows.forEach((_r, i) => {",
			"    rows.splice(i, 1);",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags receiver.push inside a brace-bodied .some() callback over the same receiver", () => {
		// A brace-bodied callback genuinely mutating the iterated receiver is a
		// real bug and must still fire after the expression-arrow FP fix.
		const code = [
			"function bug(items: number[]) {",
			"  items.some((x) => {",
			"    items.push(x);",
			"    return false;",
			"  });",
			"}",
		].join("\n");
		const out = checkIteratorInvalidation(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkIteratorInvalidation — negative cases (must NOT fire)", () => {
	it("ignores non-mutating iteration", () => {
		const code = [
			"function ok(items: number[]) {",
			"  for (const x of items) {",
			"    console.log(x);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores mutation of a different collection", () => {
		const code = [
			"function copy(source: number[], dest: number[]) {",
			"  for (const x of source) {",
			"    dest.push(x);",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores .map building a new array (no mutation of source)", () => {
		const code = [
			"const doubled = items.map((x) => x * 2);",
			"const filtered = items.filter((x) => x > 0);",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores .find / .some / .every read-only callbacks", () => {
		const code = [
			"const found = items.find((x) => x === target);",
			"const any = items.some((x) => x > 5);",
			"const all = items.every((x) => x !== null);",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores equality comparison that visually resembles index assignment", () => {
		// `arr[i] === ...` is NOT an assignment.
		const code = [
			"function ok(arr: number[]) {",
			"  for (const x of arr) {",
			"    if (arr[0] === x) console.log('first');",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores receiver.push in an if-block guarded by receiver.some() (expression-arrow callback)", () => {
		// Regression (project-graph.ts shape): `result.some((e) => e.name === x)`
		// is a brace-less callback; `result.push(exp)` lives in the ENCLOSING
		// if-block, and the loops iterate DIFFERENT collections. Must not fire.
		const code = [
			"function build(starTargets: string[], direct: Exp[]) {",
			"  const result = direct.filter((e) => e.name !== '*');",
			"  for (const target of starTargets) {",
			"    for (const exp of getExports(target)) {",
			"      if (exp.name !== '*' && !result.some((e) => e.name === exp.name)) {",
			"        result.push(exp);",
			"      }",
			"    }",
			"  }",
			"  return result;",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});

	it("ignores receiver.push guarded by !receiver.some() with no enclosing loop", () => {
		// Regression (hook-detection.ts shape): `managers.some(...)` is a
		// brace-less callback used as a condition; the push is in a nested if,
		// not a loop over `managers`.
		const code = [
			"function detect(managers: Mgr[]) {",
			"  if (!managers.some((m) => m.name === 'lefthook')) {",
			"    const pkg = readPkg();",
			"    if (pkg && pkg.deps.lefthook) {",
			"      managers.push({ name: 'lefthook' });",
			"    }",
			"  }",
			"}",
		].join("\n");
		expect(checkIteratorInvalidation(code, TS)).toEqual([]);
	});
});

// ===========================================
// checkFreshCollectionKeyLookup
// ===========================================

describe("checkFreshCollectionKeyLookup — positive cases", () => {
	it("flags .set with empty object literal as key", () => {
		const code = [
			"const m = new Map<object, number>();",
			"m.set({}, 1);",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .get with spread object literal as key", () => {
		const code = [
			"const m = new Map<object, number>();",
			"const x = { a: 1 };",
			"m.get({ ...x });",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .set with fresh Symbol() as key", () => {
		const code = [
			"const m = new Map<symbol, number>();",
			'm.set(Symbol("k"), 1);',
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .has(NaN) as key", () => {
		const code = ["const m = new Map<number, string>();", "m.has(NaN);"].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .set with fresh `new Date()` as key", () => {
		const code = [
			"const m = new Map<Date, number>();",
			"m.set(new Date(), 1);",
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags .add(Symbol(...)) on a Set", () => {
		const code = [
			"const s = new Set<symbol>();",
			's.add(Symbol("k"));',
		].join("\n");
		const out = checkFreshCollectionKeyLookup(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkFreshCollectionKeyLookup — negative cases (must NOT fire)", () => {
	it("ignores stable string keys", () => {
		const code = [
			"const m = new Map<string, number>();",
			'm.set("foo", 1);',
			'm.get("foo");',
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("ignores variable keys", () => {
		const code = [
			"const m = new Map<string, number>();",
			'const key = "x";',
			"m.set(key, 1);",
			"m.get(key);",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("does not fire when file has no Map/Set primitive (Mongoose-style .set)", () => {
		// File-wide gate: if no `new Map(...)` or `Map<...>`/`Set<...>` type
		// annotation appears in the file, we assume `.set({})` is something
		// like a Mongoose document or form helper and skip.
		const code = [
			"function update(doc: any) {",
			"  doc.set({});",
			"}",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("ignores parseInt/Number computations that COULD be NaN at runtime", () => {
		// We only flag literal `NaN`, not values that might be NaN at runtime.
		// Tracking parseInt/Number outputs would explode FP. Static `NaN`
		// is the bug class we care about here.
		const code = [
			"const m = new Map<number, string>();",
			"const n = parseInt(input, 10);",
			"m.set(n, 1);",
			"m.get(Number(input));",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});

	it("ignores destructuring patterns inside method calls", () => {
		// `obj.method({ a, b })` is destructuring on argument shape, not a
		// fresh-key pattern when the receiver isn't a Map/Set. The Map gate
		// guards this case as well.
		const code = [
			"function ok(svc: { set: (opts: { a: number }) => void }) {",
			"  svc.set({ a: 1 });",
			"}",
		].join("\n");
		expect(checkFreshCollectionKeyLookup(code, TS)).toEqual([]);
	});
});
