// ===========================================
// taste-smell-same-typed-params — adjacent same-typed primitive params
// ===========================================

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkSameTypedPrimitiveParams } from "./taste-smell-same-typed-params.js";

const SRC_PATH = "src/lib/transfer.ts";

describe("checkSameTypedPrimitiveParams", () => {
	it("fires on an exported function with two adjacent same-typed params", () => {
		const content = "export function transfer(fromId: string, toId: string, amount: number) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(1);
		expect(nonNull(matches[0]).text).toContain(
			"2 same-typed string params (fromId, toId) → use branded types or a struct param",
		);
	});

	it("skips test files entirely", () => {
		const content = "export function transfer(fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, "src/lib/transfer.test.ts")).toEqual([]);
	});

	it("skips non-TS extensions", () => {
		const content = "export function transfer(fromId, toId) {}\n";
		expect(checkSameTypedPrimitiveParams(content, "src/lib/transfer.js")).toEqual([]);
	});

	it("does not fire when both names are allowlisted (x, y)", () => {
		const content = "export function setPoint(x: number, y: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire when param types differ at the surface (branded types)", () => {
		const content = "export function foo(a: UserId, b: AccountId) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("fires on an anonymous default-exported function (unnamed capture group)", () => {
		const content = "export default function (foo: string, bar: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(foo, bar)");
	});

	it("caps findings at 10 even when 11+ signatures qualify", () => {
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) {
			lines.push(`export function fn${i}(fromId: string, toId: string) {}`);
		}
		const matches = checkSameTypedPrimitiveParams(lines.join("\n") + "\n", SRC_PATH);
		expect(matches).toHaveLength(10);
	});

	it("flags a public method inside an exported class", () => {
		const content = [
			"export class Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("does not flag private/protected methods or constructors in an exported class", () => {
		const content = [
			"export class Wallet {",
			"  constructor(fromId: string, toId: string) {}",
			"  private transfer(fromId: string, toId: string) {}",
			"  protected move(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not flag methods on a non-exported class", () => {
		const content = ["class Wallet {", "  transfer(fromId: string, toId: string) {}", "}"].join(
			"\n",
		);
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("handles nested parens and generic angle brackets in the param list without a match", () => {
		const content =
			"export function calc(a: string, items: Array<string>, cb: (n: number) => number, b: string) {}\n";
		// a/items/cb/b are pairwise non-adjacent-same-typed; exercises nested-paren
		// and angle-bracket depth tracking in collectParamList without producing a
		// finding.
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("bails out of a param list whose generic nesting exceeds the sanity depth", () => {
		const content = [
			"export function foo(a: A<B<C<D<E<",
			"  string>>>>>, b: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("bails out of a param list that never closes within the line window", () => {
		const openLines = ["export function foo(a: string,"];
		for (let i = 0; i < 25; i++) openLines.push(`  param${i}: string,`);
		const content = openLines.join("\n") + "\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("skips an empty entry produced by a stray double comma", () => {
		const content = "export function foo(fromId: string, , toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("parses object- and array-destructured params as non-primitive (type null)", () => {
		const content =
			"export function foo({ a, b }: T, [c, d]: U, e: string, f: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(e, f)");
	});

	it("falls back to name-only parsing for an untyped param (no colon)", () => {
		const content = "export function foo(a, b: string, c: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(b, c)");
	});

	// ===== allowlist coverage: every allowlisted pair, not just x/y =====
	it("does not fire for the full rgba color allowlist chain", () => {
		const content =
			"export function tint(z: number, r: number, g: number, b: number, a: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire for w/h and width/height allowlist pairs", () => {
		expect(
			checkSameTypedPrimitiveParams("export function sz(w: number, h: number) {}\n", SRC_PATH),
		).toEqual([]);
		expect(
			checkSameTypedPrimitiveParams(
				"export function sz2(width: string, height: string) {}\n",
				SRC_PATH,
			),
		).toEqual([]);
	});

	it("does not fire for the i/j/k index allowlist chain", () => {
		const content = "export function idx(i: number, j: number, k: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire for the lat/lng/lon/long/latitude/longitude allowlist chain", () => {
		const content =
			"export function geo(lat: number, lng: number, lon: number, long: number, latitude: number, longitude: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire for the min/max allowlist pair", () => {
		const content = "export function clamp(min: number, max: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== class-scope open regex boundary conditions =====
	it("does not open class scope from an embedded (not line-start) 'export class'", () => {
		const content = [
			"noop(); export class Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not open class scope when 'export' is merely a word suffix (no separating space)", () => {
		const content = [
			"notexport class Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("opens class scope across multiple spaces after export/default/abstract/class", () => {
		const content = [
			"export  class Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("opens class scope for an exported default class with multiple spaces after default", () => {
		const content = [
			"export default  class Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("opens class scope for an exported abstract class with multiple spaces after abstract", () => {
		const content = [
			"export abstract  class Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("opens class scope with multiple spaces between 'class' and the class name", () => {
		const content = [
			"export class  Wallet {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	// ===== class-scope close tracking (brace counting) =====
	it("closes an exported class's scope so a later non-exported class's methods are not flagged", () => {
		const content = [
			"export class Wallet {",
			"  private helper() {}",
			"}",
			"class Internal {",
			"  public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== method regex boundary conditions =====
	it("flags a bare method with no modifier keyword inside an exported class", () => {
		const content = ["export class Wallet {", "  transfer(fromId: string, toId: string) {}", "}"].join(
			"\n",
		);
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags a static method with multiple spaces after the static modifier", () => {
		const content = [
			"export class Wallet {",
			"  static  transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags an async method with multiple spaces after the async modifier", () => {
		const content = [
			"export class Wallet {",
			"  async  transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags a readonly-modified method with multiple spaces after readonly", () => {
		const content = [
			"export class Wallet {",
			"  readonly  transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags a public method with multiple spaces after the public modifier", () => {
		const content = [
			"export class Wallet {",
			"  public  transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags a method name with multi-char generics and a space before the paren", () => {
		const content = [
			"export class Wallet {",
			"  public transfer<TFoo> (fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags a method whose name would falsely satisfy an unanchored getter check (space before paren)", () => {
		const content = [
			"export class Wallet {",
			"  public widget (fromId: string, toId: string) {}",
			"}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("flags a method whose name embeds a control-flow keyword as a substring (e.g. renew)", () => {
		const content = ["export class Wallet {", "  public renew(fromId: string, toId: string) {}", "}"].join(
			"\n",
		);
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("does not flag a control-flow-shaped line even when it looks like a param list", () => {
		const content = [
			"export class Wallet {",
			"  if (fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== findFirstSameTypedPair guard conditions =====
	it("does not fire when both adjacent params are destructured (double-null guard)", () => {
		const content = "export function foo({ a, b }: T, [c, d]: U) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire when adjacent params have different primitive types (string vs number)", () => {
		const content = "export function foo(fromId: string, count: number) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== non-TS extension gate =====
	it("does not fire on a non-TS extension even with TS-shaped syntax", () => {
		const content = "export function transfer(fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, "src/lib/transfer.js")).toEqual([]);
	});

	it("fires on a .tsx file", () => {
		const content = "export function transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, "src/lib/Transfer.tsx");
		expect(matches).toHaveLength(1);
	});

	it("fires on a .mts file", () => {
		const content = "export function transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, "src/lib/transfer.mts");
		expect(matches).toHaveLength(1);
	});

	it("fires on a .cts file", () => {
		const content = "export function transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, "src/lib/transfer.cts");
		expect(matches).toHaveLength(1);
	});

	// ===== finding text: exact source-line preview (trim + slice(0,100)) =====
	it("includes the exact pair description and full source line for a short signature", () => {
		const content = "export function transfer(fromId: string, toId: string, amount: number) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toEqual([
			{
				line: 1,
				text: "[2 same-typed string params (fromId, toId) → use branded types or a struct param] export function transfer(fromId: string, toId: string, amount: number) {}",
			},
		]);
	});

	it("trims leading whitespace and truncates the source-line preview to 100 chars", () => {
		const rawLine =
			"   export function transferWithAnExtremelyLongNameForPaddingPurposesOnlyHereYes(fromId: string, toId: string) {}";
		const content = `${rawLine}\n`;
		const expectedPreview = rawLine.trim().slice(0, 100);
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toEqual([
			{
				line: 1,
				text: `[2 same-typed string params (fromId, toId) → use branded types or a struct param] ${expectedPreview}`,
			},
		]);
	});

	// ===== collectParamList: nested bracket handling =====
	// Note: single-letter names in SAME_TYPED_NAME_ALLOWLIST (a, b, g, x, y, ...)
	// are deliberately avoided below as the trailing "should fire" pair — using
	// them would make the pair exempt and silently defeat the assertion.
	it("correctly parses params after a nested-paren grouped type", () => {
		const content =
			"export function calc(cb: (p: number, q: number), fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("correctly parses a two-line-wrapped signature (line-join separator matters)", () => {
		const content = "export function foo(fromId: string,\n  toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("keeps a line-wrapped type annotation from silently merging across the join", () => {
		const content = "export function foo(fromId: stri\nng, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("splits top-level params correctly after a closed generic (angle depth returns to zero)", () => {
		const content =
			"export function calc(m: Map<string, string>, fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("splits top-level params correctly after a closed inline object type (brace depth returns to zero)", () => {
		const content =
			"export function calc(m: { p: string, q: string }, fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("splits top-level params correctly after a closed tuple type (bracket depth returns to zero)", () => {
		const content =
			"export function calc(m: [string, string], fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("splits top-level params correctly after a closed paren-grouped type (paren depth returns to zero)", () => {
		const content =
			"export function calc(m: (p: number, q: number), fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	// ===== collectParamList sanity-depth bail-out boundary (exactly at cap vs one over) =====
	it("bails out when angle-generic nesting exceeds the sanity depth (would otherwise match)", () => {
		const content = [
			"export function calc(m: A<B<C<D<E<",
			"  string>>>>>, fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not bail when angle-generic nesting is exactly at the sanity cap (not exceeding)", () => {
		const content = [
			"export function calc(m: A<B<C<D<",
			"  string>>>>, fromId: string, toId: string) {}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("bails out when brace nesting in an inline object type exceeds the sanity depth", () => {
		const content = [
			"export function calc(cb: () => { p: { q: { r: { s: { t: {",
			"  u: string } } } } } }, fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("bails out when bracket nesting in a synthetic array type exceeds the sanity depth", () => {
		const content = [
			"export function calc(m: T[[[[[",
			"  string]]]]], fromId: string, toId: string) {}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== collectParamList 20-line window boundary =====
	it("bails when the signature closes exactly one line past the 20-line scan window", () => {
		const openLines = ["export function foo(m: string,"];
		for (let i = 0; i < 19; i++) openLines.push(`  p${i}: string,`);
		openLines.push("  fromId: string, toId: string) {}");
		const content = `${openLines.join("\n")}\n`;
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not silently extend the scan window past 20 lines when unclosed", () => {
		const openLines = ["export function foo(m: string,"];
		for (let i = 0; i < 22; i++) openLines.push(`  param${i}: string,`);
		openLines.push("  fromId: string, toId: string) {}");
		const content = `${openLines.join("\n")}\n`;
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== collectParamList startCol: only the FIRST scanned line should use openIdx =====
	it("scans continuation lines from column 0, not from the first line's paren column", () => {
		const content = [
			"export function calcWithAVeryLongNameForPaddingIndeed(m: string,",
			"fromId: string, toId: string) {}",
		].join("\n");
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	// ===== classifyParamEntry: rest-param detection must be anchored =====
	it("does not misclassify a typed param as rest when '...' appears in a default value", () => {
		const content =
			"export function foo(fromId: string = foo(...args), toId: string = bar(...args2)) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	// ===== classifyParamEntry: constructor-parameter-property modifier prefixes =====
	it("strips a constructor-property-style modifier prefix before classifying the param", () => {
		const content = "export function foo(public fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("requires the full modifier keyword plus whitespace, not a truncated prefix", () => {
		const content = "export function foo(public  fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	// ===== EXPORTED_FUNCTION_PATTERNS[0]: `export function name(...)` boundary conditions =====
	it("does not fire on an embedded (not line-start) 'export function'", () => {
		const content = "noop(); export function transfer(fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire when 'export' is merely a word suffix with no separating space", () => {
		const content = "notexport function transfer(fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("fires across multiple spaces after 'export'", () => {
		const content = "export  function transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on an exported async function with a single space after async", () => {
		const content = "export async function transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on an exported async function with multiple spaces after async", () => {
		const content = "export async  function transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires across multiple spaces after 'function'", () => {
		const content = "export function  transfer(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires when there is a space between the function name and the paren", () => {
		const content = "export function transfer (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on an exported function with a multi-char generic type parameter", () => {
		const content = "export function transfer<TFoo>(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires with a multi-char generic and a space before the paren", () => {
		const content = "export function transfer<TFoo> (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	// ===== EXPORTED_FUNCTION_PATTERNS[1]: `export default function name?(...)` boundary conditions =====
	it("does not fire on an embedded (not line-start) 'export default function'", () => {
		const content = "noop(); export default function (fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire when 'export' is merely a word suffix before 'default function'", () => {
		const content = "notexport default function (fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("fires across multiple spaces between 'export' and 'default'", () => {
		const content = "export  default function (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires across multiple spaces between 'default' and 'function'", () => {
		const content = "export default  function (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a default-exported async function with a single space after async", () => {
		const content = "export default async function (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a default-exported async function with multiple spaces after async", () => {
		const content = "export default async  function (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a NAMED default export with multiple spaces after 'function'", () => {
		const content = "export default function  namedFn(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a named default export (word-char capture group, not the negated class)", () => {
		const content = "export default function namedFn(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a named default export with a space before the paren", () => {
		const content = "export default function namedFn (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a named default export with a multi-char generic type parameter", () => {
		const content = "export default function namedFn<TFoo>(fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a named default export with a multi-char generic and a space before the paren", () => {
		const content = "export default function namedFn<TFoo> (fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	// ===== EXPORTED_FUNCTION_PATTERNS[2]: `export const name = (...)` boundary conditions =====
	it("fires on an exported const arrow function with no type annotation", () => {
		const content = "export const transfer = (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("does not fire on an embedded (not line-start) 'export const ... ='", () => {
		const content = "noop(); export const transfer = (fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not fire when 'export' is merely a word suffix before 'const'", () => {
		const content = "notexport const transfer = (fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("fires across multiple spaces after 'export' for a const arrow function", () => {
		const content = "export  const transfer = (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires across multiple spaces between 'const' and the name", () => {
		const content = "export const  transfer = (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on a let/var-declared exported arrow function too", () => {
		const letMatches = checkSameTypedPrimitiveParams(
			"export let transfer = (fromId: string, toId: string) => {};\n",
			SRC_PATH,
		);
		expect(letMatches).toHaveLength(1);
		const varMatches = checkSameTypedPrimitiveParams(
			"export var transfer = (fromId: string, toId: string) => {};\n",
			SRC_PATH,
		);
		expect(varMatches).toHaveLength(1);
	});

	it("fires across multiple spaces before '=' with no type annotation", () => {
		const content = "export const transfer  = (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on an exported const arrow function with a type annotation", () => {
		const content = "export const transfer: TransferFn = (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires across multiple spaces around '=' with a type annotation present", () => {
		const content =
			"export const transfer: TransferFn  =  (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on an exported async const arrow function with a single space after async", () => {
		const content = "export const transfer = async (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	it("fires on an exported async const arrow function with multiple spaces after async", () => {
		const content = "export const transfer = async  (fromId: string, toId: string) => {};\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
	});

	// ===== classifyParamEntry: private/protected/readonly modifier prefixes =====
	it("strips a 'private' constructor-property-style modifier prefix", () => {
		const content = "export function foo(private fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("strips a 'protected' constructor-property-style modifier prefix", () => {
		const content = "export function foo(protected fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("strips a 'readonly' constructor-property-style modifier prefix", () => {
		const content = "export function foo(readonly fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	// ===== classifyParamEntry: number and boolean surface-type recognition =====
	it("fires on two adjacent non-allowlisted number-typed params", () => {
		const content = "export function foo(count: number, total: number) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain(
			"2 same-typed number params (count, total) → use branded types or a struct param",
		);
	});

	it("fires on two adjacent boolean-typed params", () => {
		const content = "export function foo(isActive: boolean, isEnabled: boolean) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain(
			"2 same-typed boolean params (isActive, isEnabled) → use branded types or a struct param",
		);
	});

	it("requires the full 'private' keyword plus whitespace, not a truncated prefix", () => {
		const content = "export function foo(private  fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("requires the full 'protected' keyword plus whitespace, not a truncated prefix", () => {
		const content = "export function foo(protected  fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("requires the full 'readonly' keyword plus whitespace, not a truncated prefix", () => {
		const content = "export function foo(readonly  fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("does not match a public-method signature embedded after an unrelated leading statement", () => {
		const content = [
			"export class Wallet {",
			"  1; public transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	// ===== mutation-hardening: parser state and regex boundaries =====
	it("requires the complete exported class identifier before entering class scope", () => {
		const content = [
			"export class Wallet {",
			"  transfer(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toHaveLength(1);
	});

	it("handles an empty grouped type before a real pair", () => {
		const content =
			"export function run(callback: (), fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toHaveLength(1);
	});

	it("keeps commas inside a generic type out of the top-level parameter split", () => {
		const content =
			"export function run(values: Map<string, string>, fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("keeps commas inside an inline object type out of the top-level split", () => {
		const content =
			"export function run(options: { first: string; second: string }, fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("keeps commas inside a tuple type out of the top-level split", () => {
		const content =
			"export function run(values: [string, string], fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("accepts exactly four levels of inline-object nesting", () => {
		const content =
			"export function run(value: { a: { b: { c: { d: string } } } }, fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("accepts exactly four levels of tuple nesting", () => {
		const content =
			"export function run(value: T[][][][], fromId: string, toId: string) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("rejects a parameter entry with junk before the name instead of matching its suffix", () => {
		const content = "export function run(junk fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("rejects punctuation in a parameter name rather than accepting it as a primitive", () => {
		const content = "export function run(fromId!: string, toId!: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("trims surrounding annotation whitespace before recognizing a primitive", () => {
		const content = "export function run(fromId:    string   , toId:    string   ) {}\n";
		const matches = checkSameTypedPrimitiveParams(content, SRC_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("(fromId, toId)");
	});

	it("does not treat a method literally named private as a public method", () => {
		const content = [
			"export class Wallet {",
			"  private(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("does not treat a method name with punctuation as a public method", () => {
		const content = [
			"export class Wallet {",
			"  transfer! (fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("recognizes a bare get method while preserving the getter exclusion boundary", () => {
		const content = [
			"export class Wallet {",
			"  get(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toHaveLength(1);
	});

	it("recognizes a bare set method while preserving the setter exclusion boundary", () => {
		const content = [
			"export class Wallet {",
			"  set(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toHaveLength(1);
	});

	it("does not treat a control-flow keyword as a public method", () => {
		const content = [
			"export class Wallet {",
			"  if(fromId: string, toId: string) {}",
			"}",
		].join("\n");
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("requires a valid exported function name boundary", () => {
		const content = "export function transfer! (fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("requires a valid named default-export function boundary", () => {
		const content = "export default function transfer! (fromId: string, toId: string) {}\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toEqual([]);
	});

	it("requires whitespace after an arrow type annotation colon", () => {
		const content =
			"export const transfer:TransferFn = (fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toHaveLength(1);
	});

	it("requires whitespace before an arrow assignment equals sign", () => {
		const content =
			"export const transfer=(fromId: string, toId: string) => {};\n";
		expect(checkSameTypedPrimitiveParams(content, SRC_PATH)).toHaveLength(1);
	});
});
