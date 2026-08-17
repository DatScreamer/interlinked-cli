// Mutation-kill companion for src/harness/checks/taste-smell.ts — W6 residue
// wave (fleet-r3, third campaign). Every case here targets one or more
// specific surviving mutants recorded in
// scratch/fleet-r3/receipts/src_harness_checks_taste-smell.ts.jsonl.
// Each assertion is the EXACT pristine output for a fixture that a fresh
// shadow-verify run (scratch/fleet-r3/src_harness_checks_taste-smell.ts-shadow-verify.mts)
// proved diverges from the named mutant's output — see that receipts file
// for the mutantId -> testName mapping.

import { describe, expect, it } from "vitest";
import { checkCommentedOutCode, checkNestedTernary } from "./taste-smell.js";

const TS_PATH = "src/lib/app.ts";
const PY_PATH = "scripts/x.py";

describe("taste-smell mutation-kill: checkCommentedOutCode doc/license marker anchoring", () => {
	// test-contract: boundary — docPattern's `^\s*` anchor must allow leading
	// indentation before `//`, or an indented @-marker line stops being
	// silently skipped and starts being scored as ordinary code/doc content.
	it("kills d972d1b8e13f63e7: an indented @-marker line still counts as a doc marker (anchor allows leading whitespace)", () => {
		const content = "// save(data);\n// audit(data);\n// publish(data);\n  // TODO | blah\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([
			{ line: 1, text: "[4 lines of commented-out code → use version control instead]" },
		]);
	});

	// test-contract: boundary — the `@\w+` alternative must match a
	// single-character word (`@xy` truncated to one char in the mutant's
	// `\w` singular), or a short @-marker stops being recognized.
	it("kills a50bc665941a295e + 3d1b0a68b843d690: a single-char @-word (@xy) still counts as a doc marker word", () => {
		const content = "// save(data);\n// audit(data);\n// publish(data);\n// @xy | blah\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([
			{ line: 1, text: "[4 lines of commented-out code → use version control instead]" },
		]);
	});

	// test-contract: boundary — licensePattern's `^\s*` anchor must allow
	// leading indentation before `//`, mirroring the docPattern case above.
	it("kills f111ad366311f5c1: an indented copyright line still counts as a license marker (anchor allows leading whitespace)", () => {
		const content = "// save(data);\n// audit(data);\n// publish(data);\n  // copyright | acme\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([
			{ line: 1, text: "[4 lines of commented-out code → use version control instead]" },
		]);
	});
});

describe("taste-smell mutation-kill: checkCommentedOutCode comment-prefix strip length", () => {
	// test-contract: boundary — commentPrefix's optional-space quantifier
	// (`\s?`, exactly zero or one) must strip only the marker character
	// itself; widening it to `\S?` would eat the next real content char too,
	// corrupting the uncommented text handed to classifyCommentLine.
	it("kills 6aa1c1b63d71f6e4: python '#5 = 6' strips only the '#' — the digit is real content, not a bonus-stripped char", () => {
		const content = "#5 = 6\n# audit(data)\n# publish(data)\nreal_code()";
		expect(checkCommentedOutCode(content, PY_PATH)).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	// test-contract: boundary — same commentPrefix strip-length contract as
	// above, JS `//` marker instead of python `#`.
	it("kills cb6c881640087f04: JS '//5 = 6;' strips only the '//' — the digit is real content, not a bonus-stripped char", () => {
		const content = "//5 = 6;\n// audit(data);\n// publish(data);\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});
});

describe("taste-smell mutation-kill: checkCommentedOutCode.flushBlock gate", () => {
	// test-contract: bug — flushBlock's guard is `blockStart !== -1 &&
	// totalLineCount >= 3 && docLineCount === 0`. `&&` binds tighter than
	// `||`, so swapping the FIRST `&&` for `||` turns the whole guard into
	// `blockStart !== -1 || (totalLineCount >= 3 && docLineCount === 0)` —
	// inside any real block (blockStart !== -1 is always true there) this
	// SHORT-CIRCUITS PAST the length and doc-veto checks entirely. A fixture
	// that has a real block AND a doc-pipe line is the only shape that
	// exposes this: on real code the doc veto correctly suppresses the
	// match; under the mutant it fires regardless.
	it("kills ea3e92ad29050bbd: a genuine block whose only doc-pipe line sits BEHIND a mid-line // NOTE must still veto (the flush gate's outer clauses cannot short-circuit past the doc-line check)", () => {
		const content = "// save(data);\n// audit(data);\n// publish(data);\n// a | b // NOTE\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([]);
	});

	// test-contract: boundary — blockStart is initialized to and reset to
	// -1 as the "no active block" sentinel; the guard must compare it
	// against -1 specifically, not against +1 or any other sentinel, or a
	// block starting at the file's second line (index 1) stops being
	// recognized as active.
	it("kills 642768d4511c6528: a block starting at file line index 1 (not 0) still fires — blockStart must be compared against -1, not +1", () => {
		const content = "realCode();\n// save(data);\n// audit(data);\n// publish(data);\nmoreCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([
			{ line: 2, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});
});

describe("taste-smell mutation-kill: classifyCommentLine doc vetoes", () => {
	// test-contract: boundary — the `\((?:e\.g\.|i\.e\.|see\b|...)` doc-veto
	// alternation must include `see\b`; deleting the `"doc"` return value
	// for this branch makes the line count as neutral instead of doc,
	// silently un-vetoing an otherwise-firing block.
	it("kills 3e52fabb786b5e0a: a '(see docs)' prose parenthetical still vetoes the block as doc content", () => {
		const content = "// save(data);\n// audit(data);\n// publish(data);\n// (see docs)\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([]);
	});

	// test-contract: boundary — the bare-annotation veto's NOT-a-terminator
	// guard (`!/[;,{]\s*$/`) must anchor at the true end of the string; both
	// dropping the `$` and widening `\s*` to `\S*` let a terminator char
	// that sits BEFORE trailing content still count as "ends in a
	// terminator", wrongly disabling the doc veto for a real annotation line.
	it("kills 713fc31228514461 + 78ccaa4c97f445c7: a bare 'key: type,extra' annotation is still doc even though a terminator char sits mid-string, not just at the true end", () => {
		const content = "// save(data);\n// audit(data);\n// publish(data);\n// retries: number,extra\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([]);
	});

	// test-contract: boundary — the python assignment detector's excluded
	// operator-char class `[-+*/%|&^]?=` must not accept `<` before `=`, or
	// a `<=` comparison gets misclassified as a real assignment statement.
	it("kills dd1249316e03bc72: python 'x <= 5' is a comparison, not an assignment — the assign-detector's excluded-char class must reject '<' before '='", () => {
		const content = "# save(data)\n# audit(data)\n# x <= 5\nreal_code()";
		expect(checkCommentedOutCode(content, PY_PATH)).toEqual([]);
	});

	// test-contract: boundary — the trailing comparison-operator veto
	// `![=<>!]=\s*$` must match only a TRUE comparison char right before the
	// `=`; broadening it to `[^=<>!]` (negated class) makes ANY non-operator
	// char in that position look like a comparison, wrongly un-classifying
	// a real assignment (`z0=`) as non-code.
	it("kills 37aa243bcd99cff4: python 'y = z0=' is still a real assignment — a non-comparison char ('0') before a trailing '=' must not be misread as a comparison operator", () => {
		const content = "# save(data)\n# audit(data)\n# y = z0=\nreal_code()";
		expect(checkCommentedOutCode(content, PY_PATH)).toEqual([
			{ line: 1, text: "[3 lines of commented-out code → use version control instead]" },
		]);
	});

	// test-contract: boundary — the same trailing comparison veto must
	// still catch a bare `==` (no space before it); requiring a literal
	// space (`\s$` instead of `\s*$`) would miss this and misclassify the
	// comparison as an assignment.
	it("kills 3d3f197b3fba6961: python 'y = z==' (bare trailing '==', no space before it) is a comparison, not an assignment, so it does not count as code", () => {
		const content = "# save(data)\n# audit(data)\n# y = z==\nreal_code()";
		expect(checkCommentedOutCode(content, PY_PATH)).toEqual([]);
	});

	// test-contract: boundary — the bare-call detector `\(...\)\s*$` must
	// anchor with `\s*$` (nothing but optional whitespace after the closing
	// paren); widening the trailing class to `\S*$` lets glued-on content
	// after the paren still read as a clean call statement.
	it("kills 8a33e1d086d3016b: python content glued right after a call's closing paren ('publish(data)extra') is not a bare call statement", () => {
		const content = "# save(data)\n# audit(data)\n# publish(data)extra\nreal_code()";
		expect(checkCommentedOutCode(content, PY_PATH)).toEqual([]);
	});

	// test-contract: boundary — the JS assignment detector's trailing
	// terminator class `[;,]\s*$` must require nothing but whitespace after
	// the terminator; widening it to `\S*$` lets glued-on content after the
	// comma still read as a clean disabled assignment statement.
	it("kills 8b80d2fbf1bd6098: JS assignment 'x = 5,extra' with content glued right after the comma terminator is not a clean disabled assignment statement", () => {
		const content = "// save(data);\n// audit(data);\n// x = 5,extra\nrealCode();";
		expect(checkCommentedOutCode(content, TS_PATH)).toEqual([]);
	});
});

describe("taste-smell mutation-kill: maxTernaryNestingDepth chaining-skip guard", () => {
	// test-contract: boundary — the optional-chaining skip (`ch === "?" &&
	// j + 1 < line.length` guarding the `?.` two-char lookahead) must stay a
	// real conjunction; collapsing either half to `true` makes the scanner
	// treat a plain `?` immediately before a `.` as chaining and skip past
	// it, undercounting the ternary depth of the string that follows.
	it("kills 2d08ee3dbb231ee7 + 1c5b5a05e8060e4e: a colon immediately followed by a literal '.' ('a?b:.c?d:e') must not manufacture a second ternary nesting level", () => {
		expect(checkNestedTernary("a?b:.c?d:e", TS_PATH)).toEqual([]);
	});

	// test-contract: boundary — same guard, negative direction: turning the
	// `&&` into `||` makes the chaining-skip fire on every `?` (since `ch
	// === "?"` alone is enough), so a genuine nested ternary's `?` chars get
	// skipped instead of counted and the real depth-2 nesting is missed.
	it("kills 907f2de9c984a28b: a genuine nested ternary ('a?b?c:d:e') must still reach nesting depth 2 and fire", () => {
		expect(checkNestedTernary("a?b?c:d:e", TS_PATH)).toEqual([{ line: 1, text: "a?b?c:d:e" }]);
	});
});
