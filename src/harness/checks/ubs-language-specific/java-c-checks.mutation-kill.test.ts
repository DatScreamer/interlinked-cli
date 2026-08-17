// Mutation-kill companion for `java-c-checks.ts` (fleet W11, lean mode — see
// scratch/fleet-r3/CONTRACT-W6.md). 81 survivors at inventory time; every
// case below targets specific mutantIds (full map in
// scratch/fleet-r3/receipts/src_harness_checks_ubs-language-specific_java-c-checks.ts.jsonl).
//
// `isOptionalGetGuarded` is module-private, so its cases drive it THROUGH
// the exported `checkJavaOptionalGet` entry point and assert the exact
// `InlineMatch[]` result (never `.length` alone — a mutant that replaces the
// pushed object with `{}` still has `.length === 1`).
//
// 2 of the 81 survivors are `suspected_equivalent` (one-line structural
// argument here; full argument in the receipts file):
//  - checkJavaOptionalGet's `optionalNames.size === 0` guard
//    (67c27ce67636d4ca -> `false`): the only other read of `optionalNames` is
//    `for (const name of optionalNames)`, which is zero iterations when the
//    set is empty regardless of whether the early return fires -- removing
//    the guard cannot change the returned `matches`.
//  - isOptionalGetGuarded's backward-scan bound `j < i` (117d2ddd020d2d06 ->
//    `j <= i`): the extra `j === i` iteration re-tests the CURRENT line
//    without stripping the call (`strippedLines[i]`, not
//    `line.replace(callRe, "")`), but `callRe` always consumes the fixed
//    literal `"x.get()"` in full and none of guardRe's method names
//    (isPresent/orElse/orElseGet/orElseThrow/ifPresent/ifPresentOrElse/map/
//    flatMap/filter) can be completed by reusing any suffix of `"get()"` --
//    so a guard match on the raw current line can never diverge from the
//    same-line check that already ran on it.
import { describe, expect, it } from "vitest";
import { checkJavaOptionalGet, checkUnsafeFormatString } from "./java-c-checks.js";

describe("checkJavaOptionalGet — declRegex whitespace boundary", () => {
	// declRegex is `\bOptional\s*<[^>]+>\s+([A-Za-z_$][\w$]*)\s*=`. Its three
	// quantifier gaps (before `<`, after `>`, before `=`) each accept ANY
	// count of whitespace, not exactly one — a realistically reformatted
	// declaration with irregular spacing at all three gaps must still be
	// recognized so the later unguarded `.get()` gets flagged.
	// test-contract: boundary — declRegex whitespace-gap quantifiers
	it("recognizes a declaration with irregular whitespace around `<...>` and `=`", () => {
		const code = "Optional  <String>  x= svc.find();\nreturn x.get();";
		expect(checkJavaOptionalGet(code, "Sample.java")).toEqual([
			{ line: 2, text: "return x.get();" },
		]);
	});
});

describe("checkJavaOptionalGet — match cap + line indexing", () => {
	// `if (matches.length >= 10) break;` is the documented result cap. 12
	// independently-unguarded `.get()` lines must yield EXACTLY the first 10
	// (lines 2-11), not 11 (off-by-one) or 12 (no cap); the exact `line`
	// numbers also pin `i + 1` (not `i - 1`) and the pushed object shape.
	// test-contract: boundary — documented 10-result cap
	it("caps collected matches at exactly 10, indexed by physical line", () => {
		const declLine = "Optional<String> x = f();";
		const callLines = Array.from({ length: 12 }, () => "x.get();");
		const code = [declLine, ...callLines].join("\n");
		const expected = Array.from({ length: 10 }, (_, idx) => ({
			line: idx + 2,
			text: "x.get();",
		}));
		expect(checkJavaOptionalGet(code, "Sample.java")).toEqual(expected);
	});
});

describe("checkJavaOptionalGet — reported text trim/truncate", () => {
	// The pushed `text` is `originalLines[i].trim().slice(0, 150)`.
	// test-contract: invariant — leading/trailing whitespace must not leak into reported text
	it("trims leading/trailing whitespace from the reported match text", () => {
		const code = "Optional<String> x = f();\n   x.get();   ";
		expect(checkJavaOptionalGet(code, "Sample.java")).toEqual([
			{ line: 2, text: "x.get();" },
		]);
	});

	// test-contract: boundary — trimmed text is additionally truncated to 150 chars
	it("truncates the reported match text to 150 characters", () => {
		const code = `Optional<String> x = f();\nx.get(); ${"x".repeat(200)}`;
		expect(checkJavaOptionalGet(code, "Sample.java")).toEqual([
			{ line: 2, text: `x.get(); ${"x".repeat(141)}` },
		]);
	});
});

describe("isOptionalGetGuarded (via checkJavaOptionalGet) — guard scan boundary", () => {
	// The same-line guard check runs `guardRe.test(line.replace(callRe, ""))`
	// — it strips the `.get()` call's OWN text using the empty string before
	// testing for a guard. Construction: `x.x.get()map();` — the leading
	// `x.` is deliberately redundant. `callRe` matches only the SECOND
	// `x.get()` (word-boundary anchored, can't start mid-identifier); once
	// that exact span is excised, the surrounding text splices into
	// `x.map();`, a real guard call. This pins the exact replacement VALUE
	// ("" vs any placeholder) — a non-empty placeholder breaks the splice.
	// test-contract: invariant — call text is stripped with the empty string before the same-line guard test
	it("recognizes a guard formed by splicing across the excised call text", () => {
		const code = "Optional<String> x = f();\nx.x.get()map();";
		expect(checkJavaOptionalGet(code, "Sample.java")).toEqual([]);
	});

	// When no guard exists on the call's own line NOR any earlier line, the
	// backward scan (`for (let j = 0; j < i; j++)`) must exhaust without
	// finding one and the call must be flagged. The declaration-only line 1
	// supplies a real (non-guarding) earlier line so the loop executes.
	// test-contract: invariant — backward scan must exhaust and flag when no guard exists anywhere earlier
	it("flags an unguarded call when no earlier line contains a guard either", () => {
		const code = "Optional<String> x = f();\nx.get();";
		expect(checkJavaOptionalGet(code, "Sample.java")).toEqual([
			{ line: 2, text: "x.get();" },
		]);
	});
});

describe("checkUnsafeFormatString — extension gate", () => {
	// Module doc: flagged "on `.c`/`.h`/C++ files only". `.c` is already
	// covered by the existing companion smoke test; each extension below is
	// an independently load-bearing branch of `isC`/`isCpp`.
	// test-contract: public-api — .h is a load-bearing isC branch
	it("supports .h files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.h")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: public-api — .cpp is a load-bearing isCpp branch
	it("supports .cpp files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.cpp")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: public-api — .cc is a load-bearing isCpp branch
	it("supports .cc files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.cc")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: public-api — .cxx is a load-bearing isCpp branch
	it("supports .cxx files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.cxx")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: public-api — .hpp is a load-bearing isCpp branch
	it("supports .hpp files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.hpp")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: public-api — .hxx is a load-bearing isCpp branch
	it("supports .hxx files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.hxx")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: public-api — .hh is a load-bearing isCpp branch
	it("supports .hh files", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "a.hh")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});
});

describe("checkUnsafeFormatString — vendored/fixture path gate", () => {
	// `isVendoredOrFixturePath` suppresses vendored paths even though the
	// extension and format pattern both otherwise qualify.
	// test-contract: public-api — vendored paths are suppressed unconditionally
	it("does not flag a vendored C file", () => {
		expect(checkUnsafeFormatString("printf(fmt);", "vendor/lib.c")).toEqual([]);
	});
});

describe("checkUnsafeFormatString — match cap + line indexing", () => {
	// `if (matches.length >= MATCH_LIMIT) break;` (MATCH_LIMIT = 10,
	// `_shared.ts`). 12 independently-matchable printf lines must yield
	// EXACTLY the first 10, not 11 or unlimited; the exact `line` numbers
	// also pin `i + 1`, the pushed object shape, and line-indexed splitting.
	// test-contract: boundary — documented 10-result MATCH_LIMIT cap
	it("caps collected matches at exactly 10, indexed by physical line", () => {
		const lines = Array.from({ length: 12 }, (_, idx) => `printf(fmt${idx});`);
		const expected = Array.from({ length: 10 }, (_, idx) => ({
			line: idx + 1,
			text: `printf(fmt${idx});`,
		}));
		expect(checkUnsafeFormatString(lines.join("\n"), "a.c")).toEqual(expected);
	});
});

describe("checkUnsafeFormatString — reported text trim/truncate", () => {
	// The pushed `text` is `originalLines[i].trim().slice(0, 150)`.
	// test-contract: invariant — leading/trailing whitespace must not leak into reported text
	it("trims leading/trailing whitespace from the reported match text", () => {
		expect(checkUnsafeFormatString("  printf(fmt);  ", "a.c")).toEqual([
			{ line: 1, text: "printf(fmt);" },
		]);
	});

	// test-contract: boundary — trimmed text is additionally truncated to 150 chars
	it("truncates the reported match text to 150 characters", () => {
		const code = `printf(fmt); ${"x".repeat(200)}`;
		expect(checkUnsafeFormatString(code, "a.c")).toEqual([
			{ line: 1, text: `printf(fmt); ${"x".repeat(137)}` },
		]);
	});
});

describe("checkUnsafeFormatString — printf format-slot regex boundary", () => {
	// onePosRe's `\s*` gap between `printf` and `(` accepts ANY whitespace
	// count, not just zero.
	// test-contract: boundary — onePosRe whitespace gap before open paren
	it("matches printf with whitespace before the open paren", () => {
		expect(checkUnsafeFormatString("printf (userFmt);", "a.c")).toEqual([
			{ line: 1, text: "printf (userFmt);" },
		]);
	});

	// test-contract: boundary — onePosRe whitespace gap after open paren
	it("matches printf with whitespace after the open paren", () => {
		expect(checkUnsafeFormatString("printf( userFmt);", "a.c")).toEqual([
			{ line: 1, text: "printf( userFmt);" },
		]);
	});

	// test-contract: boundary — onePosRe whitespace gap before terminator
	it("matches printf with whitespace before the closing paren", () => {
		expect(checkUnsafeFormatString("printf(userFmt );", "a.c")).toEqual([
			{ line: 1, text: "printf(userFmt );" },
		]);
	});

	// The terminator is the CLASS `[,)]` (comma OR close-paren), not its
	// negation. A single-character identifier removes any room for the
	// capture's `\w*` to backtrack around a negated class, pinning polarity.
	// test-contract: boundary — onePosRe terminator class polarity
	it("matches printf with a single-character format identifier", () => {
		expect(checkUnsafeFormatString("printf(f);", "a.c")).toEqual([
			{ line: 1, text: "printf(f);" },
		]);
	});
});

describe("checkUnsafeFormatString — sprintf/fprintf format-slot regex boundary", () => {
	// twoPosRe's `\s*` gaps (before `(`, after `(`, before the format
	// identifier) each accept any whitespace count, and the buffer-argument
	// class is `[^,]+?` (one-or-more non-comma), not a fixed count.
	// test-contract: boundary — twoPosRe whitespace gaps around the call
	it("matches sprintf with generous whitespace around the call", () => {
		expect(checkUnsafeFormatString("sprintf  (buf, fmt);", "a.c")).toEqual([
			{ line: 1, text: "sprintf  (buf, fmt);" },
		]);
	});

	// test-contract: boundary — twoPosRe whitespace gap after buffer-argument comma
	it("matches sprintf with whitespace after the buffer-argument comma", () => {
		expect(checkUnsafeFormatString("sprintf(buf,  fmt);", "a.c")).toEqual([
			{ line: 1, text: "sprintf(buf,  fmt);" },
		]);
	});

	// test-contract: boundary — twoPosRe format-identifier leading class polarity
	it("matches sprintf with no whitespace before the format identifier", () => {
		expect(checkUnsafeFormatString("sprintf(buf,fmt);", "a.c")).toEqual([
			{ line: 1, text: "sprintf(buf,fmt);" },
		]);
	});

	// test-contract: boundary — twoPosRe whitespace gap before terminator
	it("matches sprintf with whitespace before the closing paren", () => {
		expect(checkUnsafeFormatString("sprintf(buf,fmt  );", "a.c")).toEqual([
			{ line: 1, text: "sprintf(buf,fmt  );" },
		]);
	});

	// Terminator polarity (`[,)]`, not `[^,)]`), pinned with a
	// single-character identifier so `\w*` has no backtrack room.
	// test-contract: boundary — twoPosRe terminator class polarity
	it("matches sprintf with a single-character format identifier", () => {
		expect(checkUnsafeFormatString("sprintf(buf,f);", "a.c")).toEqual([
			{ line: 1, text: "sprintf(buf,f);" },
		]);
	});
});

describe("checkUnsafeFormatString — snprintf format-slot regex boundary", () => {
	// threePosRe's `\s*` gaps (before `(`, after `(`) each accept any
	// whitespace count, and the buffer-argument class is `[^,]+?`.
	// test-contract: boundary — threePosRe whitespace gaps around the call
	it("matches snprintf with generous whitespace around the call", () => {
		expect(checkUnsafeFormatString("snprintf  (buf, n, fmt);", "a.c")).toEqual([
			{ line: 1, text: "snprintf  (buf, n, fmt);" },
		]);
	});

	// The size-argument slot is skipped by its own `[^,]+?` (documented bug
	// fix: `snprintf(buf, n, "%s", x)` must not misread `n` as the format).
	// A size arg that is EXACTLY one whitespace character exercises the
	// boundary where the gap before it must be zero-or-more, not exactly
	// one, for the whole match to succeed at all.
	// test-contract: boundary — threePosRe size-slot gap quantifier (zero-or-more, not exactly-one)
	it("matches snprintf with a whitespace-only size argument", () => {
		expect(checkUnsafeFormatString("snprintf(buf, ,fmt);", "a.c")).toEqual([
			{ line: 1, text: "snprintf(buf, ,fmt);" },
		]);
	});

	// test-contract: boundary — threePosRe size-argument class accepts 2+ non-comma chars
	it("matches snprintf with a multi-character size argument", () => {
		expect(checkUnsafeFormatString("snprintf(buf,nn,fmt);", "a.c")).toEqual([
			{ line: 1, text: "snprintf(buf,nn,fmt);" },
		]);
	});

	// test-contract: boundary — threePosRe whitespace gap before terminator
	it("matches snprintf with whitespace before the closing paren", () => {
		expect(checkUnsafeFormatString("snprintf(buf,n,fmt  );", "a.c")).toEqual([
			{ line: 1, text: "snprintf(buf,n,fmt  );" },
		]);
	});

	// Terminator polarity (`[,)]`, not `[^,)]`) and the capture tail's
	// exact-vs-star quantifier, both pinned with a single-character format
	// identifier so `\w*` has no backtrack room.
	// test-contract: boundary — threePosRe terminator class polarity and capture-tail quantifier
	it("matches snprintf with a single-character format identifier", () => {
		expect(checkUnsafeFormatString("snprintf(buf,n,f);", "a.c")).toEqual([
			{ line: 1, text: "snprintf(buf,n,f);" },
		]);
	});
});
