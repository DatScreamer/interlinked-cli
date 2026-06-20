// Type-smuggling detector tests.
//
// Positive cases (check fires):
//   1. Primitive → unrelated object shape: `"hello" as { id: number }`
//   2. Two distinct object shapes: `userObj as ProductObj`
//   3. Double-cast escape hatch: `someValue as unknown as Specific`
//
// Negative cases (check does NOT fire):
//   1. `unknownVal as User` — source is `unknown` (allowed escape hatch)
//   2. `"foo" as const` — `as const` is exempt
//   3. `animal as Dog` where `Dog extends Animal` — narrowing
//   4. Structurally-overlapping shapes — both directions assignable
//   5. Cast target is `any` — allowed widening
//   6. Test files — skipped entirely
//
// Runtime-loading cases (Path C — createRequire optional load):
//   1. Cache survives reset and reloads on next call
//   2. (Failure-mode test not included — simulating "typescript not in
//       project node_modules" requires either mocking node:module or a
//       fake project setup; covered by the tarball install smoke in CI
//       which proves install-hooks succeeds without bundled TS.)

import { describe, expect, it } from "vitest";
import type { InlineMatch } from "../shared.js";
import { __resetTsCacheForTests, checkTypeSmuggling } from "../type-smuggling.js";
import { nonNull } from "../../../lib/non-null.js";

const TS = "src/lib/foo.ts";
const TEST_FILE = "src/lib/foo.test.ts";

// ===========================================
// Positive cases — check FIRES
// ===========================================

describe("checkTypeSmuggling — positive cases", () => {
	it("flags a string-literal cast to an unrelated object shape", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("type-smuggling cast");
	});

	it("flags a cast between two distinct object shapes", () => {
		const code = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
			"export { product };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(matches[0]).text).toContain("type-smuggling cast");
	});

	it("flags `as unknown as Specific` double-cast escape with a distinct message", () => {
		const code = [
			"interface Specific { id: number; }",
			"declare const someValue: number;",
			"const v = someValue as unknown as Specific;",
			"export { v };",
		].join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches.some((m: InlineMatch) => m.text.includes("double-cast detected"))).toBe(true);
	});
});

// ===========================================
// Negative cases — check DOES NOT FIRE
// ===========================================

describe("checkTypeSmuggling — negative cases (must NOT fire)", () => {
	it("does not fire when source is `unknown` — legitimate widening escape", () => {
		const code = [
			"interface User { id: number; }",
			"declare const unknownVal: unknown;",
			"const u = unknownVal as User;",
			"export { u };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on `as const` literal-narrowing", () => {
		const code = ['const b = "foo" as const;', "export { b };"].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on subtype narrowing — Dog from Animal-typed source", () => {
		const code = [
			"interface Animal { name: string; }",
			"interface Dog extends Animal { breed: string; }",
			"declare const animal: Animal;",
			"const z = animal as Dog;",
			"export { z };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when source and target overlap structurally (both directions)", () => {
		const code = [
			"interface ApiSchema { id: number; name: string; }",
			"declare const response: { id: number; name: string };",
			"const d = response as ApiSchema;",
			"export { d };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when the cast target is `any` — allowed widening", () => {
		const code = [
			"declare const x: { id: number };",
			"const wide = x as any;",
			"export { wide };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire when the cast target is `unknown` — allowed widening", () => {
		const code = [
			"declare const x: { id: number };",
			"const wide = x as unknown;",
			"export { wide };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("skips test files entirely", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");
		expect(checkTypeSmuggling(code, TEST_FILE)).toEqual([]);
	});

	it("skips plain JavaScript files (no .ts/.tsx/.mts/.cts)", () => {
		const code = ['const x = "hello" as { id: number };'].join("\n");
		expect(checkTypeSmuggling(code, "src/foo.js")).toEqual([]);
		expect(checkTypeSmuggling(code, "src/foo.jsx")).toEqual([]);
	});

	it("does not fire on files with no `as` expression at all", () => {
		const code = [
			"const x = 1;",
			'const y = "foo";',
			"export { x, y };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on `as <SameType>` casts (identity)", () => {
		const code = [
			"interface User { id: number; }",
			"declare const u: User;",
			"const v = u as User;",
			"export { v };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("does not fire on widening through a union — value already part of target", () => {
		const code = [
			'type Status = "ok" | "error" | "pending";',
			'const s: "ok" = "ok";',
			"const t = s as Status;",
			"export { t };",
		].join("\n");
		expect(checkTypeSmuggling(code, TS)).toEqual([]);
	});

	it("silently skips files whose content cannot be parsed (broken syntax)", () => {
		// Broken source — the compiler will still produce SOMETHING, but the
		// checker may not be able to resolve types. Per the spec, we should
		// not false-fire on broken type info.
		const code = ['const x = "hello" as ;'].join("\n"); // missing target type
		const out = checkTypeSmuggling(code, TS);
		// The detector may legitimately return [] here. We assert nothing
		// fires on the bad cast — the parse error is its own signal.
		expect(out).toEqual([]);
	});
});

// ===========================================
// Performance / scope guards
// ===========================================

describe("checkTypeSmuggling — scope guards", () => {
	it("bails out on files larger than the line cap (>1000 lines)", () => {
		const long = Array(1001)
			.fill('const x = "hello" as { id: number };')
			.join("\n");
		expect(checkTypeSmuggling(long, TS)).toEqual([]);
	});

	it("caps reported matches at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 20; i++) {
			lines.push(`const x${i} = "hello" as { id: number };`);
		}
		const code = lines.join("\n");
		const matches = checkTypeSmuggling(code, TS);
		expect(matches.length).toBeLessThanOrEqual(10);
		expect(matches.length).toBeGreaterThanOrEqual(1);
	});

	it("returns an empty array on empty content", () => {
		expect(checkTypeSmuggling("", TS)).toEqual([]);
	});
});

// ===========================================
// Runtime-loading (createRequire + cache)
// ===========================================

describe("checkTypeSmuggling — runtime-loaded TypeScript", () => {
	it("re-resolves TypeScript after the cache is reset (cache survives across calls)", () => {
		const code = [
			'const x = "hello" as { id: number };',
			"export { x };",
		].join("\n");

		// First call: cache populated.
		const first = checkTypeSmuggling(code, TS);
		expect(first.length).toBeGreaterThanOrEqual(1);

		// Reset and call again: cache is rebuilt, behavior is unchanged.
		__resetTsCacheForTests();
		const second = checkTypeSmuggling(code, TS);
		expect(second.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(second[0]).text).toEqual(nonNull(first[0]).text);
	});
});
