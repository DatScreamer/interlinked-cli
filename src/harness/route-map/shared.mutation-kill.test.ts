// Mutation-kill hardening for src/harness/route-map/shared.ts — PASS-1, W6 residue.
// Targets the manifest's `survived` set (regex anchor/quantifier precision, loop-bound
// off-by-ones) plus direct-call coverage for four functions the isolated per-file mutation
// run never exercised (they're only reached indirectly through sibling adapters' own test
// files, which are outside this run's file scope). Contract: scratch/fleet-r3/CONTRACT-W6.md
// LEAN MODE. Expected values for every case here were computed by running the pristine
// (unmutated) logic directly — see scratch/fleet-r3/verify-w6-shared-p1w20*.mjs.

import { describe, expect, it } from "vitest";

import {
	conventionPath,
	extractPathParams,
	findHandlerSymbol,
	findMethodExportLine,
	hasExportedMethod,
	isInsideStringLiteral,
	lineNumberAt,
	sniffInlineHandlerSymbol,
} from "./shared.js";

describe("conventionPath — regex anchor precision", () => {
	// test-contract: boundary — the [...slug] pattern's leading `^` must require the match at
	// the true segment start; without it, a substring match would slice the segment wrongly.
	it("leaves a segment with junk before [...slug] unchanged", () => {
		expect(conventionPath("weird[...slug]")).toBe("/weird[...slug]");
	});
	// test-contract: boundary — the [...slug] pattern's trailing `$` must require the match to
	// reach the true segment end; without it, trailing junk would be silently accepted.
	it("leaves a [...slug]-prefixed segment with trailing junk unchanged", () => {
		expect(conventionPath("[...slug]extra")).toBe("/[...slug]extra");
	});
	// test-contract: boundary — same leading-anchor precision for the [id] convention.
	it("leaves a segment with junk before [id] unchanged", () => {
		expect(conventionPath("pre[id]")).toBe("/pre[id]");
	});
	// test-contract: boundary — same trailing-anchor precision for the [id] convention.
	it("leaves an [id]-prefixed segment with trailing junk unchanged", () => {
		expect(conventionPath("[id]extra")).toBe("/[id]extra");
	});
	// test-contract: boundary — same leading-anchor precision for the (group) convention; a
	// missing leading anchor would null out a segment that merely CONTAINS "(group)".
	it("leaves a segment with junk before (group) unchanged", () => {
		expect(conventionPath("pre(group)")).toBe("/pre(group)");
	});
	// test-contract: boundary — same trailing-anchor precision for the (group) convention.
	it("leaves a (group)-prefixed segment with trailing junk unchanged", () => {
		expect(conventionPath("(group)extra")).toBe("/(group)extra");
	});
});

describe("extractPathParams — catch-all group precision", () => {
	// test-contract: public-api — a multi-character [...slug] param name must be captured in
	// full; a single-char or non-word capture group would fail to match this at all (empty []).
	it("captures the full multi-character name from a [...slug] segment", () => {
		expect(extractPathParams("/blog/[...slug]")).toEqual([{ name: "slug", source: "path" }]);
	});
});

describe("lineNumberAt — loop-bound precision", () => {
	// test-contract: boundary — the offset stops counting exactly AT the boundary; widening
	// either loop guard (the offset bound or the content.length bound) would pull in the
	// newline at index 2 and report line 2 instead of 1.
	it("does not count a newline exactly at the offset boundary", () => {
		expect(lineNumberAt("ab\ncd", 2)).toBe(1);
	});
});

describe("findHandlerSymbol — idx clamp and lookback window", () => {
	// test-contract: boundary — idx must clamp via Math.min(lines.length-1, ...), not
	// lines.length+1; an inflated idx shifts the lookback window's lower bound up by the same
	// amount, missing a symbol that is still within the true window.
	it("finds a symbol within the true lookback window when routeLine is far past EOF", () => {
		const lines = Array.from({ length: 10 }, (_, i) =>
			i === 4 ? "const targetFn = () => {};" : "// noise",
		);
		expect(findHandlerSymbol(lines.join("\n"), 1000, { lookbackLines: 5 })).toBe("targetFn");
	});

	// test-contract: invariant — the python forward-scan only runs when language is actually
	// "python"; the language check must not be short-circuited to always-true for the default
	// ("ts") caller.
	it("does not take the python forward-scan path for the default ts language", () => {
		expect(findHandlerSymbol("def readItem(id):\n    pass", 1)).toBeUndefined();
	});

	// test-contract: boundary — the python forward-scan's own upper bound is a MIN of
	// lines.length and idx+10; flipping it to MAX (or admitting an off-by-one) would let the
	// scan reach a symbol placed just past the true 10-line window.
	it("does not scan past the true 10-line python forward window", () => {
		const lines = Array.from({ length: 15 }, (_, i) =>
			i === 10 ? "def targetFn(x):" : "# noise",
		);
		expect(findHandlerSymbol(lines.join("\n"), 1, { language: "python" })).toBeUndefined();
	});

	describe("python def regex", () => {
		// test-contract: boundary — the leading `^\s*` anchor requires the match at the true
		// line start; without it, a "def"-shaped substring after junk would still match.
		it("does not match a def-shaped substring preceded by other text", () => {
			expect(
				findHandlerSymbol("xdef readItem(id):\n    return {}", 1, { language: "python" }),
			).toBeUndefined();
		});
		// test-contract: boundary — `(?:async\s+)?` must stay optional; a plain def line with no
		// async prefix must still match.
		it("matches a plain def with no async prefix", () => {
			expect(
				findHandlerSymbol("def readItem(id: int):\n    return {}", 1, { language: "python" }),
			).toBe("readItem");
		});
		// test-contract: boundary — `async\s+` must consume one-or-more spaces, not exactly one.
		it("matches async def across a double space after async", () => {
			expect(
				findHandlerSymbol("async  def readItem(id: int):\n    pass", 1, { language: "python" }),
			).toBe("readItem");
		});
		// test-contract: boundary — `def\s+` must consume one-or-more spaces, not exactly one.
		it("matches def across a double space before the name", () => {
			expect(
				findHandlerSymbol("def  readItem(id: int):\n    pass", 1, { language: "python" }),
			).toBe("readItem");
		});
		// test-contract: boundary — `\s*\(` before the paren must allow a space there.
		it("matches when there is a space before the opening paren", () => {
			expect(
				findHandlerSymbol("def readItem (id: int):\n pass", 1, { language: "python" }),
			).toBe("readItem");
		});
	});

	describe("export default function pattern", () => {
		// test-contract: boundary — leading `^\s*` anchor precision for this pattern.
		it("does not match export-default-function preceded by junk", () => {
			expect(findHandlerSymbol("xexport default function GET(req) {\n}", 1)).toBeUndefined();
		});
		// test-contract: boundary — every \s+ gap in this pattern (export, default, async,
		// function) must accept 2+ spaces, not exactly one.
		it("matches export default async function across doubled internal spaces", () => {
			expect(findHandlerSymbol("export  default  async  function  GET(req) {\n}", 1)).toBe(
				"GET",
			);
		});
		// test-contract: boundary — `async\s+` must not require a non-whitespace char right
		// after "async" (that would reject real single-space spacing).
		it("matches export default async function with normal single spacing", () => {
			expect(findHandlerSymbol("export default async function GET(req) {\n}", 1)).toBe("GET");
		});
	});

	describe("export function pattern (no default)", () => {
		// test-contract: boundary — leading `^\s*` anchor precision for this pattern (distinct
		// site from the export-default-function pattern above).
		it("does not match export-function preceded by junk", () => {
			expect(findHandlerSymbol("xexport function POST(req) {\n}", 1)).toBeUndefined();
		});
		// test-contract: boundary — leading `^\s*` must accept 2+ leading spaces, not exactly one.
		it("matches export function with two leading spaces", () => {
			expect(findHandlerSymbol("  export function POST(req) {\n}", 1)).toBe("POST");
		});
		// test-contract: boundary — export/async/function gaps in this pattern must each accept
		// 2+ spaces, not exactly one.
		it("matches export async function across doubled internal spaces", () => {
			expect(findHandlerSymbol("export  async  function  POST(req) {\n}", 1)).toBe("POST");
		});
		// test-contract: public-api — the plain documented case (export function NAME, normal
		// spacing, no default, no async) must resolve exactly; also pins the capture group to
		// `\w+` (full name) and the trailing async group to genuinely optional.
		it("matches a plain export function with normal spacing", () => {
			expect(findHandlerSymbol("export function POST(req) {\n}", 1)).toBe("POST");
		});
		// test-contract: boundary — `async\s+` must not require a non-whitespace char right
		// after "async" (that would reject real single-space spacing).
		it("matches export async function with normal single spacing", () => {
			expect(findHandlerSymbol("export async function POST(req) {\n}", 1)).toBe("POST");
		});
	});

	describe("export const/let/var pattern", () => {
		// test-contract: boundary — leading `^\s*` anchor precision for this pattern.
		it("does not match export-const preceded by junk", () => {
			expect(findHandlerSymbol("xexport const listUsers = () => {};", 1)).toBeUndefined();
		});
		// test-contract: boundary — leading `^\s*` must accept 2+ leading spaces, not exactly one.
		it("matches export const with two leading spaces", () => {
			expect(findHandlerSymbol("  export const listUsers = () => {};", 1)).toBe("listUsers");
		});
		// test-contract: boundary — export/const gaps in this pattern must each accept 2+
		// spaces, not exactly one.
		it("matches export const across doubled internal spaces", () => {
			expect(findHandlerSymbol("export  const  listUsers = () => {};", 1)).toBe("listUsers");
		});
		// test-contract: public-api — plain export const, normal spacing; also pins the capture
		// group to full `\w+` and the trailing async group to genuinely optional.
		it("matches a plain export const with normal spacing", () => {
			expect(findHandlerSymbol("export const listUsers = () => {};", 1)).toBe("listUsers");
		});
		// test-contract: boundary — `\s*=` must accept ZERO spaces before "=", not require
		// exactly one.
		it("matches export const with no space before the equals sign", () => {
			expect(findHandlerSymbol("export const listUsers=() => {};", 1)).toBe("listUsers");
		});
	});

	describe("plain function pattern (no export)", () => {
		// test-contract: boundary — leading `^\s*` anchor precision for this pattern.
		it("does not match a plain function preceded by junk", () => {
			expect(findHandlerSymbol("xfunction handleGet() {}", 1)).toBeUndefined();
		});
		// test-contract: boundary — async/function gaps must each accept 2+ spaces.
		it("matches async function across doubled internal spaces", () => {
			expect(findHandlerSymbol("async  function  handleGet() {}", 1)).toBe("handleGet");
		});
		// test-contract: boundary — `async\s+` must not require a non-whitespace char after
		// "async".
		it("matches async function with normal single spacing", () => {
			expect(findHandlerSymbol("async function handleGet() {}", 1)).toBe("handleGet");
		});
	});

	describe("plain const/let/var pattern (no export)", () => {
		// test-contract: boundary — leading `^\s*` anchor precision for this pattern.
		it("does not match a plain const preceded by junk", () => {
			expect(findHandlerSymbol("xconst fetchData = async () => {};", 1)).toBeUndefined();
		});
		// test-contract: boundary — the const/let/var keyword gap must accept 2+ spaces.
		it("matches plain const across a doubled internal space", () => {
			expect(findHandlerSymbol("const  fetchData = async () => {};", 1)).toBe("fetchData");
		});
		// test-contract: boundary — `\s*=` must accept ZERO spaces before "=".
		it("matches plain const with no space before the equals sign", () => {
			expect(findHandlerSymbol("const fetchData=async () => {};", 1)).toBe("fetchData");
		});
	});
});

describe("sniffInlineHandlerSymbol — inline capture vs findHandlerSymbol fallback", () => {
	// test-contract: public-api — when the line has an inline `fn("path", ident)` call, that
	// capture wins over whatever findHandlerSymbol would resolve from content.
	it("prefers the inline capture over the content fallback", () => {
		const line = 'router.post("/y", createY)';
		const content = 'function unrelated() {}\nrouter.post("/y", createY)';
		expect(sniffInlineHandlerSymbol(line, content, 2)).toBe("createY");
	});

	// test-contract: boundary — the fallback offset passed to findHandlerSymbol is
	// lineNumber-1, not lineNumber+1; the two starting points resolve to different symbols
	// here (a higher starting index hits "lower" before ever reaching "upper").
	it("passes lineNumber-1 (not +1) to the content fallback", () => {
		const content = "function upper() {}\nsome noise\nfunction lower() {}\nmore noise";
		expect(sniffInlineHandlerSymbol("some noise", content, 2)).toBe("upper");
	});

	describe("inline regex precision", () => {
		// test-contract: public-api — the documented shape fn("path", ident) resolves to the
		// identifier exactly, across quote style and trailing terminator.
		it("captures the identifier for a double-quoted call ending in a paren", () => {
			expect(sniffInlineHandlerSymbol('app.get("/users", getUser)', "", 1)).toBe("getUser");
		});
		// test-contract: boundary — the `(?:[),]|$)` alternation's `$` branch must still apply
		// when the line simply ends after the identifier (no trailing paren or comma).
		it("captures the identifier when the line ends right after the identifier", () => {
			expect(sniffInlineHandlerSymbol('x("/z", handlerZ', "", 1)).toBe("handlerZ");
		});
		// test-contract: boundary — the quote-class `["'`]` must include the backtick, not only
		// the two ASCII quote characters.
		it("captures the identifier for a backtick-quoted path", () => {
			expect(sniffInlineHandlerSymbol("app.get(`/w`, handlerW)", "", 1)).toBe("handlerW");
		});
		// test-contract: boundary — `\s*,` must accept a space before the comma, not require
		// zero-width there.
		it("captures the identifier when there is a space before the comma", () => {
			expect(sniffInlineHandlerSymbol('app.get("/v" , handlerV)', "", 1)).toBe("handlerV");
		});
		// test-contract: boundary — `,\s*` must accept ZERO spaces after the comma, not require
		// exactly one.
		it("captures the identifier with no space after the comma", () => {
			expect(sniffInlineHandlerSymbol('app.get("/a",handlerTight)', "", 1)).toBe(
				"handlerTight",
			);
		});
		// test-contract: boundary — the trailing `\s*` before the terminator must accept a
		// space, not require zero-width (non-whitespace) there.
		it("captures the identifier when there is a space before the closing paren", () => {
			expect(sniffInlineHandlerSymbol('app.get("/a", handlerSpace )', "", 1)).toBe(
				"handlerSpace",
			);
		});
		// test-contract: boundary — the opening quote-class requires an ACTUAL quote char to
		// start the match; a single-char quoted argument leaves no leftover content char for a
		// negated class to "restart" on, so a mutant there loses the match entirely.
		it("still captures the identifier when the quoted argument is a single character", () => {
			expect(sniffInlineHandlerSymbol('app.get("x", getUser)', "", 1)).toBe("getUser");
		});
	});
});

describe("isInsideStringLiteral — quote parity on the current line", () => {
	// test-contract: public-api — a position inside a double-quoted string (odd doubleQ, even
	// singleQ) is reported true.
	it("reports true when the offset sits after an odd number of double quotes", () => {
		const content = "const docs = \"use app.get('/x', h) like this\";";
		const offset = content.indexOf("app.get");
		expect(isInsideStringLiteral(offset, content)).toBe(true);
	});
	// test-contract: public-api — a position before any quote on the line is reported false.
	it("reports false before any quote on the line", () => {
		const content = 'const docs = "use this";';
		const offset = content.indexOf("const") + 2;
		expect(isInsideStringLiteral(offset, content)).toBe(false);
	});
	// test-contract: boundary — an odd singleQ count (even doubleQ) independently drives true —
	// pins the `||` (not `&&`) between the two parity checks.
	it("reports true when the offset sits after an odd number of single quotes", () => {
		const content = "x = 'hello world";
		expect(isInsideStringLiteral(content.length, content)).toBe(true);
	});
	// test-contract: public-api — a closed single-quoted string (even count) is reported false.
	it("reports false after a closed single-quoted string", () => {
		const content = "x = 'hello' + y";
		expect(isInsideStringLiteral(content.length, content)).toBe(false);
	});
	// test-contract: boundary — an escaped quote must not flip parity; removing (or inverting)
	// the backslash-skip would count it and misclassify the position.
	it("does not count a backslash-escaped quote toward parity", () => {
		const content = 'x = "a\\"b" + y';
		const offset = content.indexOf("b");
		expect(isInsideStringLiteral(offset, content)).toBe(true);
	});
	// test-contract: invariant — quote counting is scoped to the CURRENT line only; a quote
	// opened on a previous line must not leak into this line's parity.
	it("does not let an unterminated quote on a previous line leak into this line", () => {
		const content = 'const a = "unterminated\nconst b = 1;';
		const offset = content.indexOf("b = 1");
		expect(isInsideStringLiteral(offset, content)).toBe(false);
	});
	// test-contract: boundary — globalOffset 0 (lastIndexOf("\n", -1) sentinel) must not throw
	// and must report false for a quote-free line.
	it("reports false at offset 0 with no quotes", () => {
		expect(isInsideStringLiteral(0, "abc")).toBe(false);
	});
	// test-contract: boundary — the last line of content (no trailing newline, lineEnd === -1)
	// must still be sliced correctly, not include a phantom next line.
	it("handles the last line of content with no trailing newline", () => {
		const content = 'first\nsecond "open';
		expect(isInsideStringLiteral(content.length, content)).toBe(true);
	});
	// test-contract: boundary — both doubleQ and singleQ odd simultaneously still reports true
	// (both operands of the `||`, not just one, independently confirmed true here).
	it("reports true when both double and single quote parity are odd", () => {
		const content = "x = \"a' + y";
		expect(isInsideStringLiteral(content.length, content)).toBe(true);
	});
});

describe("findMethodExportLine — match/no-match branching", () => {
	// test-contract: public-api — a real match resolves to the correct 1-indexed line number;
	// also pins the "m" regex flag (multiline `^`) since the target line is not the very start
	// of content.
	it("resolves the correct line for a real match on a later line", () => {
		expect(findMethodExportLine("line0\nexport async function GET() {}\nline2", "GET")).toBe(2);
	});
	// test-contract: boundary — when there is no match, the function returns undefined without
	// throwing (guards an inverted !m check that would proceed to read m.index on null).
	it("returns undefined without throwing when there is no match", () => {
		expect(findMethodExportLine("line0\nline1", "GET")).toBeUndefined();
	});
});

describe("hasExportedMethod — regex gap precision", () => {
	// test-contract: public-api — the documented positive case: a real exported HTTP-method
	// handler is detected (also the baseline the BlockStatement mutant fails: {} → undefined).
	it("returns true for a documented export function", () => {
		expect(hasExportedMethod("export function GET() {}")).toBe(true);
	});
	// test-contract: public-api — the documented negative case: no export of a method name.
	it("returns false when there is no exported method", () => {
		expect(hasExportedMethod("const x = 1;")).toBe(false);
	});
	// test-contract: boundary — `export\s+` and the `(function|const|let)\s+` gap must accept
	// real single-space spacing, not require a non-whitespace character there.
	it("returns true for export const with normal single spacing (no async)", () => {
		expect(hasExportedMethod("export const POST = 1;")).toBe(true);
	});
	// test-contract: boundary — both of those gaps must accept 2+ spaces, not exactly one.
	it("returns true for export const across doubled internal spaces (no async)", () => {
		expect(hasExportedMethod("export  const  POST = 1;")).toBe(true);
	});
	// test-contract: boundary — `async\s+` must not require a non-whitespace char after
	// "async" (that would reject real single-space spacing).
	it("returns true for export async function with normal single spacing", () => {
		expect(hasExportedMethod("export async function GET() {}")).toBe(true);
	});
	// test-contract: boundary — `async\s+` must consume 2+ spaces, not exactly one.
	it("returns true for export async function across a doubled space after async", () => {
		expect(hasExportedMethod("export async  function GET() {}")).toBe(true);
	});
});
