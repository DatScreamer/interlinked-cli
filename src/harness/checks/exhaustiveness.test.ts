// Tests for discriminated_union_exhaustiveness.
//
// Required by spec: ≥3 positive + ≥3 negative cases. Each scenario lives in a
// separate `it()` so failures pinpoint exactly which shape regressed.

import { describe, expect, it } from "vitest";
import { checkDiscriminatedUnionExhaustiveness } from "./exhaustiveness.js";

const TS = "src/lib/foo.ts";

// =============================================================================
// Positive cases — check MUST fire
// =============================================================================

describe("checkDiscriminatedUnionExhaustiveness — positive cases", () => {
	it("flags a string-literal union switch missing a case (no never default)", () => {
		const code = [
			"function handle(status: 'a' | 'b' | 'c') {",
			"  switch (status) {",
			"    case 'a': return 1;",
			"    case 'b': return 2;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].text).toContain("missing case");
	});

	it("flags a discriminated-union switch missing a kind", () => {
		const code = [
			"type Msg = { kind: 'foo'; x: number } | { kind: 'bar'; y: string };",
			"function handle(m: Msg) {",
			"  switch (m.kind) {",
			"    case 'foo': return m.x;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		// Should mention the missing tag.
		expect(out[0].text).toContain("bar");
	});

	it("flags a switch whose default is `break;` (no never assertion)", () => {
		const code = [
			"type Color = 'red' | 'green' | 'blue';",
			"function name(c: Color): string {",
			"  switch (c) {",
			"    case 'red': return 'r';",
			"    case 'green': return 'g';",
			"    default: break;",
			"  }",
			"  return 'unknown';",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a named-alias union when a member is dropped", () => {
		const code = [
			"type Phase = 'pre_block' | 'pre_warn' | 'post';",
			"export function describe(p: Phase): string {",
			"  switch (p) {",
			"    case 'pre_block': return 'block';",
			"    case 'post': return 'post';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0].text).toContain("pre_warn");
	});
});

// =============================================================================
// Negative cases — check MUST NOT fire
// =============================================================================

describe("checkDiscriminatedUnionExhaustiveness — negative cases (must NOT fire)", () => {
	it("ignores a switch whose default does `const _: never = x;`", () => {
		const code = [
			"function handle(status: 'a' | 'b'): number {",
			"  switch (status) {",
			"    case 'a': return 1;",
			"    case 'b': return 2;",
			"    default: {",
			"      const _exhaustive: never = status;",
			"      throw new Error('unreachable: ' + _exhaustive);",
			"    }",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores a switch whose default calls `assertNever(...)`", () => {
		const code = [
			"declare function assertNever(x: never): never;",
			"type Msg = { kind: 'foo' } | { kind: 'bar' };",
			"function handle(m: Msg) {",
			"  switch (m.kind) {",
			"    case 'foo': return 1;",
			"    case 'bar': return 2;",
			"    default: assertNever(m.kind);",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores a switch whose default throws an UnreachableError", () => {
		const code = [
			"class UnreachableError extends Error {}",
			"function handle(status: 'a' | 'b'): number {",
			"  switch (status) {",
			"    case 'a': return 1;",
			"    case 'b': return 2;",
			"    default: throw new UnreachableError('unreachable');",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores a fully-covered switch (no default needed)", () => {
		const code = [
			"function handle(status: 'a' | 'b' | 'c'): number {",
			"  switch (status) {",
			"    case 'a': return 1;",
			"    case 'b': return 2;",
			"    case 'c': return 3;",
			"  }",
			"  return -1;",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores `switch (typeof x)` — type-narrow style", () => {
		const code = [
			"function describe(x: unknown): string {",
			"  switch (typeof x) {",
			"    case 'string': return 's';",
			"    case 'number': return 'n';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores a boolean switch (single-shape, exhaustive by construction)", () => {
		const code = [
			"function flip(b: boolean): number {",
			"  switch (b) {",
			"    case true: return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores a non-union switch (e.g. on x.length)", () => {
		const code = [
			"function describe(xs: number[]): string {",
			"  switch (xs.length) {",
			"    case 0: return 'empty';",
			"    case 1: return 'singleton';",
			"    default: return 'many';",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores a numeric-literal union fully covered by cases", () => {
		const code = [
			"function name(n: 1 | 2 | 3): string {",
			"  switch (n) {",
			"    case 1: return 'one';",
			"    case 2: return 'two';",
			"    case 3: return 'three';",
			"  }",
			"  return 'unknown';",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores switches in test files", () => {
		const code = [
			"function handle(status: 'a' | 'b' | 'c') {",
			"  switch (status) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(
			checkDiscriminatedUnionExhaustiveness(code, "src/lib/foo.test.ts"),
		).toEqual([]);
	});

	it("skips files with no switch keyword (no parser boot)", () => {
		const code = [
			"function noop() {}",
			"const x = 1;",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("ignores switches whose discriminant type cannot be syntactically resolved", () => {
		// Cross-module type — no annotation in scope. We conservatively skip.
		const code = [
			"function handle(status: any): number {",
			"  switch (status) {",
			"    case 'a': return 1;",
			"    case 'b': return 2;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});
});
