// Tests for discriminated_union_exhaustiveness.
//
// Tier under the Check Evidence Contract: `post`, default gate → ≥2 positive
// and ≥2 negative labeled cases. Labels use BOTH recognized conventions:
// direction-naming describes, and per-test `P<n>:` / `N<n>:` prefixes. The
// prefix grammar (`check-evidence/case-parser.ts::CASE_PREFIX_RE`) requires a
// DIGIT after the letter — a bare `P:` / `N:` is invisible to the parser, so
// every prefix here is numbered.
//
// Each scenario lives in a separate `it()` so failures pinpoint exactly which
// shape regressed. Single-finding cases assert the whole `InlineMatch[]` with
// `toEqual`, not a substring of `out[0]`: a substring match on an unbounded
// array cannot see a spurious second finding.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	__resetTsCacheForTesting,
	checkDiscriminatedUnionExhaustiveness,
} from "./exhaustiveness.js";

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
		expect(nonNull(out[0]).text).toContain("missing case");
		// Exact array: `toBeGreaterThanOrEqual(1)` cannot see a spurious out[1].
		expect(out).toEqual([
			{ line: 2, text: 'switch (status) { — union missing case(s): "c"' },
		]);
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
		expect(nonNull(out[0]).text).toContain("bar");
		expect(out).toEqual([
			{
				line: 3,
				text: 'switch (m.kind) { — discriminated union on `kind` missing case(s): "bar"',
			},
		]);
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
		expect(out).toEqual([
			{ line: 3, text: 'switch (c) { — union missing case(s): "blue"' },
		]);
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
		expect(nonNull(out[0]).text).toContain("pre_warn");
		expect(out).toEqual([
			{ line: 3, text: 'switch (p) { — union missing case(s): "pre_warn"' },
		]);
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

// =============================================================================
// Type resolution — every shape the AST-only resolver understands.
// =============================================================================

describe("checkDiscriminatedUnionExhaustiveness — type resolution, positive cases (must fire)", () => {
	it("P1: resolves a discriminated union keyed on `type` rather than `kind`", () => {
		const code = [
			"type Ev = { type: 'open'; a: number } | { type: 'close'; b: string };",
			"function on(e: Ev): number {",
			"  switch (e.type) {",
			"    case 'open': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (e.type) { — discriminated union on `type` missing case(s): "close"' },
		]);
	});

	it("P2: unwraps a parenthesized union member", () => {
		const code = [
			"type P = ({ kind: 'a'; x: number }) | { kind: 'b'; y: string };",
			"function on(p: P): number {",
			"  switch (p.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (p.kind) { — discriminated union on `kind` missing case(s): "b"' },
		]);
	});

	it("P3: skips non-property members and reads a quoted discriminant key", () => {
		const code = [
			"type M = { run(): void; 'kind': 'a' } | { run(): void; 'kind': 'b' };",
			"function on(m: M): number {",
			"  switch (m.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (m.kind) { — discriminated union on `kind` missing case(s): "b"' },
		]);
	});

	it("P4: ignores a numeric-literal property name while resolving the union", () => {
		const code = [
			"type N = { 1: 'x'; kind: 'a' } | { 1: 'y'; kind: 'b' };",
			"function on(n: N): number {",
			"  switch (n.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (n.kind) { — discriminated union on `kind` missing case(s): "b"' },
		]);
	});

	it("P5: resolves an inline (non-aliased) discriminated-union annotation", () => {
		const code = [
			"function on(m: { kind: 'a'; x: number } | { kind: 'b'; y: string }): number {",
			"  switch (m.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 2, text: 'switch (m.kind) { — discriminated union on `kind` missing case(s): "b"' },
		]);
	});

	it("P6: resolves a `switch (raw as Union)` assertion", () => {
		const code = [
			"function on(raw: unknown): number {",
			"  switch (raw as 'a' | 'b' | 'c') {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 2, text: `switch (raw as 'a' | 'b' | 'c') { — union missing case(s): "b", "c"` },
		]);
	});

	it("P7: resolves an angle-bracket `<Union>raw` assertion", () => {
		const code = [
			"function on(raw: unknown): number {",
			"  switch (<'a' | 'b' | 'c'>raw) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 2, text: `switch (<'a' | 'b' | 'c'>raw) { — union missing case(s): "b", "c"` },
		]);
	});

	it("P8: resolves a locally-declared `const s: S` past unrelated declarations", () => {
		const code = [
			"type S = 'a' | 'b' | 'c';",
			"declare const deps: { helper: () => void };",
			"declare function pick(): S;",
			"function on(): number {",
			"  const { helper } = deps;",
			"  const other = 1;",
			"  const s: S = pick();",
			"  switch (s) {",
			"    case 'a': return other;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 8, text: 'switch (s) { — union missing case(s): "b", "c"' },
		]);
	});

	it("P9: resolves a union parameter that is not the first parameter", () => {
		const code = [
			"type S = 'a' | 'b' | 'c';",
			"function on(other: number, s: S): number {",
			"  switch (s) {",
			"    case 'a': return other;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (s) { — union missing case(s): "b", "c"' },
		]);
	});

	it("P10: resolves a discriminant declared in an enclosing module block", () => {
		const code = [
			"namespace app {",
			"  type S = 'a' | 'b' | 'c';",
			"  declare const s: S;",
			"  export function on(): number {",
			"    switch (s) {",
			"      case 'a': return 1;",
			"      default: return 0;",
			"    }",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(5);
		expect(out).toEqual([
			{ line: 5, text: 'switch (s) { — union missing case(s): "b", "c"' },
		]);
	});

	it("P11: lists at most three missing tags and then an ellipsis", () => {
		const code = [
			"type Big = 'a' | 'b' | 'c' | 'd' | 'e';",
			"function on(v: Big): number {",
			"  switch (v) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (v) { — union missing case(s): "b", "c", "d", …' },
		]);
		expect(nonNull(out[0]).text).not.toContain('"e"');
	});

	it("P12: reports at most ten findings per file", () => {
		const code = ["type S = 'a' | 'b' | 'c';"]
			.concat(
				Array.from(
					{ length: 14 },
					(_unused, i) =>
						`function f${i}(s: S): number { switch (s) { case 'a': return 1; default: return 0; } }`,
				),
			)
			.join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toHaveLength(10);
		// The cap keeps the FIRST ten switches, in source order.
		expect(out.map((m) => m.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});
});

describe("checkDiscriminatedUnionExhaustiveness — type resolution, negative cases (must not fire)", () => {
	it("N1: ignores a `true | false` literal union (that is just `boolean`)", () => {
		const code = [
			"type Flag = true | false;",
			"function on(b: Flag): number {",
			"  switch (b) {",
			"    case true: return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N2: ignores a union whose members all carry the same discriminant value", () => {
		const code = [
			"type Same = { kind: 'a'; x: number } | { kind: 'a'; y: string };",
			"function on(s: Same): number {",
			"  switch (s.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N3: ignores a member whose discriminant property has no type annotation", () => {
		const code = [
			"type U = { kind } | { kind: 'b' };",
			"function on(u: U): number {",
			"  switch (u.kind) {",
			"    case 'b': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N4: ignores a switch on the whole discriminated-union value", () => {
		// Switching on the value (not `.kind`) is never the bug shape this
		// check targets — the tags live on the discriminant, not the object.
		const code = [
			"type Msg = { kind: 'a'; x: number } | { kind: 'b'; y: string };",
			"function on(m: Msg): number {",
			"  switch (m) {",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N5: ignores property access on an untyped parameter", () => {
		const code = [
			"function on(m): number {",
			"  switch (m.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N6: ignores a call-expression discriminant", () => {
		const code = [
			"declare function getKind(): 'a' | 'b';",
			"function on(): number {",
			"  switch (getKind()) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N7: ignores a type reference that is not a local literal union", () => {
		const code = [
			"interface Opts { kind: string }",
			"function on(o: Opts): number {",
			"  switch (o.kind) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N8: ignores a local const with an inferred (unannotated) type", () => {
		const code = [
			"declare function pick(): 'a' | 'b';",
			"function on(): number {",
			"  const s = pick();",
			"  switch (s) {",
			"    case 'a': return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});
});

// =============================================================================
// `case <expr>:` tag extraction. Every fixture is missing at least one tag, so
// each asserts WHICH tags the extractor did and did not recognize.
// =============================================================================

describe("checkDiscriminatedUnionExhaustiveness — case-expression forms (must fire)", () => {
	it("P1: counts a no-substitution template literal as covering its tag", () => {
		const code = [
			"type Cmd = 'a' | 'b' | 'c';",
			"function run(c: Cmd): number {",
			"  switch (c) {",
			"    case `a`: return 1;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 3, text: 'switch (c) { — union missing case(s): "b", "c"' },
		]);
		expect(nonNull(out[0]).text).not.toContain('"a"');
	});

	it("P2: does not count a non-literal `case CONST:` as covering its tag", () => {
		const code = [
			"declare const A: 'a';",
			"type Cmd = 'a' | 'b';",
			"function run(c: Cmd): number {",
			"  switch (c) {",
			"    case A: return 1;",
			"    case 'b': return 2;",
			"    default: return 0;",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		expect(out).toEqual([
			{ line: 4, text: 'switch (c) { — union missing case(s): "a"' },
		]);
	});

	it("P3: counts a negated numeric literal, and ignores `-ident`", () => {
		const code = [
			"declare const x: number;",
			"type Code = 0 | 1 | 2;",
			"function run(c: Code): string {",
			"  switch (c) {",
			"    case 0: return 'zero';",
			"    case -1: return 'neg';",
			"    case -x: return 'dyn';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		// `-1` parses to the tag "-1", which is not a member of `0 | 1 | 2`, and
		// `-x` is not a literal at all — so 1 and 2 both stay missing.
		expect(out).toEqual([
			{ line: 4, text: "switch (c) { — union missing case(s): 1, 2" },
		]);
	});

	it("P4: a unary-plus case covers only its own tag", () => {
		const code = [
			"type Code = 0 | 1 | 2;",
			"function run(c: Code): string {",
			"  switch (c) {",
			"    case 0: return 'zero';",
			"    case +2: return 'two';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		const out = checkDiscriminatedUnionExhaustiveness(code, TS);
		// `+2` is recognized and normalizes to the tag `2`; only `1` is left.
		expect(out).toEqual([
			{ line: 3, text: "switch (c) { — union missing case(s): 1" },
		]);
	});
});

describe("checkDiscriminatedUnionExhaustiveness — case-expression forms (must not fire)", () => {
	// REGRESSION (source defect fixed this round): `caseExpressionToLiteralTag`
	// recognized `case -1:` but not `case +2:` — both are PrefixUnaryExpressions,
	// and only MinusToken was handled. An exhaustive switch whose last case was
	// written `+2` was therefore reported as missing that member. Deleting the
	// PlusToken arm makes this test fail with
	// `[{line: 3, text: 'switch (c) { — union missing case(s): 2'}]`.
	it("N9: a `case +n:` written for the last tag leaves the switch exhaustive", () => {
		const code = [
			"type Code = 0 | 2;",
			"function run(c: Code): string {",
			"  switch (c) {",
			"    case 0: return 'zero';",
			"    case +2: return 'two';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(code, TS)).toEqual([]);
	});

	it("N10: hex and separator spellings of a tag already normalized correctly", () => {
		const hex = [
			"type Code = 0 | 2;",
			"function run(c: Code): string {",
			"  switch (c) {",
			"    case 0: return 'zero';",
			"    case 0x2: return 'two';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		const separated = [
			"type Code = 0 | 10;",
			"function run(c: Code): string {",
			"  switch (c) {",
			"    case 0: return 'zero';",
			"    case 1_0: return 'ten';",
			"    default: return 'other';",
			"  }",
			"}",
		].join("\n");
		expect(checkDiscriminatedUnionExhaustiveness(hex, TS)).toEqual([]);
		expect(checkDiscriminatedUnionExhaustiveness(separated, TS)).toEqual([]);
	});
});

// =============================================================================
// Default-branch exhaustiveness assertions.
//
// Every fixture below deliberately leaves one tag uncovered (`case A:` uses a
// constant, which the tag extractor cannot resolve) — otherwise the switch is
// fully covered and the default branch is never inspected at all.
// =============================================================================

const DEFAULT_FIXTURE_PRELUDE = [
	"declare const A: 'a';",
	"declare const err: Error;",
	"declare function assertNever(x: never): never;",
	"declare function absurd(x: never): never;",
	"declare function exhaustiveCheck(x: never): void;",
	"declare function makeError(x: unknown): Error;",
	"declare function fallback(x: unknown): number;",
	"declare class UnreachableError extends Error {}",
	"type Cmd = 'a' | 'b';",
	"function run(c: Cmd): number {",
];

/**
 * 1-based line of `switch (c) {` in every `withDefaultBody` fixture. Derived
 * from the prelude so adding a declaration cannot silently desync the pin.
 */
const SWITCH_LINE_IN_DEFAULT_FIXTURE = DEFAULT_FIXTURE_PRELUDE.length + 1;

/** Build a two-member switch with one unresolvable case and the given default. */
function withDefaultBody(defaultBody: string): string {
	return [
		...DEFAULT_FIXTURE_PRELUDE,
		"  switch (c) {",
		"    case A: return 1;",
		"    case 'b': return 2;",
		`    default: ${defaultBody}`,
		"  }",
		"  return -1;",
		"}",
	].join("\n");
}

const ASSERTING_DEFAULTS: Array<[string, string]> = [
	["never-typed declaration", "const _x: never = c;"],
	["never-typed second declarator", "const seen = c, _x: never = c;"],
	["assertNever(...) statement", "assertNever(c);"],
	["exhaustiveCheck(...) statement", "exhaustiveCheck(c);"],
	["return assertNever(...)", "return assertNever(c);"],
	["return absurd(...) alias", "return absurd(c);"],
	["throw assertNever(...)", "throw assertNever(c);"],
	["throw new UnreachableError(...)", "throw new UnreachableError('x');"],
];

const NON_ASSERTING_DEFAULTS: Array<[string, string]> = [
	["throw new Error(...)", "throw new Error('unexpected');"],
	["throw makeError(...)", "throw makeError(c);"],
	["throw of a bare identifier", "throw err;"],
	["return fallback(...)", "return fallback(c);"],
	["declaration typed as something other than never", "const s: string = String(c);"],
	["bare expression statement", "c;"],
	["bare return", "return;"],
	["break", "break;"],
];

describe("checkDiscriminatedUnionExhaustiveness — asserting default branches (must not fire)", () => {
	it.each(ASSERTING_DEFAULTS)("N20: %s suppresses the finding", (_label, body) => {
		expect(checkDiscriminatedUnionExhaustiveness(withDefaultBody(body), TS)).toEqual([]);
	});
});

describe("checkDiscriminatedUnionExhaustiveness — non-asserting default branches (must fire)", () => {
	it.each(NON_ASSERTING_DEFAULTS)("P20: %s is not an exhaustiveness assertion", (_label, body) => {
		const out = checkDiscriminatedUnionExhaustiveness(withDefaultBody(body), TS);
		expect(out).toEqual([
			{ line: SWITCH_LINE_IN_DEFAULT_FIXTURE, text: 'switch (c) { — union missing case(s): "a"' },
		]);
	});
});

// =============================================================================
// File gating: which paths the check even parses.
// =============================================================================

const UNCOVERED_SWITCH = [
	"type S = 'a' | 'b' | 'c';",
	"function on(s: S): number {",
	"  switch (s) {",
	"    case 'a': return 1;",
	"    default: return 0;",
	"  }",
	"}",
].join("\n");

const PARSED_PATHS: Array<[string, string]> = [
	[".ts", "src/lib/mod.ts"],
	[".tsx", "src/ui/Row.tsx"],
	[".mts", "src/lib/mod.mts"],
	[".cts", "src/lib/mod.cts"],
];

const SKIPPED_PATHS: Array<[string, string]> = [
	[".js", "src/lib/mod.js"],
	[".jsx", "src/ui/Row.jsx"],
	[".mjs", "src/lib/mod.mjs"],
	[".md", "docs/notes.md"],
	["extensionless", "src/lib/Makefile"],
	["spec file", "src/lib/mod.spec.ts"],
];

/** The one finding `UNCOVERED_SWITCH` must produce in a parsed .ts-family file. */
const UNCOVERED_SWITCH_FINDING = {
	line: 3,
	text: 'switch (s) { — union missing case(s): "b", "c"',
};

describe("checkDiscriminatedUnionExhaustiveness — file gating", () => {
	it.each(PARSED_PATHS)("P21: parses %s files", (_label, path) => {
		const out = checkDiscriminatedUnionExhaustiveness(UNCOVERED_SWITCH, path);
		expect(out).toEqual([UNCOVERED_SWITCH_FINDING]);
	});

	it.each(SKIPPED_PATHS)("N21: skips %s files", (_label, path) => {
		expect(checkDiscriminatedUnionExhaustiveness(UNCOVERED_SWITCH, path)).toEqual([]);
	});

	it("P22: still reports after the lazily-cached `typescript` handle is reset", () => {
		// Ground truth on BOTH sides, not `toEqual(before)`: a self-comparison
		// passes in exactly the world where the reset bricked the module and both
		// calls return [].
		expect(checkDiscriminatedUnionExhaustiveness(UNCOVERED_SWITCH, TS)).toEqual([
			UNCOVERED_SWITCH_FINDING,
		]);
		__resetTsCacheForTesting();
		expect(checkDiscriminatedUnionExhaustiveness(UNCOVERED_SWITCH, TS)).toEqual([
			UNCOVERED_SWITCH_FINDING,
		]);
	});
});

describe("checkDiscriminatedUnionExhaustiveness — typescript unavailable (must not fire)", () => {
	afterEach(() => {
		vi.doUnmock("node:module");
		vi.resetModules();
	});

	it("N22: returns no findings when the `typescript` package cannot be required", async () => {
		vi.resetModules();
		vi.doMock("node:module", () => ({
			createRequire: () => () => {
				throw new Error("Cannot find module 'typescript'");
			},
		}));
		const mod = await import("./exhaustiveness.js");
		// Same input the .ts gate above reports on — with no parser, nothing fires.
		expect(mod.checkDiscriminatedUnionExhaustiveness(UNCOVERED_SWITCH, TS)).toEqual([]);
		// And the failed load is memoized: a second call is still a no-op.
		mod.__resetTsCacheForTesting();
		expect(mod.checkDiscriminatedUnionExhaustiveness(UNCOVERED_SWITCH, TS)).toEqual([]);
	});
});

// =============================================================================
// Braced default clauses.
//
// REGRESSION (source defect fixed this round): `defaultBranchAssertsNever` used
// to inspect only the TOP-LEVEL statements of the default clause. A braced body
// puts a single Block there, so none of the recognized idioms were seen and the
// check fired on `default: { const _x: never = c; throw … }` — the idiom its own
// `fix_instruction` recommends FIRST. Round 1 pinned that as a "known gap"; it
// is now fixed, and these are ordinary negative cases.
//
// The positives below are the discriminators: block descent must not degrade
// into "any braced default suppresses". Deleting the `ts.isBlock` arm flips the
// N-cases to one finding each; making it unconditional flips the P-cases to [].
// =============================================================================

const BRACED_DEFAULTS: Array<[string, string[]]> = [
	["never-typed declaration", ["const _x: never = c;", "throw new Error('unreachable' + _x);"]],
	["assertNever(...) call", ["assertNever(c);"]],
	["throw new UnreachableError(...)", ["throw new UnreachableError('x');"]],
	["a nested block holding assertNever(...)", ["{", "  assertNever(c);", "}"]],
];

const NON_ASSERTING_BRACED_DEFAULTS: Array<[string, string[]]> = [
	["a plain return", ["return 0;"]],
	["a non-never declaration", ["const s: string = String(c);", "return s.length;"]],
	// Conditional assertions do not count: the branch may not be taken, so the
	// compiler gets no exhaustiveness guarantee from it.
	["an assertion buried in an `if` body", ["if (c) { const _x: never = c; }", "return 0;"]],
];

/** Wrap a default body in braces, indented like the surrounding fixture. */
function bracedDefault(body: string[]): string {
	return withDefaultBody(["{", ...body.map((l) => `      ${l}`), "    }"].join("\n"));
}

describe("checkDiscriminatedUnionExhaustiveness — braced default clause (must not fire)", () => {
	it.each(BRACED_DEFAULTS)("N23: a braced default holding %s suppresses the finding", (_label, body) => {
		expect(checkDiscriminatedUnionExhaustiveness(bracedDefault(body), TS)).toEqual([]);
	});
});

// =============================================================================
// Line terminators — the reported line and the reported snippet must come from
// the SAME line table.
//
// REGRESSION (source defect fixed this round): the snippet was taken from
// `content.split("\n")` while the index came from TypeScript's
// `getLineAndCharacterOfPosition`. TS's scanner also breaks on a lone CR and on
// U+2028 / U+2029, so on such files the index ran past the end of the split view
// and the `?? ""` fallback fired: the finding shipped with an EMPTY snippet
// (`" — union missing case(s): …"`). Round 1 called that fallback unreachable.
// It is reachable from valid, zero-diagnostic TypeScript, as below.
//
// Reverting `sourceLineTexts` to `content.split("\n")` makes every case here
// fail on the missing `switch (s) {` / `export function on…` prefix.
// =============================================================================

const LINE_SEPARATOR = "\u2028";
const PARAGRAPH_SEPARATOR = "\u2029";

/** An LF file whose FIRST line carries `sep` raw inside a string literal. */
function withRawSeparator(sep: string): string {
	return [
		`export const SEP = "${sep}";`,
		"type S = 'a' | 'b' | 'c';",
		"export function on(s: S): number { switch (s) { case 'a': return 1; default: return 0; } }",
	].join("\n");
}

const ONE_LINE_SWITCH_SNIPPET =
	"export function on(s: S): number { switch (s) { case 'a': return 1; default: return 0; } }";

describe("checkDiscriminatedUnionExhaustiveness — exotic line terminators (must fire)", () => {
	const SWITCH_SOURCE_LINES = [
		"type S = 'a' | 'b' | 'c';",
		"export function on(s: S): number {",
		"  switch (s) {",
		"    case 'a': return 1;",
		"    default: return 0;",
		"  }",
		"}",
	];

	it("P24: reports the real source line for a CR-only file", () => {
		const content = SWITCH_SOURCE_LINES.join("\r");
		// `split("\n")` sees ONE line here; TypeScript's line table sees seven.
		expect(content.split("\n")).toHaveLength(1);
		expect(checkDiscriminatedUnionExhaustiveness(content, TS)).toEqual([
			{ line: 3, text: 'switch (s) { — union missing case(s): "b", "c"' },
		]);
	});

	it("P25: reports the real source line for a CRLF file", () => {
		expect(checkDiscriminatedUnionExhaustiveness(SWITCH_SOURCE_LINES.join("\r\n"), TS)).toEqual([
			{ line: 3, text: 'switch (s) { — union missing case(s): "b", "c"' },
		]);
	});

	it("P26: reports the real source line past a raw U+2028 in a string literal", () => {
		expect(checkDiscriminatedUnionExhaustiveness(withRawSeparator(LINE_SEPARATOR), TS)).toEqual([
			{ line: 4, text: `${ONE_LINE_SWITCH_SNIPPET} — union missing case(s): "b", "c"` },
		]);
	});

	it("P27: reports the real source line past a raw U+2029 in a string literal", () => {
		expect(
			checkDiscriminatedUnionExhaustiveness(withRawSeparator(PARAGRAPH_SEPARATOR), TS),
		).toEqual([
			{ line: 4, text: `${ONE_LINE_SWITCH_SNIPPET} — union missing case(s): "b", "c"` },
		]);
	});

	it("P28: LF and CRLF spellings of the same file produce identical findings", () => {
		const lf = checkDiscriminatedUnionExhaustiveness(SWITCH_SOURCE_LINES.join("\n"), TS);
		const crlf = checkDiscriminatedUnionExhaustiveness(SWITCH_SOURCE_LINES.join("\r\n"), TS);
		expect(lf).toEqual([{ line: 3, text: 'switch (s) { — union missing case(s): "b", "c"' }]);
		expect(crlf).toEqual(lf);
	});
});

describe("checkDiscriminatedUnionExhaustiveness — braced non-asserting default (must fire)", () => {
	// Title kept on the opener line: `check-evidence/case-parser.ts` scans line by
	// line, so a title on its own continuation line is counted as ZERO evidence.
	it.each(NON_ASSERTING_BRACED_DEFAULTS)("P23: a braced %s is still reported", (_label, body) => {
		expect(checkDiscriminatedUnionExhaustiveness(bracedDefault(body), TS)).toEqual([
			{
				line: SWITCH_LINE_IN_DEFAULT_FIXTURE,
				text: 'switch (c) { — union missing case(s): "a"',
			},
		]);
	});
});
