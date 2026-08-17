// Wave-3 (fleet W6, residue round) survivor-kill campaign for
// src/harness/checks/taste.ts. Companion to taste.test.ts,
// taste-mutation-kill.test.ts, and taste-mutation-kill-wave2.test.ts — this
// file targets the 14 mutants (of 82 residue survivors listed in
// scratch/fleet-r3/receipts/src_harness_checks_taste.ts.jsonl) that a large
// (2484-fixture) differential-fuzz corpus proved killable via
// scratch/fleet-r3/w6/taste-shadow-verify.mts. Every case below was verified
// empirically against a shadow-mutated copy of the real module before being
// copied here (build+import+diff, not hand-derivation) — the fixture text is
// reused verbatim from that harness's confirmed killers.
//
// Two shapes recur across the module-scope cases:
//  - `checkPositionalOptionalBoolean` and `checkManyOptionalParams` both gate
//    on the SAME module-level `JS_TS_FUNC_PATTERNS` array via
//    `.some((pat) => pat.test(trimmed))` — a boolean test only. Several
//    survivors there are regex-quantifier tweaks on an OPTIONAL prefix group
//    (`(?:export\s+)?`, `(?:async\s+)?`) that an unanchored `.test()` can
//    simply re-find past (documented — and empirically confirmed equivalent
//    — in taste-mutation-kill-wave2.test.ts's "freely re-anchorable" case).
//    The four killed here are NOT in that class: they sit strictly BETWEEN
//    the captured name and the params, where no later re-anchor point
//    exists, so a mismatched quantifier there genuinely breaks the match.
//  - `findPositionalOptionalBoolean`'s three terminal regexes are all
//    `^...$`-anchored. Dropping `^` or `$` turns a full-string check into a
//    substring search: a non-word filler character right after the captured
//    param name (defeating a dropped `^`) or trailing junk after the literal
//    boolean value (defeating a dropped `$`) makes the mutant match text the
//    anchored original correctly rejects.
import { describe, expect, it } from "vitest";
import { checkCatchAndIgnore, checkFunctionArity, checkPositionalOptionalBoolean } from "./taste.js";

describe("checkPositionalOptionalBoolean — module-scope JS_TS_FUNC_PATTERNS boundary kills", () => {
	// Kills mutantId 2648499f7eafcc80 AND 46a329723b821ecc: the whitespace
	// immediately after the captured function name, and immediately after
	// the optional generic group, both sit between two REQUIRED literals
	// ("foo" and "(") with no re-anchor point — unlike export/async, a
	// mismatched \S* there cannot re-find "function" later in the string.
	it("P: space on both sides of a generic block is required for the module-scope gate to re-engage", () => {
		const code = "function foo <T> (flag?: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] function foo <T> (flag?: boolean) {}" },
		]);
	});

	// Kills mutantId 5d0ce0d6586ff08b: the whitespace between the captured
	// arrow-const name and the optional `:Type` group is NOT compensated by
	// any later `[^=]+` group (that one only starts once the colon has
	// already been matched), so \S* there genuinely can't consume it.
	it("P: double space between an arrow-const name and its colon-type annotation", () => {
		const code = "const build  : Handler = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] const build  : Handler = (flag?: boolean) => flag;" },
		]);
	});

	// Kills mutantId b7c5a6109e8365cd: with zero whitespace after the colon,
	// a `\s` (exactly-one-char) mutant inside the optional type group can't
	// match at all, and — unlike the sibling inner-\s*→\S* mutant — there is
	// no `[^=]+` fallback for a REQUIRED single char that isn't there.
	it("P: zero space directly after the colon in an arrow-const type annotation", () => {
		const code = "const build:Handler = (flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] const build:Handler = (flag?: boolean) => flag;" },
		]);
	});

	// Kills mutantId 87a57474f0f29e93 AND ba84a400cfdf2c2b: zero space on
	// BOTH sides of the arrow-const's "=" independently breaks the
	// pre-equals and post-equals \s→exactly-one-char mutants (each requires
	// a whitespace char that isn't there; neither is masked by a
	// neighboring group the way the \S* variants at the same positions are).
	it("P: zero space on both sides of the arrow-const equals sign", () => {
		const code = "const build:Handler=(flag?: boolean) => flag;";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([
			{ line: 1, text: "[positional optional boolean: flag] const build:Handler=(flag?: boolean) => flag;" },
		]);
	});
});

describe("checkPositionalOptionalBoolean — findPositionalOptionalBoolean anchor kills", () => {
	// Kills mutantId 62b1ed4505bb1cac: the `\s*` between `?` and `:` in
	// `/^\?\s*:\s*boolean\s*$/` becomes `\S*`; a second literal `?`
	// immediately after the first is non-whitespace, so the mutant's \S*
	// swallows it and the match still completes — the anchored original
	// requires that position to be whitespace-or-nothing before the colon.
	it("N: a doubled '??' optional marker is not a valid positional optional boolean", () => {
		const code = "function g(flag??: boolean) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});

	// Kills mutantId b5a1b21481fe0472: dropping the trailing `$` from
	// `/^:\s*boolean\s*=\s*(?:true|false)\s*$/` turns "must match to the end"
	// into "must match a prefix" — trailing non-whitespace content after the
	// literal `true`/`false` value defeats only the anchored original.
	it("N: trailing content after the default-value literal is not a valid positional optional boolean", () => {
		const code = "function g(flag: boolean = true extra) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});

	// Kills mutantId ef2d491b58b26e01 AND 9a1b6c3b2f536d01: dropping the
	// leading `^` from either `/^:\s*boolean\s*=.../ ` or `/^=\s*(?:true|
	// false)\s*$/` lets an unanchored search skip a non-word filler
	// character right after the captured param name and still find a
	// validly `$`-terminated match later in the string — the SAME fixture
	// exposes both mutants in isolation (each is tested with only its own
	// lexeme replaced, so the sibling pattern stays anchored and still
	// correctly rejects the input on its own).
	it("N: a non-word filler between the param name and its colon-type is not a valid positional optional boolean", () => {
		const code = "function g(flag~: boolean = true) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});
});

describe("checkFunctionArity — destructure-skip check2 boundary kill", () => {
	// Kills mutantId d256086213c610ce. Unlike check1
	// (`/^\s*\{/.test(paramStr) && countTopLevelCommas(paramStr) === 1`),
	// check2 (`/^\s*\{[^}]*\}\s*$/`) has NO companion count===1 gate, so a
	// mismatched leading quantifier there is NOT masked by the same
	// "count===1 implies paramCount===1 implies never reported anyway"
	// argument that makes check1's analogous mutants equivalent. Gluing a
	// trailing "{f}" onto a 5-item comma list makes the WHOLE paramStr
	// satisfy the mutant's unanchored `\S*{[^}]*}\s*$` (the \S* swallows
	// "a,b,c,d,e" on its way to the brace) while every comma before the
	// brace is still genuinely top-level (nothing has opened a bracket yet),
	// so countTopLevelCommas legitimately returns 5 — at/over the arity
	// threshold, so the pristine check reports it and the mutant's
	// wrongly-engaged skip swallows the finding.
	it("P: five top-level params followed by a brace suffix is still reported (not swallowed by the destructure skip)", () => {
		const code = "function foo(a,b,c,d,e{f}) { return 1; }";
		expect(checkFunctionArity(code, "f.ts")).toEqual([
			{ line: 1, text: "[5 params → consider options object] function foo(a,b,c,d,e{f}) { return 1; }" },
		]);
	});
});

describe("checkCatchAndIgnore — return-default regex boundary kills", () => {
	// Kills mutantId 8304faa449aaebaf: `void\s+0` (1+ whitespace) mutated to
	// `void\s0` (exactly one) — a genuinely double-spaced `void  0` breaks
	// only the mutant.
	it("P: 'void' with two spaces before the trailing zero is still a recognized default return", () => {
		const code = "try { doWork(); } catch (e) { return void  0; }";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: code }]);
	});

	// Kills mutantId 6e5f4c97c9f09b11: `\}?` (optional close brace) mutated
	// to `\}` (required). collectCatchBody's 8-line collection window can
	// legitimately end with `return null;` as the LAST captured line while
	// the real closing `}` sits one line further out (padded here with six
	// no-op statements) — bodyText then has no trailing `}` at all, which
	// only the mutant's now-mandatory `\}` rejects.
	it("P: a catch body whose closing brace falls outside the 8-line collection window is still flagged", () => {
		const code =
			"try {\n  doWork();\n} catch (e) {\n  a();\n  b();\n  c();\n  d();\n  e();\n  f();\n  return null;\n}";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 3, text: "} catch (e) {" }]);
	});

	// Kills mutantId fbe646edecf383ad: the trailing `\s*` (after the
	// optional close brace) mutated to `\S*` — genuine trailing whitespace
	// on the source line after the closing brace can never be consumed by a
	// NON-whitespace quantifier, so only the mutant fails to match.
	it("P: trailing whitespace on the line after the closing brace does not suppress the flag", () => {
		const code = "try { doWork(); } catch (e) { return null; }  ";
		expect(checkCatchAndIgnore(code, "h.ts")).toEqual([{ line: 1, text: "try { doWork(); } catch (e) { return null; }" }]);
	});

	// Kills mutantId d4da55fedfa9b98d (round-2/fresh-eyes pass): the
	// trailing `\s*` in the `: boolean = (true|false)` terminal regex
	// mutated to `\S*`. `\S*` can still match zero characters, so it does
	// NOT change the pure "nothing trailing" case — but it also accepts
	// trailing NON-whitespace junk directly glued onto "true"/"false" with
	// no separating space, which `\s*$` correctly rejects. `truex` is not
	// the literal `true`; only the mutant's `\S*$` lets the dangling `x`
	// through.
	// test-contract: boundary — `: boolean = true` requires the literal
	// token `true`/`false`, not a prefix of a longer identifier.
	it("P: a boolean default glued to trailing non-whitespace text is not a real `true`/`false` literal", () => {
		const code = "function setUser(name: string, flag: boolean = truex) {}";
		expect(checkPositionalOptionalBoolean(code, "f.ts")).toEqual([]);
	});

	// Kills mutantId e29a6c764260491c: `.slice(0, 150)` dropped from the
	// reported text's construction. A trailing `// comment` would be the
	// obvious way to inflate line length past 150 chars, but that trips
	// isHandledCatchBody's OWN "//"/"/*" explanatory-comment suppression
	// before truncation is ever reached (see "N: explanatory comment
	// suppresses the flag" below) — padding the TRY block with a long,
	// keyword-free call avoids that entirely.
	it("P: a reported line over 150 characters is truncated to exactly 150", () => {
		const code =
			"try { processInputDataForFurtherComputation(argOne, argTwo, argThree, argFour, argFive, argSix, argSeven, argEight, argNine, argTen); } catch (e) { return null; }";
		expect(code.length).toBeGreaterThan(150);
		const matches = checkCatchAndIgnore(code, "h.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toHaveLength(150);
		expect(matches[0]?.text).toBe(code.slice(0, 150));
	});
});
