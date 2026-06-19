// Unit tests for array-method-misuse.ts
//
// detectReturnArrayPush (array_push_return_used):
//   Positive (MUST fire): push() result returned directly; bound to a fresh
//   const; unshift() result bound to a let; this.<field>.push() returned (a
//   normal array field, not a stream).
//   Negative (MUST NOT fire): an arrow implicit-return callback
//   `() => arr.push(x)` (out of scope — usually a void callback whose return is
//   discarded); a standalone push() statement (result unused); this.push(chunk)
//   returned (Readable#push backpressure boolean); a stream-named receiver; a
//   chained .push().length (explicit length read); pushState() (a different
//   method, not push); non-JS files.
//
// detectArrayIterateeVariadicBuiltin (array_iteratee_variadic_builtin):
//   Positive (MUST fire): parseInt or Number.parseInt passed bare to .map /
//   .flatMap / Array.from(x, fn).
//   Negative (MUST NOT fire): parseInt wrapped with an explicit radix; .map(Number)
//   or .map(Boolean) (they ignore the extra arg); .forEach(parseInt) (result
//   discarded); non-JS files.

import { describe, expect, it } from "vitest";
import {
	detectArrayIterateeVariadicBuiltin,
	detectReturnArrayPush,
} from "./array-method-misuse.js";

const pushFires = (src: string, file = "src/util.ts"): boolean =>
	detectReturnArrayPush(src, file).length > 0;
const iterFires = (src: string, file = "src/util.ts"): boolean =>
	detectArrayIterateeVariadicBuiltin(src, file).length > 0;

describe("detectReturnArrayPush — positive (must fire)", () => {
	it("P1: return items.push(item)", () => {
		expect(pushFires(`function add(item) { return items.push(item); }`)).toBe(true);
	});
	it("P2: const binding of push result", () => {
		expect(pushFires(`const added = list.push(value);`)).toBe(true);
	});
	it("P4: let binding of unshift result", () => {
		expect(pushFires(`let n = arr.unshift(x);`)).toBe(true);
	});
	it("P5: return this.items.push(x) — this.<field> is a normal array", () => {
		expect(pushFires(`class Q { add(x) { return this.items.push(x); } }`)).toBe(true);
	});
});

describe("detectReturnArrayPush — negative (must NOT fire)", () => {
	it("N1: standalone push statement", () => {
		expect(pushFires(`function add(item) { items.push(item); }`)).toBe(false);
	});
	it("N2: return this.push(chunk) — stream Readable#push", () => {
		expect(pushFires(`class R { _read() { return this.push(chunk); } }`)).toBe(false);
	});
	it("N3: stream-named receiver binding", () => {
		expect(pushFires(`const ok = readableStream.push(data);`)).toBe(false);
	});
	it("N4: chained .push(x).length is an explicit length read", () => {
		expect(pushFires(`return arr.push(x).length > 0;`)).toBe(false);
	});
	it("N5: pushState is not push", () => {
		expect(pushFires(`return router.pushState(x);`)).toBe(false);
	});
	it("N6: non-JS file out of scope", () => {
		expect(detectReturnArrayPush(`return items.push(item)`, "script.py")).toHaveLength(0);
	});
	it("N7: arrow implicit-return callback is out of scope (avoids void-callback FPs)", () => {
		expect(pushFires(`stream.on("data", (ch) => chunks.push(ch));`)).toBe(false);
		expect(pushFires(`const add = (item) => items.push(item);`)).toBe(false);
	});
});

describe("detectArrayIterateeVariadicBuiltin — positive (must fire)", () => {
	it("P1: .map(parseInt)", () => {
		expect(iterFires(`const nums = ['1','2','3'].map(parseInt);`)).toBe(true);
	});
	it("P2: .flatMap(parseInt)", () => {
		expect(iterFires(`const out = xs.flatMap(parseInt);`)).toBe(true);
	});
	it("P3: Array.from(x, parseInt)", () => {
		expect(iterFires(`const out = Array.from(strs, parseInt);`)).toBe(true);
	});
	it("P4: .map(Number.parseInt)", () => {
		expect(iterFires(`const out = xs.map(Number.parseInt);`)).toBe(true);
	});
});

describe("detectArrayIterateeVariadicBuiltin — negative (must NOT fire)", () => {
	it("N1: wrapped parseInt with explicit radix", () => {
		expect(iterFires(`const out = xs.map((s) => parseInt(s, 10));`)).toBe(false);
	});
	it("N2: .map(Number) — Number ignores the index", () => {
		expect(iterFires(`const out = xs.map(Number);`)).toBe(false);
	});
	it("N3: .map(Boolean) filter-falsy idiom", () => {
		expect(iterFires(`const truthy = xs.map(Boolean);`)).toBe(false);
	});
	it("N4: .forEach(parseInt) is out of scope (return discarded)", () => {
		expect(iterFires(`xs.forEach(parseInt);`)).toBe(false);
	});
	it("N5: non-JS file out of scope", () => {
		expect(detectArrayIterateeVariadicBuiltin(`xs.map(parseInt)`, "script.py")).toHaveLength(0);
	});
});
