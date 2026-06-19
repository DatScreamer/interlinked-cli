import { describe, expect, it } from "vitest";
import {
	extractTemplateInterpolationExpressions,
	stripComments,
	stripLiteralsKeepComments,
	stripRegexLiterals,
	stripStringLiterals,
	stripTemplateLiterals,
} from "./strip-helpers.js";

// Behavioral coverage companion for strip-helpers.ts. The base suite
// (strip-helpers.test.ts) pins the common paths; this file drives the
// remaining uncovered branches: escape handling inside strings / templates,
// nested-interpolation brace tracking, newlines inside templates and
// interpolations, and the entire `extractTemplateInterpolationExpressions`
// recursive descent (comments / strings / nested templates / unterminated
// inputs) including readBalancedTemplateExpression and findTemplateLiteralEnd.
//
// Backticks and `${` are assembled from char codes so this source itself
// contains no bare template literals (biome flags an interpolation-free
// `\`x\`` as noUnusedTemplateLiteral, and `${` inside an ordinary string as
// noTemplateCurlyInString). The helper `tpl()` rewrites two sentinels:
//   "@"  -> backtick
//   "#"  -> "$" (so "#{" becomes "${")
const BT = String.fromCharCode(96);
const DOLLAR = String.fromCharCode(36);
const tpl = (s: string): string => s.split("@").join(BT).split("#").join(DOLLAR);

describe("stripTemplateLiterals — escape handling", () => {
	it("passes string-literal escapes through untouched (inString + backslash)", () => {
		// `"a\nb"` is a real string; its escaped backslash must be preserved
		// verbatim so later state tracking isn't corrupted. Outside any
		// template, the whole string survives unchanged.
		const out = stripTemplateLiterals('const x = "a\\nb";');
		expect(out).toBe('const x = "a\\nb";');
	});

	it("blanks an escape sequence inside the template body", () => {
		// Body is a, backslash, n, space, b = 5 chars -> 5 spaces; backticks
		// preserved. Exercises the `inTpl && interpDepth === 0 && \\` branch.
		const out = stripTemplateLiterals(tpl("x = @a\\n b@"));
		expect(out).toBe(tpl("x = @     @"));
	});

	it("does not blank a backslash that is the final character of input", () => {
		// `i + 1 < content.length` guard is false on a trailing backslash, so
		// it falls through to the normal body-blanking path (1 space).
		const out = stripTemplateLiterals(tpl("x = @ab\\"));
		expect(out).toBe(tpl("x = @   "));
	});
});

describe("stripTemplateLiterals — interpolation brace depth", () => {
	it("tracks nested braces and blanks the whole interpolation", () => {
		// `${ {a:1} }` — the inner `{`/`}` must increment/decrement interpDepth
		// rather than prematurely closing the interpolation. Entire run blanks.
		const input = tpl("x = @#{ {a:1} }@");
		const out = stripTemplateLiterals(input);
		expect(out).toBe(tpl("x = @          @"));
		// Length is preserved exactly (offset invariant).
		expect(out.length).toBe(input.length);
	});

	it("preserves newlines inside the template body", () => {
		const input = tpl("@line1\nline2@");
		const out = stripTemplateLiterals(input);
		expect(out).toBe(tpl("@     \n     @"));
	});

	it("preserves newlines inside an interpolation", () => {
		// Multi-line interpolation: newline kept, other chars blanked.
		const input = tpl("@#{a\n+b}@");
		const out = stripTemplateLiterals(input);
		expect(out).toBe(tpl("@   \n   @"));
		expect(out.length).toBe(input.length);
	});
});

describe("extractTemplateInterpolationExpressions — comment & string skipping", () => {
	it("ignores templates that live inside a block comment", () => {
		const input = tpl("/* @#{skip}@ */ const r = @#{keep}@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["keep"]);
	});

	it("ignores templates inside a double-quoted string with an escaped quote", () => {
		const input = tpl('const s = "x\\"y@#{nope}@"; const r = @#{yes}@');
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["yes"]);
	});

	it("ignores templates inside a line comment", () => {
		const input = tpl("// @#{no}@\nconst r = @#{yep}@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["yep"]);
	});

	it("captures multiple interpolations in a single template", () => {
		const input = tpl("const r = @#{a}#{b}@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["a", "b"]);
	});
});

describe("readBalancedTemplateExpression — interior constructs", () => {
	it("treats a brace inside a line comment as non-structural", () => {
		// The `}` inside `// cmt with }` must not close the interpolation; the
		// real closing `}` is after `+ b`.
		const input = tpl("const r = @#{a // cmt with }\n + b}@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual([
			"a // cmt with }\n + b",
		]);
	});

	it("treats a brace inside a block comment as non-structural", () => {
		const input = tpl("const r = @#{a /* } */ + b}@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual(["a /* } */ + b"]);
	});

	it("treats a brace inside a quoted string (with escape) as non-structural", () => {
		const input = tpl('const r = @#{f("a}b") + 1}@');
		expect(extractTemplateInterpolationExpressions(input)).toEqual(['f("a}b") + 1']);
	});

	it("skips a backslash escape inside a string in the expression body", () => {
		// readBalancedTemplateExpression's own `inString && backslash` branch:
		// the escaped quote (\") must NOT close the string, so the trailing
		// real `}` is what closes the interpolation. Without the escape-skip the
		// string would close early and the brace count would go wrong.
		const input = tpl('const r = @#{ f("a\\"b") }@');
		expect(extractTemplateInterpolationExpressions(input)).toEqual([' f("a\\"b") ']);
	});

	it("skips a non-quote escape (\\t) inside a string in the expression body", () => {
		// Same escape-skip branch, but the escaped char is not the string
		// delimiter — confirms the two-char advance is unconditional on the
		// next character, not special-cased to the quote.
		const input = tpl('const r = @#{ g("x\\ty") + 1 }@');
		expect(extractTemplateInterpolationExpressions(input)).toEqual([' g("x\\ty") + 1 ']);
	});

	it("tracks nested object-literal braces inside the expression", () => {
		const input = tpl("const r = @#{ {k:1} }@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual([" {k:1} "]);
	});

	it("descends into a nested template literal inside the expression", () => {
		// Expression body holds another template (no further interpolation):
		// the body string is captured, and recursion finds no inner expr.
		const input = tpl("const r = @#{ x + @y@ }@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual([" x + `y` "]);
	});
});

describe("findTemplateLiteralEnd — via nested templates", () => {
	it("recurses through a nested template that itself interpolates", () => {
		// Outer expr body captured AND the inner `${b}` captured via the
		// recursive scan of the expression body. This drives the `${` branch
		// of findTemplateLiteralEnd (skipping the inner template while locating
		// the outer expr's closing brace) plus collectTemplateExpressions
		// recursion.
		const input = tpl("const r = @#{ @a#{b}c@ }@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual([
			tpl(" @a#{b}c@ "),
			"b",
		]);
	});

	it("handles an escaped backtick inside a nested template inside the expr", () => {
		const input = tpl("const r = @#{ @a\\@b@ }@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual([tpl(" @a\\@b@ ")]);
	});

	it("returns nothing when a nested template's own interpolation is unterminated", () => {
		// Drives findTemplateLiteralEnd's `expr === null` early return: the outer
		// readBalanced hits the nested backtick and calls findTemplateLiteralEnd;
		// that nested template contains `${ unterminated ...` whose inner
		// readBalanced walks to EOF and returns null, so findTemplateLiteralEnd
		// returns null, and the whole extraction yields nothing.
		const input = tpl("const r = @#{ @nested #{ unterminated @ }@");
		expect(extractTemplateInterpolationExpressions(input)).toEqual([]);
	});
});

describe("extractTemplateInterpolationExpressions — recursion depth cap", () => {
	it("stops descending past three levels of nested templates", () => {
		// Four nested template/interpolation levels. The deepest body ("deep")
		// is captured at recursion depth 3, where `recursionDepth < 3` is false
		// and no further scan occurs. We assert the innermost atom is present
		// and that exactly four expressions are produced (one per level).
		const input = tpl("r = @#{ @#{ @#{ @#{deep}@ }@ }@ }@");
		const result = extractTemplateInterpolationExpressions(input);
		expect(result).toHaveLength(4);
		expect(result[3]).toBe("deep");
	});
});

describe("extractTemplateInterpolationExpressions — unterminated inputs", () => {
	it("returns nothing for an unterminated template literal", () => {
		// No closing backtick: collectTemplateExpressions walks to EOF and
		// returns null, scanTemplateLiterals jumps to content.length.
		expect(extractTemplateInterpolationExpressions(tpl("const r = @no close here"))).toEqual(
			[],
		);
	});

	it("returns nothing for an unterminated interpolation", () => {
		// `${a + b` never closes -> readBalancedTemplateExpression returns null
		// -> collectTemplateExpressions returns null (drops everything).
		expect(
			extractTemplateInterpolationExpressions(tpl("const r = @#{a + b never closes")),
		).toEqual([]);
	});

	it("returns nothing when a nested template inside the expr is unterminated", () => {
		// readBalanced encounters a backtick, findTemplateLiteralEnd cannot find
		// its close, returns null, so readBalanced returns null.
		expect(
			extractTemplateInterpolationExpressions(tpl("const r = @#{ @unterminated }@ tail")),
		).toEqual([]);
	});

	it("returns nothing on a trailing backslash inside an unterminated expr", () => {
		// Escape with no following char (i+1 >= length guard false) then EOF.
		expect(extractTemplateInterpolationExpressions(tpl("r = @#{ @ab\\"))).toEqual([]);
	});
});

describe("stripComments — escape handling inside strings and templates", () => {
	it("preserves an escaped backtick inside a template and still strips the trailing comment", () => {
		// `(inString || inTpl) && \\` branch: the escaped backtick must not end
		// the template; the `// c` afterward is a real comment -> blanked.
		const input = tpl("x = @a\\@b@ // c");
		const out = stripComments(input);
		expect(out).toBe(tpl("x = @a\\@b@     "));
	});

	it("preserves an escaped char inside a string and still strips the trailing comment", () => {
		const out = stripComments('x = "a\\nb"; // c');
		expect(out).toBe('x = "a\\nb";     ');
	});
});

describe("stripStringLiterals — no-literal short-circuit", () => {
	it("returns a line with no string literals unchanged", () => {
		// Exercises the regex-replace branch where no match is found.
		expect(stripStringLiterals("const x = a + b;")).toBe("const x = a + b;");
	});
});

describe("stripRegexLiterals — comment openers are not regex literals", () => {
	it("leaves a block comment at an expression position intact", () => {
		// JS lexes `/*` as a comment opener, never a regex start. Before the
		// first-body-char restriction this whole comment was blanked as if it
		// were `/…/` with a `*…*` body (finding 2026-06: it ate the comments
		// stripLiteralsKeepComments exists to preserve).
		const input = "/* the fixture is environment-sensitive */";
		expect(stripRegexLiterals(input)).toBe(input);
	});

	it("still strips a real regex whose body starts with an escaped star", () => {
		const literal = "/\\*x/";
		const out = stripRegexLiterals(`const re = ${literal};`);
		expect(out).toBe(`const re = ${" ".repeat(literal.length)};`);
	});
});

describe("stripLiteralsKeepComments — comments survive, fixtures do not", () => {
	it("keeps comment text while blanking template fixture interiors", () => {
		const fixtureLine = "// looks like a comment";
		const input = ["// real comment", tpl("const f = @"), fixtureLine, tpl("@;")].join("\n");
		const out = stripLiteralsKeepComments(input).split("\n");
		expect(out[0]).toBe("// real comment");
		// The template body line is blanked to same-length spaces.
		expect(out[2]).toBe(" ".repeat(fixtureLine.length));
	});

	it("blanks string interiors but keeps the comment after them", () => {
		const out = stripLiteralsKeepComments('const s = "// not a comment"; // trailing note');
		expect(out).toContain("// trailing note");
		expect(out).not.toContain("not a comment");
	});
});
