// Mutation-kill companion for `division-by-variable.ts` (fleet W9, lean mode —
// see scratch/fleet-r3/CONTRACT-W6.md). 135 survivors at inventory time; every
// case below targets a specific mutantId (see the per-mutant map in
// scratch/fleet-r3/receipts/src_harness_checks_ubs-language-specific_division-by-variable.ts.jsonl).
//
// All internal helpers (`lineHasZeroGuard`, `divisorsOnLine`, `escapeForRegex`,
// `collectPathishNames`, `isPathDivisionLine`, `precedingLinesHaveZeroGuard`)
// are module-private, so every case below drives them THROUGH the exported
// `checkDivisionByVariable` entry point and asserts the exact `InlineMatch[]`
// it returns (never `.length` alone — a mutant that replaces the pushed
// object with `{}` still has `.length === 1`).
//
// 2 of the 135 survivors are `suspected_equivalent` (structural argument in
// the receipts file, not reproduced here): 44ecda6f201bb2fe (checkDivisionByVariable's
// local divisionRegex RHS-tail char class — only ever consumed via `.test()`,
// never through the capture group, so the tail quantifier is unobservable at
// this call site) and 32d8378d9fded41f (isPathDivisionLine's `!foundAnyMatch`
// guard — its own regex is byte-identical to checkDivisionByVariable's gate
// regex on the SAME string, so foundAnyMatch is provably always true whenever
// this function executes via its one real call site).
import { describe, expect, it } from "vitest";
import { checkDivisionByVariable } from "./division-by-variable.js";

describe("checkDivisionByVariable — extension gate", () => {
	// test-contract: public-api — module doc: "Extending the allow-list to
	// .kt/.rb/.cs is a one-line edit" implies .go/.java/.c/.cpp/.rs/.swift are
	// each individually load-bearing members of the supported-extension list.
	it("supports .go files", () => {
		expect(checkDivisionByVariable("total / count", "calc.go")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: public-api — same allow-list membership, .java branch.
	it("supports .java files", () => {
		expect(checkDivisionByVariable("total / count", "calc.java")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: public-api — same allow-list membership, .c branch.
	it("supports .c files", () => {
		expect(checkDivisionByVariable("total / count", "calc.c")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: public-api — same allow-list membership, .cpp branch.
	it("supports .cpp files", () => {
		expect(checkDivisionByVariable("total / count", "calc.cpp")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: public-api — same allow-list membership, .rs branch.
	it("supports .rs files", () => {
		expect(checkDivisionByVariable("total / count", "calc.rs")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: public-api — same allow-list membership, .swift branch.
	it("supports .swift files", () => {
		expect(checkDivisionByVariable("total / count", "calc.swift")).toEqual([{ line: 1, text: "total / count" }]);
	});
});

describe("checkDivisionByVariable — match collection", () => {
	// test-contract: boundary — `if (matches.length >= 10) break;` is the
	// documented result cap (matches.push guarded, loop line 100). 12 candidate
	// lines must yield EXACTLY the first 10, not 11 (off-by-one) or 12 (no cap).
	it("caps collected matches at exactly 10", () => {
		const lines = Array.from({ length: 12 }, (_, idx) => `a${idx} / b${idx}`);
		const expected = Array.from({ length: 10 }, (_, idx) => ({ line: idx + 1, text: `a${idx} / b${idx}` }));
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual(expected);
	});

	// test-contract: invariant — the pushed `text` is `originalLines[i]`
	// (not the stripped line), trimmed. Leading/trailing whitespace must not
	// leak into the reported match text.
	it("trims leading/trailing whitespace from the reported match text", () => {
		expect(checkDivisionByVariable("   total / count   ", "calc.ts")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: boundary — module doc: reported text is truncated,
	// keeping the pushed object bounded for very long source lines.
	it("truncates the reported match text to 150 characters", () => {
		const code = `total / count ${"x".repeat(200)}`;
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([{ line: 1, text: `total / count ${"x".repeat(136)}` }]);
	});

	// test-contract: invariant — `originalLines = content.split("\n")` must
	// index by LINE; a line-oblivious split (e.g. split("")) would misindex
	// `originalLines[i]` against the correctly-line-indexed `strippedLines[i]`.
	it("indexes reported text by line, not by character", () => {
		expect(checkDivisionByVariable("const x = 1;\ntotal / count", "calc.ts")).toEqual([{ line: 2, text: "total / count" }]);
	});

	// test-contract: bug — 139-repo-audit fix (module doc): a multi-divisor
	// line is suppressed when SOME (not necessarily all) divisors carry a
	// preceding guard — `.some`, not `.every`. A guard on `n` must suppress
	// the whole line even though `m` (the second divisor) is unguarded.
	it("suppresses a multi-divisor line when only one divisor has a preceding guard", () => {
		const code = "function f(n, m) {\n  if (n === 0) return 0;\n  return total / n + other / m;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});
});

describe("checkDivisionByVariable — division-shape regex boundary", () => {
	// test-contract: boundary — the LHS/slash gap is `\s+` (one-or-more), not
	// exactly one space; realistic reformatted code can carry extra spaces.
	it("matches with multiple spaces before the slash", () => {
		expect(checkDivisionByVariable("total  / count", "calc.ts")).toEqual([{ line: 1, text: "total  / count" }]);
	});

	// test-contract: boundary — same `\s+` requirement on the slash/RHS gap.
	it("matches with multiple spaces after the slash", () => {
		expect(checkDivisionByVariable("total /  count", "calc.ts")).toEqual([{ line: 1, text: "total /  count" }]);
	});

	// test-contract: boundary — `(?:^|[^\w$])` allows the LHS identifier to
	// START the line (the `^` alternative), with nothing preceding it at all.
	it("matches when the LHS identifier starts the line", () => {
		expect(checkDivisionByVariable("total / count", "calc.ts")).toEqual([{ line: 1, text: "total / count" }]);
	});

	// test-contract: boundary — same alternation's OTHER branch: a
	// non-word/non-$ char (not just `^`) may precede the LHS identifier, e.g.
	// an opening paren from `return (total / count);`.
	it("matches when the LHS identifier is preceded by punctuation, not just line-start", () => {
		expect(checkDivisionByVariable("return (total / count);", "calc.ts")).toEqual([{ line: 1, text: "return (total / count);" }]);
	});
});

describe("checkDivisionByVariable — os.path.join suppression", () => {
	// test-contract: bug — 139-repo-audit fix (module doc): `os.path.join(...)`
	// suppresses even when whitespace sits between `join` and the opening
	// paren — the guard regex is `\s*\(`, not an exact-whitespace or
	// non-whitespace form.
	it("suppresses os.path.join(...) with whitespace before the paren", () => {
		expect(checkDivisionByVariable("target = os.path.join (a / b)", "paths.py")).toEqual([]);
	});

	// test-contract: bug — same guard, the no-whitespace form (the common
	// real-world shape) must ALSO suppress.
	it("suppresses os.path.join(...) with no whitespace before the paren", () => {
		expect(checkDivisionByVariable("target = os.path.join(a / b)", "paths.py")).toEqual([]);
	});
});

describe("collectPathishNames (via pathlib Path-join suppression)", () => {
	// test-contract: bug — 139-repo-audit fix (module doc): a bare `name: Path`
	// annotation (no `pathlib.` prefix) registers `name` as pathish, so a
	// later `name / other` line is a path join, not division-by-zero risk.
	it("recognizes a bare `: Path` annotation", () => {
		expect(checkDivisionByVariable("p: Path\ntarget = p / count", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the annotated name's capture group has a
	// `\w*` tail; a multi-character name (not just a 1-char name) must be
	// captured in FULL, not truncated to its first character.
	it("recognizes a multi-character `: Path` annotation", () => {
		expect(checkDivisionByVariable("mypath: Path\ntarget = mypath / count", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — whitespace before the colon is `\s*` (any
	// amount, including some), not required-absent.
	it("recognizes a `: Path` annotation with a space before the colon", () => {
		expect(checkDivisionByVariable("p : Path\ntarget = p / count", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — whitespace after the colon is `\s*` (may be
	// zero), not required-present.
	it("recognizes a `:Path` annotation with no space after the colon", () => {
		expect(checkDivisionByVariable("p:Path\ntarget = p / count", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the optional `pathlib.` prefix's internal dot
	// spacing is `\s*` on both sides; the common zero-space `pathlib.Path`
	// form (both sides at once) must still register.
	it("recognizes `pathlib.Path` with no space around the dot", () => {
		expect(checkDivisionByVariable("p: pathlib.Path\ntarget = p / count", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the pre-dot gap tolerates whitespace too
	// (`pathlib . Path`), not just the compact form.
	it("recognizes `pathlib . Path` with a space before the dot", () => {
		expect(checkDivisionByVariable("p: pathlib . Path\ntarget = p / count", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the post-dot gap likewise tolerates
	// whitespace (`pathlib. Path`).
	it("recognizes `pathlib. Path` with a space after the dot", () => {
		expect(checkDivisionByVariable("p: pathlib. Path\ntarget = p / count", "paths.py")).toEqual([]);
	});

	// test-contract: bug — the assignment form `name = Path(...)` registers
	// `name` as pathish independent of the annotation form; zero spacing
	// around `=` (the common form) must register.
	it("recognizes `name=Path(...)` with no space around the equals", () => {
		expect(checkDivisionByVariable('p=Path("/tmp")\ntarget = p / count', "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the assignment form's `pathlib.` prefix
	// tolerates a space before the dot, same as the annotation form.
	it("recognizes `= pathlib . Path(...)` with a space before the dot", () => {
		expect(checkDivisionByVariable('p = pathlib . Path("/tmp")\ntarget = p / count', "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the assignment form's `pathlib.` prefix with
	// zero spacing on both sides of the dot (the common compact form).
	it("recognizes `= pathlib.Path(...)` with no space around the dot", () => {
		expect(checkDivisionByVariable('p = pathlib.Path("/tmp")\ntarget = p / count', "paths.py")).toEqual([]);
	});

	// test-contract: boundary — whitespace before the constructor's opening
	// paren is tolerated (`Path (...)`, not just `Path(...)`).
	it("recognizes `Path (...)` with a space before the paren", () => {
		expect(checkDivisionByVariable('p = Path ("/tmp")\ntarget = p / count', "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the assignment form's post-dot gap tolerates
	// whitespace too (`pathlib. Path(`).
	it("recognizes `= pathlib. Path(...)` with a space after the dot", () => {
		expect(checkDivisionByVariable('p = pathlib. Path("/tmp")\ntarget = p / count', "paths.py")).toEqual([]);
	});
});

describe("divisorsOnLine (via preceding-guard suppression)", () => {
	// test-contract: boundary — divisorsOnLine's own copy of the LHS
	// alternation also accepts a punctuation-preceded identifier (not just
	// line-start), matching checkDivisionByVariable's own gate regex.
	it("extracts the divisor when the LHS identifier is preceded by punctuation", () => {
		const code = "function f(count) {\n  if (count === 0) return 0;\n  return (total / count);\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	// test-contract: invariant — the divisors accumulator starts as an empty
	// array; it must never carry a stray seed element that could itself
	// satisfy a (contrived) guard-text match and cause a false suppression.
	it("never suppresses via a stray seed element in the divisors array", () => {
		const code = "function f(n) {\n  if (Stryker was here === 0) return 0;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([{ line: 3, text: "return total / n;" }]);
	});

	// test-contract: boundary — the slash/RHS gap in divisorsOnLine's own
	// regex is `\s+` (one-or-more), tolerating extra spaces.
	it("extracts the divisor with multiple spaces after the slash", () => {
		const code = "function f(count) {\n  if (count === 0) return 0;\n  return total /  count;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	// test-contract: boundary — the LHS/slash gap likewise tolerates extra
	// spaces.
	it("extracts the divisor with multiple spaces before the slash", () => {
		const code = "function f(count) {\n  if (count === 0) return 0;\n  return total  / count;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	// test-contract: boundary — the LHS identifier may also start the line
	// itself (the `^` alternative), independent of checkDivisionByVariable's
	// own (separately-instanced) copy of the same alternation.
	it("extracts the divisor when the LHS identifier starts the line", () => {
		const code = "function f(count) {\n  if (count === 0) return 0;\ntotal / count\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});
});

describe("escapeForRegex (via a $-prefixed divisor guard)", () => {
	// test-contract: security — `escapeForRegex` builds a dynamic RegExp from
	// a divisor identifier; `$` is a valid identifier LEADING character
	// (`[a-zA-Z_$]`) and a regex metacharacter, so it must be ESCAPED, not
	// stripped — stripping it would make the guard regex match a DIFFERENT
	// (shorter) identifier than the one actually being guarded.
	it("escapes (not strips) a $-prefixed divisor before building the guard regex", () => {
		const code = "function f($foo) {\n  if ($foo === 0) return 0;\n  return total / $foo;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});
});

describe("isPathDivisionLine", () => {
	// test-contract: invariant — a division whose LHS is NOT a known pathish
	// name must never be treated as a path join, even though the line
	// satisfies isPathDivisionLine's own match structure.
	it("does not suppress a plain identifier division that is not a known Path name", () => {
		expect(checkDivisionByVariable("target = total / count", "calc.py")).toEqual([
			{ line: 1, text: "target = total / count" },
		]);
	});

	// test-contract: boundary — the LHS alternation's `^` branch applies here
	// too: a pathish LHS that starts the line (no preceding char at all) must
	// still be recognized and suppressed.
	it("recognizes a path-join division that starts the line", () => {
		expect(checkDivisionByVariable("p: Path\np / q", "paths.py")).toEqual([]);
	});

	// test-contract: bug — a line with TWO divisions must have BOTH inspected;
	// the first division's pathish LHS must not swallow the separator text
	// and hide the second (non-pathish) division from `anyNonPathDivision`.
	it("inspects every division on a line, not just the first", () => {
		expect(checkDivisionByVariable("p: Path\nresult = p / q + r / s", "paths.py")).toEqual([
			{ line: 2, text: "result = p / q + r / s" },
		]);
	});

	// test-contract: boundary — isPathDivisionLine's own copy of the
	// LHS/slash spacing also tolerates extra spaces before the slash.
	it("recognizes a path-join division with multiple spaces before the slash", () => {
		expect(checkDivisionByVariable("p: Path\nresult = p  / q", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — same tolerance on the slash/RHS gap.
	it("recognizes a path-join division with multiple spaces after the slash", () => {
		expect(checkDivisionByVariable("p: Path\nresult = p /  q", "paths.py")).toEqual([]);
	});

	// test-contract: boundary — the RHS identifier's capture tail is `\w*`
	// (zero-or-more); a single-character RHS (e.g. `q`) must still complete
	// the match, not require a minimum 2-character RHS.
	it("recognizes a path-join division with a single-character RHS identifier", () => {
		expect(checkDivisionByVariable("p: Path\nresult = p / q", "paths.py")).toEqual([]);
	});
});

describe("precedingLinesHaveZeroGuard (lookback window)", () => {
	// test-contract: boundary — blank-line detection is `nonNull(lines[i]).trim() === ""`;
	// a WHITESPACE-ONLY line (non-empty before trim) must be recognized as
	// blank and NOT consume one of the 5 lookback slots, or a real guard just
	// past several such lines falls outside the effective window.
	it("does not count whitespace-only preceding lines against the lookback budget", () => {
		const lines = [
			"function f(n) {",
			"  if (n === 0) return 0;",
			"   ",
			"   ",
			"   ",
			"   ",
			"   ",
			"  return total / n;",
			"}",
		];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});

	// test-contract: boundary — the scan's lower bound is `i >= 0`, which
	// must include index 0 itself (the very first line of the file), not
	// stop one line short of it.
	it("scans the preceding line at index 0", () => {
		const lines = ["if (n === 0) return 0;", "return total / n;"];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});

	// test-contract: boundary — truly-empty preceding lines (not just
	// whitespace-only) must ALSO be skipped for free, not consume budget.
	it("does not count truly-blank preceding lines against the lookback budget", () => {
		const lines = ["function f(n) {", "  if (n === 0) return 0;", "", "", "", "", "", "  return total / n;", "}"];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});
});

describe("lineHasZeroGuard — same-line guard shapes", () => {
	// test-contract: invariant — module doc branch 1: `if <id> > 0|>=1|!=0|!==0|is not None`
	// (Python ternary suffix guard, e.g. `total / count if count > 0 else 0`).
	// Every internal whitespace gap in this pattern is independently
	// boundary-tested by packing all variants into one line-per-case battery;
	// a mutant that breaks ANY one gap leaves ITS line unsuppressed, failing
	// the exact toEqual([]) below.
	it("recognizes every `if <id> <cmp>` guard-clause spacing variant", () => {
		const lines = [
			"total / count if count > 0 else 0",
			"total / count if  count > 0 else 0",
			"total / count if count  > 0 else 0",
			"total / count if count >  0 else 0",
			"total / count if count >= 1 else 0",
			"total / count if count >=  1 else 0",
			"total / count if count != 0 else 0",
			"total / count if count !=  0 else 0",
			"total / count if count !== 0 else 0",
			"total / count if count !==  0 else 0",
			"total / count if x is not None else 0",
			"total / count if x is  not None else 0",
			"total / count if x is not  None else 0",
		];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});

	// test-contract: invariant — module doc branch 2: the parenthesized
	// `if (<id> > 0)` form (C-style guard). Same per-gap spacing battery.
	it("recognizes every `if (<id> <cmp>)` guard-clause spacing variant", () => {
		const lines = [
			"total / count if (n > 0)",
			"total / count if  (n > 0)",
			"total / count if (  n > 0)",
			"total / count if (count > 0)",
			"total / count if (n  > 0)",
			"total / count if (n >  0)",
			"total / count if (n !=  0)",
			"total / count if (n !==  0)",
			"total / count if (n > 0  )",
		];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});

	// test-contract: invariant — module doc branch 3: the JS/Go ternary
	// `<id> > 0 ? a / <id> : 0` form. Same per-gap spacing battery, plus the
	// zero-space `id>0` shape (closes a same-line `[^A-Za-z_$]` alternate-match
	// exploit where a boundary-adjacent space would otherwise stand in for
	// the identifier).
	it("recognizes every ternary guard-clause spacing variant", () => {
		const lines = [
			"n > 0 ? a / n : 0",
			"count > 0 ? a / count : 0",
			"count>0 ? a / count : 0",
			"n  > 0 ? a / n : 0",
			"n >  0 ? a / n : 0",
			"n != 0 ? a / n : 0",
			"n !=  0 ? a / n : 0",
			"n > 0  ? a / n : 0",
		];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});

	// test-contract: invariant — module doc branch 4: the `<id> && a / <id>`
	// short-circuit form. Same per-gap spacing battery, plus the zero-space
	// `id&&` shape for the same alternate-match reason as the ternary case.
	it("recognizes every short-circuit guard-clause spacing variant", () => {
		const lines = [
			"n && a / n",
			"count && a / count",
			"count&&a / count",
			"n  && a / n",
			"n &&  a / n",
			"n && total / n",
			"n && a  / n",
			"n && a /  n",
		];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts")).toEqual([]);
	});
});
