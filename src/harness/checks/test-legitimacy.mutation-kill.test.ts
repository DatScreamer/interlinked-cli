import { describe, expect, it } from "vitest";
import type { InlineMatch } from "../check-registry/types.js";
import {
	BROAD_TRUTHINESS,
	checkTestLegitimacy,
	MUTATION_DIRECTED_SUFFIX,
	RECEIPT_MISSING_PREFIX,
	TEST_CASE_LINE,
} from "./test-legitimacy.js";

// Pass-1 mutation-kill campaign for src/harness/checks/test-legitimacy.ts —
// wave-20 survivor sweep. Each case targets one or more specific surviving
// mutant IDs from .interlinked/mutation-manifest.json (recorded in the
// receipt file, not repeated here — the comment above each case names the
// externally-observable behavior the mutant broke).

const TEST_PATH = "src/lib/widget.test.ts";
const MUTATION_PATH = "src/lib/widget.mutation-kill.test.ts";

function check(content: string, filePath = TEST_PATH): InlineMatch[] {
	return checkTestLegitimacy(content, filePath);
}

describe("checkTestLegitimacy — trimmedLine exact text (trim + 150-char cap)", () => {
	// test-contract: invariant — a reported finding's text is trimmed of the
	// source line's surrounding whitespace, never carrying it verbatim
	it("strips leading and trailing whitespace from the reported line text", () => {
		const content = 'it("case", () => {\n   expect(result).toBeTruthy();   \n});';
		const found = check(content);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe("expect(result).toBeTruthy();");
	});

	// test-contract: invariant — a reported finding's text never exceeds 150
	// characters, matching the source line's own first 150 characters exactly
	it("caps the reported line text at exactly 150 characters", () => {
		const longSuffix = "x".repeat(200);
		const content = `expect(result).toBeTruthy();${longSuffix}`;
		const found = check(content);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toHaveLength(150);
		expect(found[0]?.text).toBe(content.slice(0, 150));
	});
});

describe("checkTestLegitimacy — pushMissingContract text cap", () => {
	// test-contract: invariant — the missing-contract message (prefix +
	// declaration) is capped at 150 characters even when both halves are long
	it("caps the missing-contract message at exactly 150 characters", () => {
		const longName = "a".repeat(300);
		const content = `it("${longName}", () => {});`;
		const found = check(content, MUTATION_PATH);
		const declaration = content.trim().slice(0, 150);
		const expectedText = (RECEIPT_MISSING_PREFIX + declaration).slice(0, 150);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toHaveLength(150);
		expect(found[0]?.text).toBe(expectedText);
	});
});

describe("checkTestLegitimacy — isSpecificContractMarker rationale gate", () => {
	// test-contract: invariant — a rationale under 12 characters never grounds
	// a case, regardless of how it reads
	it("rejects a marker whose rationale is under the 12-character floor", () => {
		const content = [
			"// test-contract: public-api — short",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toHaveLength(1);
	});

	// test-contract: boundary — the 12-character floor is inclusive: exactly
	// 12 non-generic characters grounds the case
	it("accepts a non-generic rationale at exactly the 12-character floor", () => {
		const content = [
			"// test-contract: public-api — widgetlabelx",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toEqual([]);
	});

	// test-contract: invariant — a rationale that is both long enough AND one
	// of the generic placeholder words still does not ground the case
	it("rejects a generic-word rationale even at the length floor", () => {
		const content = [
			"// test-contract: invariant — the contract",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toHaveLength(1);
	});
});

describe("checkTestLegitimacy — hasAdjacentContractMarker window", () => {
	// test-contract: boundary — the marker search inspects at most 4 non-blank
	// lines above a case; a marker sitting beyond that window does not ground it
	it("does not look past 4 inspected lines for a contract marker", () => {
		const content = [
			"// test-contract: public-api — widget renders the documented empty-state label",
			"// filler comment one",
			"// filler comment two",
			"// filler comment three",
			"// filler comment four",
			'it("case", () => expect(render()).toEqual("Empty"));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(6);
		expect(found[0]?.text).toContain(RECEIPT_MISSING_PREFIX);
	});

	// test-contract: boundary — a whitespace-only line between marker and case
	// is treated as blank (skipped), not as intervening executable code
	it("treats a whitespace-only line as blank, not as code that blocks the marker", () => {
		const content = [
			"// test-contract: boundary — decorated case handles the empty input boundary",
			"   ",
			'it("decorated case", () => expect(render([])).toEqual("Empty"));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toEqual([]);
	});

	// test-contract: boundary — a plain (non-marker) comment line between
	// marker and case does not block the search from reaching the marker
	it("does not let a plain filler comment block the search from the marker", () => {
		const content = [
			"// test-contract: boundary — decorated case handles the empty input boundary",
			"// a plain filler comment",
			'it("decorated case", () => expect(render([])).toEqual("Empty"));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toEqual([]);
	});
});

describe("checkTestLegitimacy — importedPrivateSurface brace pairing", () => {
	// test-contract: boundary — a stray closing brace with no opening brace at
	// all is not a valid destructured import; nothing is flagged
	it("ignores a stray closing brace with no opening brace anywhere", () => {
		expect(check('import ,__privateThing} from "./x.js";')).toEqual([]);
	});

	// test-contract: boundary — when a closing brace appears BEFORE the real
	// opening brace, the pair is invalid and the name inside is not flagged
	it("does not pair a closing brace that appears before the opening brace", () => {
		const found = check('import }{ __privateThing } from "./x.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — with no opening brace present, a comma-prefixed
	// name followed by a stray closing brace is not flagged (no valid pair)
	it("does not flag a comma-prefixed name when no opening brace exists", () => {
		expect(check('import a, __privateThing} from "./x.js";')).toEqual([]);
	});

	// test-contract: boundary — an opening brace with no matching closing
	// brace anywhere in the statement is not a valid destructured import
	it("does not flag a named import with no closing brace at all", () => {
		expect(check('import { __privateThing from "./x.js";')).toEqual([]);
	});

	// test-contract: boundary — only the FIRST brace pair is inspected; a
	// private name inside a second, later brace pair is not reachable
	it("only inspects the first brace pair when a statement has two", () => {
		expect(check('import { render } { __privateThing } from "./x.js";')).toEqual([]);
	});
});

describe("checkTestLegitimacy — pushPrivateImports total counter and offset", () => {
	// test-contract: invariant — the true finding total (used for the
	// truncation summary) equals the number of private imports actually seen,
	// not merely the number listed
	it("reports the true total for 21 private import statements (1 over the cap)", () => {
		const lines: string[] = [];
		for (let i = 0; i <= 20; i++) lines.push(`import { thing } from "../internal/m${i}.js";`);
		const found = check(lines.join("\n"));
		expect(found).toHaveLength(21);
		expect(found[found.length - 1]?.text).toContain("21 test-legitimacy finding(s)");
	});

	// test-contract: invariant — the same true-total invariant holds for the
	// require() loop's own counter, independent of the import loop's
	it("reports the true total for 21 private require() statements (1 over the cap)", () => {
		const lines: string[] = [];
		for (let i = 0; i <= 20; i++) lines.push(`const m${i} = require("../internal/m${i}.js");`);
		const found = check(lines.join("\n"));
		expect(found).toHaveLength(21);
	});

	// test-contract: boundary — a require() call's reported line must be its
	// OWN line, not line 1, even when line 1 is a comment
	it("reports a require() on line 2 at line 2, not line 1", () => {
		const content = ["// header comment", 'const x = require("../internal/parser.js");'].join("\n");
		const found = check(content);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — a require() of an ordinary (non-internal,
	// non-private) module is never flagged
	it("does not flag a require() of an ordinary module", () => {
		expect(check("const parser = require('./ordinary-parser.js');")).toEqual([]);
	});
});

describe("checkTestLegitimacy — MUTATION_DIRECTED_PATH is case-insensitive", () => {
	// test-contract: invariant — the mutation-directed path classification is
	// case-insensitive, so an uppercase token still routes through the
	// missing-contract check
	it("still classifies an UPPERCASE .MUTATION-KILL. path as mutation-directed", () => {
		const content = ["// filler", 'it("case", () => {});'].join("\n");
		const found = check(content, "src/lib/widget.MUTATION-KILL.test.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});

describe("MUTATION_DIRECTED_SUFFIX — public export, case-insensitive", () => {
	// test-contract: public-api — the exported suffix regex is case-insensitive,
	// matching the SUT-name stripping consumer (test-hygiene-quality.ts)
	// regardless of how the mutation-directed token is cased
	it("matches an uppercase .MUTATION-KILL suffix", () => {
		expect(MUTATION_DIRECTED_SUFFIX.test("widget.MUTATION-KILL")).toBe(true);
	});
});

describe("TEST_CASE_LINE — public export, exact anchoring", () => {
	// test-contract: public-api — the case-line pattern is anchored to the
	// start of the line; an it()-shaped call embedded after other code is not
	// itself the start of a test-case line
	it("does not match an it() call embedded after other code on the line", () => {
		expect(TEST_CASE_LINE.test('foo(); it("x", () => {});')).toBe(false);
	});

	// test-contract: public-api — leading whitespace before it()/test()/specify()
	// is tolerated, however much of it there is
	it("matches an indented it() call", () => {
		expect(TEST_CASE_LINE.test('   it("case", () => {});')).toBe(true);
	});

	// test-contract: public-api — a call whose name merely CONTAINS "it" as a
	// substring (not the literal word it/test/specify) is not a case line
	it("does not match a call whose name only contains the substring 'it'", () => {
		expect(TEST_CASE_LINE.test('itSomethingElse("not a case");')).toBe(false);
	});
});

describe("BROAD_TRUTHINESS — public export, exact spacing tolerance", () => {
	// test-contract: public-api — optional whitespace around "expect(" is
	// tolerated
	it("matches with whitespace between expect and its call parens", () => {
		expect(BROAD_TRUTHINESS.test("expect (result).toBeTruthy();")).toBe(true);
	});

	// test-contract: public-api — optional whitespace between the expect(...)
	// call and the following ".toBe..." chain is tolerated
	it("matches with whitespace before the .toBeTruthy chain", () => {
		expect(BROAD_TRUTHINESS.test("expect(result) .toBeTruthy();")).toBe(true);
	});

	// test-contract: public-api — a ".not" modifier between expect(...) and
	// toBeTruthy/toBeFalsy is still recognized as broad-truthiness
	it("matches through a .not modifier with no surrounding space", () => {
		expect(BROAD_TRUTHINESS.test("expect(result).not.toBeTruthy();")).toBe(true);
	});

	// test-contract: public-api — whitespace after a chained .not/.resolves/
	// .rejects modifier is tolerated
	it("matches through a .not modifier with trailing space", () => {
		expect(BROAD_TRUTHINESS.test("expect(result).not .toBeTruthy();")).toBe(true);
	});

	// test-contract: public-api — optional whitespace between the matcher name
	// and its own call parens is tolerated
	it("matches with whitespace before the matcher's own call parens", () => {
		expect(BROAD_TRUTHINESS.test("expect(result).toBeTruthy ();")).toBe(true);
	});
});

describe("checkTestLegitimacy — CONTRACT_MARKER anchoring and separator shape", () => {
	// test-contract: boundary — the marker must start the (trimmed) line; a
	// trailing "// test-contract:" comment after real code is not recognized
	it("does not treat a trailing comment after code as a contract marker", () => {
		const content = [
			"code(); // test-contract: public-api — a properly specific rationale",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: boundary — the marker still grounds a case when written
	// in its most compact legal form (no spaces around "//" or the separator)
	it("still recognizes a compact marker with no spaces around the separator", () => {
		const content = [
			"//test-contract:public-api—compact form no spaces around dash",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toEqual([]);
	});
});

describe("checkTestLegitimacy — CALL_ORDER spacing tolerance", () => {
	// test-contract: invariant — optional whitespace before the call-order
	// matcher's own parens is tolerated
	it("flags a call-order assertion with whitespace before its call parens", () => {
		const found = check("expect(spy).toHaveBeenNthCalledWith (1, 'x');");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});
});

describe("checkTestLegitimacy — IMPORT_DECLARATION statement shape", () => {
	// test-contract: boundary — leading indentation before "import" is
	// tolerated; an indented private import is still detected
	it("detects a private import indented with leading spaces", () => {
		const found = check('  import { __privateThing } from "./widget.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — a side-effect import with no "from" clause at
	// all is still recognized when its quoted path is private
	it("detects a private side-effect import with no from clause", () => {
		const found = check('import"./internal/styles.css";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — zero whitespace anywhere around "from" is
	// tolerated; a maximally compact private import is still detected
	it("detects a private import with zero whitespace around from", () => {
		const found = check('import{__privateThing}from"./widget.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — the captured module source is the FULL
	// quoted string, not truncated by one character
	it("captures the full quoted source, not truncated by one character", () => {
		const found = check('import { x } from "./internal";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — a missing trailing semicolon is tolerated
	// (the statement still ends at end-of-line/end-of-content)
	it("detects a private import with no trailing semicolon", () => {
		const found = check('import { __privateThing } from "./widget.js"');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});
});

describe("checkTestLegitimacy — REQUIRE_DECLARATION spacing tolerance", () => {
	// test-contract: boundary — whitespace between "require" and its opening
	// paren is tolerated
	it("detects a private require() with a space before the opening paren", () => {
		const found = check("const x = require ('../internal/parser.js');");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — whitespace just inside both parens is
	// tolerated
	it("detects a private require() with whitespace inside both parens", () => {
		const found = check("const x = require( '../internal/parser.js' );");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});
});

describe("checkTestLegitimacy — PRIVATE_MODULE_SEGMENT boundary matching", () => {
	// test-contract: boundary — "internal" at the very start of a bare
	// specifier (no leading "./") still counts as a private segment
	it("flags a bare specifier that starts directly with internal/", () => {
		const found = check('const x = require("internal/api.js");');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — "internalish" is NOT the segment "internal";
	// a same-prefix module name must not be flagged
	it("does not flag a module name that only starts with internal, e.g. internalish", () => {
		expect(check('const x = require("./internalish.js");')).toEqual([]);
	});

	// test-contract: boundary — "xinternal" does not have "internal" as a
	// properly bounded path/word segment; it must not be flagged
	it("does not flag a module name where internal is glued to a preceding letter", () => {
		expect(check('const x = require("xinternal");')).toEqual([]);
	});
});

describe("checkTestLegitimacy — PRIVATE_NAMED_IMPORT identifier shape", () => {
	// test-contract: boundary — a single-underscore private name directly
	// after a comma (zero intervening whitespace) is still detected
	it("detects a comma-anchored single-underscore name with no space after the comma", () => {
		const found = check('import { render,_privateThing } from "./widget.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — multiple spaces after the "type" keyword are
	// tolerated before the private name
	it("detects a type-prefixed private name with two spaces after type", () => {
		const found = check('import { type  __privateThing } from "./widget.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — exactly one space after "type" (the ordinary
	// case) is detected
	it("detects a type-prefixed private name with the ordinary single space", () => {
		const found = check('import { type __privateThing } from "./widget.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — an underscore run followed by a DIGIT (not a
	// letter) is not the private-name convention; it must not be flagged
	it("does not flag an underscore-prefixed name where a digit follows the underscore", () => {
		expect(check('import { __1thing } from "./widget.js";')).toEqual([]);
	});

	// test-contract: boundary — a digit-led identifier ending in "ForTests" is
	// not the private-name convention (which requires a letter/$ lead); it
	// must not be flagged
	it("does not flag a digit-led identifier even when it ends in ForTests", () => {
		expect(check('import { 9fooForTests } from "./widget.js";')).toEqual([]);
	});

	// test-contract: boundary — a multi-character stem between the leading
	// letter and the ForTests/Internal/etc. suffix is tolerated (the stem is
	// not limited to exactly one character)
	it("detects a *ForTests name with a multi-character stem before the suffix", () => {
		const found = check('import { fooForTests } from "./widget.js";');
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});
});

describe("checkTestLegitimacy — GENERIC_RATIONALE exact word/spacing shape", () => {
	// test-contract: invariant — the generic-word list requires an EXACT
	// match to the end of the rationale; a listed word with extra trailing
	// text is not generic (it grounds the case)
	it("does not treat a rationale with trailing text past a generic word as generic", () => {
		const content = [
			"// test-contract: public-api — the worksXYZ",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		expect(check(content, MUTATION_PATH)).toEqual([]);
	});

	// test-contract: invariant — the "the " prefix before a generic word is
	// optional; a bare listed word with no "the" is still generic
	it("treats a bare listed word with no leading 'the' as generic", () => {
		const content = [
			"// test-contract: invariant — public   api",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — multiple spaces after "the" are tolerated;
	// the rationale is still recognized as generic
	it("treats 'the' with two trailing spaces before a generic word as generic", () => {
		const content = [
			"// test-contract: public-api — the  contract",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — the optional "s" on "works" is genuinely
	// optional; "work" (no s) is still recognized as generic
	it("treats the s-less 'work' as generic, not just 'works'", () => {
		const content = [
			"// test-contract: public-api — the     work",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — "public api" with the ordinary single space
	// is recognized as the generic "public api" phrase
	it("treats 'public api' with a single ordinary space as generic", () => {
		const content = [
			"// test-contract: invariant — the public api",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — multiple spaces between "public" and "api"
	// are tolerated; still recognized as the generic phrase
	it("treats 'public' and 'api' separated by two spaces as generic", () => {
		const content = [
			"// test-contract: public-api — the public  api",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — the bare word "test" (with its "the " prefix)
	// is recognized as generic
	it("treats the bare word 'test' as generic", () => {
		const content = [
			"// test-contract: public-api — test",
			'it("case", () => expect(x).toEqual(1));',
		].join("\n");
		const found = check(content, MUTATION_PATH);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});
