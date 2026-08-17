// Mutation-hardening tests for gitignored-write.ts, added to kill survivors
// from a mutation-testing sweep (kill-brief:
// scratch/fleet-r2/kill-briefs/src_harness_checks_gitignored-write.ts.json).
//
// Every assertion here was empirically verified against a shadow-mutated
// copy of the module (scratch/probes/mutant-shadow-runner.ts +
// gitignored-write-shadow-verify.mts): the assertion passes against the real
// module and FAILS against the specific mutant it targets. See that
// directory for the verification harness and the full per-mutant report.
//
// Labeling follows the check-evidence convention: each describe names its
// direction ("must fire" / "must NOT fire"); some cases use a P/N prefix
// directly on the `it()` title for finer-grained pairing.

import { describe, expect, it } from "vitest";
import { detectGitignoredWrites } from "./gitignored-write.js";

const TS = "src/setup/init.ts";

function everythingIgnored(_p: string): boolean {
	return true;
}

function ignoredExact(target: string) {
	return (p: string) => p === target;
}

function ignoredPrefix(prefix: string) {
	return (p: string) => p.startsWith(prefix);
}

// ─── isEphemeralTarget: backslash normalization ────────────────────────────
// Kills: StringLiteral "/" -> "" in isEphemeralTarget's
// `resolvedPath.replace(/\\/g, "/")`. Under the mutant, backslashes are
// stripped instead of converted to "/", so a Windows-style ephemeral segment
// boundary ("tmp\file" -> "tmp/file") never forms and the ephemeral check
// wrongly says "not ephemeral" -- letting a finding through it should skip.

describe("detectGitignoredWrites — isEphemeralTarget backslash normalization (must NOT fire)", () => {
	it("P1: does not flag a Windows-style path whose ephemeral segment is separated by a single backslash", () => {
		const code = 'writeFileSync("tmp\\caps.json", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P2: recognizes a backslash-separated 'logs' segment as ephemeral too", () => {
		const code = 'writeFileSync("logs\\run.txt", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── extractStringLiteral: template-literal branch ─────────────────────────
// Kills: the tmplMatch ConditionalExpression->false mutant (disables the
// whole template-literal branch), the `*` quantifier removal (requires
// exactly 1 char), and the charclass negation `[^`$]*` -> `[`$]*`.

describe("detectGitignoredWrites — template-literal path resolution (must fire)", () => {
	it("P1: resolves a template-literal path with normal multi-char content", () => {
		const code = "writeFileSync(`.interlinked/caps.json`, data);";
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: "writeFileSync(`.interlinked/caps.json`, data);" }]);
	});

	it("P2: resolves a template literal whose content is a single character", () => {
		const code = "writeFileSync(`a`, data);";
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([{ line: 1, text: "writeFileSync(`a`, data);" }]);
	});

	it("P3: resolves an empty template literal", () => {
		const code = "writeFileSync(``, data);";
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([{ line: 1, text: "writeFileSync(``, data);" }]);
	});
});

// ─── extractStringLiteral: regex anchors (both quote-style and template) ──
// Kills: the `^` and `$` anchor-removal mutants on both the sd (single/
// double quote) regex and the template regex. Without the LEADING anchor,
// the regex would match a quoted literal buried after junk; without the
// TRAILING anchor, it would match a quoted literal followed by junk.

describe("detectGitignoredWrites — literal regex anchors (must NOT fire)", () => {
	it("P1: does not resolve a double-quoted literal preceded by non-literal prefix junk", () => {
		// Raw first arg ends up as: x"abc" (junk before the opening quote).
		const code = 'writeFileSync(x"abc", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P2: does not resolve a double-quoted literal followed by non-literal suffix junk", () => {
		// Raw first arg ends up as: "abc"x (junk after the closing quote).
		const code = 'writeFileSync("abc"x, data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P3: does not resolve a template literal preceded by non-literal prefix junk", () => {
		const code = "writeFileSync(x`abc`, data);";
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P4: does not resolve a template literal followed by non-literal suffix junk", () => {
		const code = "writeFileSync(`abc`x, data);";
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── splitTopLevelArgs / extractFirstArg: comma-inside-string preservation ─
// Kills: the inStr-handling ConditionalExpression/BlockStatement mutants and
// the 3-way ('"'||"'"||"`") / 2-way / atomic quote-open-detection mutants,
// in BOTH the outer-call scan (extractFirstArg) and the join-segment scan
// (splitTopLevelArgs) — exercised once per quote type in each context.

describe("detectGitignoredWrites — comma inside a quoted literal must not split the call (must fire)", () => {
	it("P1: a comma inside a double-quoted bare literal does not split the outer call's arguments", () => {
		const code = 'writeFileSync(".interlinked/a,b.json", data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(".interlinked/a,b.json", data);' }]);
	});

	it("P2: a comma inside a single-quoted bare literal does not split the outer call's arguments", () => {
		const code = "writeFileSync('.interlinked/a,b.json', data);";
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: "writeFileSync('.interlinked/a,b.json', data);" }]);
	});

	it("P3: a comma inside a backtick-quoted bare literal does not split the outer call's arguments", () => {
		const code = "writeFileSync(`.interlinked/a,b.json`, data);";
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: "writeFileSync(`.interlinked/a,b.json`, data);" }]);
	});

	it("P4: a comma inside a double-quoted join() segment does not split that segment", () => {
		const code = 'writeFileSync(join(".interlinked", "a,b.json"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join(".interlinked", "a,b.json"), data);' }]);
	});

	it("P5: a comma inside a single-quoted join() segment does not split that segment", () => {
		const code = "writeFileSync(join('.interlinked', 'a,b.json'), data);";
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: "writeFileSync(join('.interlinked', 'a,b.json'), data);" }]);
	});

	it("P6: a comma inside a backtick-quoted join() segment does not split that segment", () => {
		const code = "writeFileSync(join(`.interlinked`, `a,b.json`), data);";
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: "writeFileSync(join(`.interlinked`, `a,b.json`), data);" }]);
	});
});

// ─── extractFirstArg: outer-call paren depth-tracking ──────────────────────
// Kills: `(` open/close ConditionalExpression + LogicalOperator mutants
// governing whether a nested call's own parens (and the commas inside them)
// are correctly balanced so the OUTER call's own top-level comma is found in
// the right place.

describe("detectGitignoredWrites — nested parens in the outer call's first argument (must fire / must NOT fire)", () => {
	it("P1: a two-segment join() call resolves correctly (parens around its own comma-separated args balance)", () => {
		const code = 'writeFileSync(join("a", "b"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact("a/b"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join("a", "b"), data);' }]);
	});

	it("P2: a three-segment join() call resolves correctly", () => {
		const code = 'writeFileSync(join("a", "b", "c"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact("a/b/c"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join("a", "b", "c"), data);' }]);
	});

	it("N1: a join() segment that is itself a paren call (non-literal) still nulls resolution (belt-and-suspenders on the segment gate)", () => {
		const code = 'writeFileSync(join("a", f(1,2)), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("N2: a join() segment containing an unquoted bracketed array literal still nulls resolution", () => {
		const code = 'writeFileSync(join("a", x[0,1]), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("N3: a join() segment containing an unquoted bracketed object literal still nulls resolution", () => {
		const code = 'writeFileSync(join("a", x{b:1,c:2}), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── Escaped quote adjacent to the string's real closing quote ─────────────
// Kills: the escape-skip ConditionalExpression/BlockStatement/StringLiteral
// mutants in extractFirstArg AND splitTopLevelArgs. An escaped quote (`\"`)
// must be consumed as one unit so it does not prematurely close the string
// — tested once as the sole outer-call literal (comma right after matters)
// and once as a NON-FINAL join() segment (so a real comma right after the
// corrupted segment would be swallowed under a broken escape-skip).

describe("detectGitignoredWrites — escaped quote before the real closing quote (must fire)", () => {
	it("P1: an escaped internal quote in the outer call's bare literal does not truncate the string early", () => {
		const code = 'writeFileSync(".interlinked/a\\"b.json", data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(".interlinked/a\\"b.json", data);' }]);
	});

	it("P2: an escaped internal quote in a join() segment followed by another segment resolves all three segments correctly", () => {
		// The escaped quote sits in the MIDDLE segment; a real top-level comma
		// follows it (before "c.json") — a broken escape-skip corrupts the
		// in-string tracking, swallows that comma, and merges segment 2+3
		// into one non-clean value that no longer equals the expected join.
		const code = 'writeFileSync(join(".interlinked", "a\\"b.json", "c.json"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact('.interlinked/a\\"b.json/c.json'));
		expect(results).toEqual([
			{ line: 1, text: 'writeFileSync(join(".interlinked", "a\\"b.json", "c.json"), data);' },
		]);
	});
});

// ─── resolvePathArg: absolute-path detection (both branches, anchored) ─────
// Kills: the `[A-Za-z]:\\` drive-letter regex's `^` anchor removal in BOTH
// the bare-literal branch and the joined-path branch. Without the anchor,
// a drive-letter-shaped substring ANYWHERE in the string (not just at
// position 0) would be wrongly treated as absolute.

describe("detectGitignoredWrites — drive-letter absolute-path anchor (must fire)", () => {
	it("P1: a bare literal containing a drive-letter-like pattern NOT at the start still resolves (not absolute)", () => {
		const code = 'writeFileSync("x/C:\\y.json", data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact("x/C:\\y.json"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync("x/C:\\y.json", data);' }]);
	});

	it("P2: a join() segment containing a drive-letter-like pattern NOT at the joined start still resolves", () => {
		const code = 'writeFileSync(join("x", "C:\\y.json"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact("x/C:\\y.json"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join("x", "C:\\y.json"), data);' }]);
	});

	it("N1: a bare literal genuinely starting with a Windows drive letter is skipped as absolute", () => {
		const code = 'writeFileSync("C:\\\\Windows\\\\x.json", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("N2: a join() call whose first segment is a Windows drive letter is skipped as absolute", () => {
		const code = 'writeFileSync(join("C:\\\\Windows", "x.json"), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("N3: a literal starting with a DIGIT before the colon is NOT treated as a drive letter (char class, not just the colon-backslash shape)", () => {
		const code = 'writeFileSync("1:\\\\foo.json", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([{ line: 1, text: 'writeFileSync("1:\\\\foo.json", data);' }]);
	});

	it("N4: a join() call whose first segment starts with a digit-colon is NOT treated as a drive letter", () => {
		const code = 'writeFileSync(join("1:\\\\foo", "x.json"), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join("1:\\\\foo", "x.json"), data);' }]);
	});
});

// ─── splitTopLevelArgs: final-segment boundary (start<=length, slice(start)) ─
// Kills: the `start <= argsRaw.length` -> `start < argsRaw.length`
// EqualityOperator mutant (drops the trailing empty segment when a join()
// call ends in a bare trailing comma) and the `argsRaw.slice(start)` ->
// `argsRaw` MethodExpression mutant (the final segment would be the WHOLE
// inner-args text, not just the remainder after the last comma).

describe("detectGitignoredWrites — join() final-segment slicing (must NOT fire / must fire)", () => {
	it("N1: a trailing comma with nothing after it inside join() produces an empty final segment, which nulls resolution", () => {
		// Correct behavior: splitTopLevelArgs(`".x",`) => ['".x"', ''] — the
		// empty string fails the literal check, so the whole call is null.
		// Under the <-instead-of-<= mutant the empty trailing segment is
		// silently dropped, leaving only ['".x"'] which DOES resolve.
		const code = 'writeFileSync(join(".x",), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact(".x"));
		expect(results).toEqual([]);
	});

	it("P1: the final join() segment is exactly the text after the last comma, not the whole inner-args string", () => {
		// Under the argsRaw.slice(start)->argsRaw mutant, the final push
		// would re-include the first segment + comma, producing a garbled
		// (but still non-null, due to regex backtracking) resolved value
		// that does not exactly equal the correct ".a/.b".
		const code = 'writeFileSync(join(".a", ".b"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact(".a/.b"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join(".a", ".b"), data);' }]);
	});
});

// ─── extractFirstArg: stray unmatched CLOSE bracket right after a literal ──
// Kills: the `]`/`}` (close) atomic ConditionalExpression + StringLiteral
// mutants. Reaching depth 0 via ANY close-bracket character must terminate
// (and discard) that character from the extracted argument text — this is
// the one construction where the close-bracket's self-discarding behavior
// (the terminating char is excluded from the returned slice) makes the
// depth-tracking bug observable through to resolvePathArg.

describe("detectGitignoredWrites — stray unmatched close bracket after a literal (must fire)", () => {
	it("P1: a stray ']' right after a clean literal is silently consumed, and the literal still resolves", () => {
		const code = 'writeFileSync(".interlinked/x.json"], data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(".interlinked/x.json"], data);' }]);
	});

	it("P2: a stray '}' right after a clean literal is silently consumed, and the literal still resolves", () => {
		const code = 'writeFileSync(".interlinked/x.json"}, data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(".interlinked/x.json"}, data);' }]);
	});
});

// ─── resolvePathArg: joinCallMatch regex shape (anchors + \s*) ─────────────
// Kills: the `^` anchor removal (would match "join(" ANYWHERE, not just at
// the start), the `$` anchor removal (would accept trailing junk after the
// closing paren), and the `\s*` -> `\S*` mutant (would reject a legitimate
// space between the function name and its opening paren).

describe("detectGitignoredWrites — joinCallMatch regex shape (must NOT fire / must fire)", () => {
	it("N1: 'join(' appearing mid-identifier (not at the start) is NOT treated as a join call", () => {
		const code = 'writeFileSync(xjoin(".a", ".b"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact(".a/.b"));
		expect(results).toEqual([]);
	});

	it("N2: trailing property access after join()'s closing paren is NOT treated as a resolvable join call", () => {
		const code = 'writeFileSync(join(".a", ".b").foo, data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact(".a/.b"));
		expect(results).toEqual([]);
	});

	it("P1: whitespace between the function name and its opening paren is accepted", () => {
		const code = 'writeFileSync(join (".a", ".b"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact(".a/.b"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join (".a", ".b"), data);' }]);
	});
});

// ─── resolvePathArg: multi-slash collapse ──────────────────────────────────
// Kills: the `/\/+/g` -> `/\//g` Regex mutant (drops the `+` quantifier, so
// each already-single "/" gets replaced with itself — a no-op — instead of
// collapsing runs of consecutive slashes down to one).

describe("detectGitignoredWrites — multi-slash collapse (must fire)", () => {
	it("P1: joining segments that create consecutive slashes collapses them to exactly one", () => {
		const code = 'writeFileSync(join(".interlinked/", "/x.json"), data);';
		const results = detectGitignoredWrites(code, TS, ignoredExact(".interlinked/x.json"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join(".interlinked/", "/x.json"), data);' }]);
	});
});

// ─── lineNumberAtOffset: exercised across a multi-line join() call ────────
// Kills the LogicalOperator (&&->||) and the leading ConditionalExpression
// (i<offset->true) mutants on lineNumberAtOffset's guard, by putting real
// newline characters INSIDE the scanned prefix (a join() call whose
// arguments span multiple lines, ahead of a comma the scan must still find
// at the right offset).

describe("detectGitignoredWrites — line numbering across multi-line call arguments (must fire)", () => {
	it("P1: a join() call whose arguments span multiple lines still resolves and reports line 1 for the call site", () => {
		const code = 'writeFileSync(join(\n\t".interlinked",\n\t"x.json"\n), data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results.length).toBe(1);
		expect(results[0]?.line).toBe(1);
	});
});

// ─── detectGitignoredWrites own logic: rawLine.trim() + file-extension regex
// Kills: `rawLine.trim()` -> `rawLine` (leading whitespace would leak into
// the reported `text`), and the trailing `$` anchor removal on the
// JS/TS-extension regex (would match a filename that merely CONTAINS ".ts"
// as a substring, not just one that ends with a tracked extension).

describe("detectGitignoredWrites — reported text is trimmed and the file-extension check is anchored", () => {
	it("P1: the reported finding text has no leading whitespace even when the source line is indented", () => {
		const code = '\t\t   writeFileSync(".interlinked/x.json", data);';
		const results = detectGitignoredWrites(code, TS, ignoredPrefix(".interlinked/"));
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(".interlinked/x.json", data);' }]);
	});

	it("N1: a filePath that merely CONTAINS '.ts' as a substring (not as its trailing extension) is not scanned", () => {
		const code = 'writeFileSync(".interlinked/x.json", data);';
		const results = detectGitignoredWrites(code, "a.tsvfile", ignoredPrefix(".interlinked/"));
		expect(results).toEqual([]);
	});
});

// ─── Module-level ephemeral regexes: trailing $ anchor on both patterns ────
// Kills: the `$` anchor removal on EPHEMERAL_SEGMENT_RE (a segment name
// like "tmp" followed by end-of-string must still count, not just when
// followed by "/") and on EPHEMERAL_EXT_RE (an extension ending exactly in
// ".log" etc. must still count when it's genuinely the trailing extension).

describe("detectGitignoredWrites — ephemeral-segment/extension trailing anchor (must NOT fire)", () => {
	it("P1: a path ending exactly in an ephemeral segment name (no trailing slash) is still recognized as ephemeral", () => {
		const code = 'writeFileSync("a/tmp", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("N1: a filename that merely CONTAINS '.log' as a substring (not as its trailing extension) is NOT treated as ephemeral", () => {
		const code = 'writeFileSync("output.logger", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([{ line: 1, text: 'writeFileSync("output.logger", data);' }]);
	});
});

// ─── Multiple write calls: independence and the 10-finding cap ────────────
// Re-verifies (with exact array-content assertions, not just length checks)
// that findings differ per-call independently, and that the loop-level
// `matches.length >= 10` cap stops scanning after the 10th finding.

describe("detectGitignoredWrites — multiple write calls (must fire selectively / capped)", () => {
	function ignoredUnderConfig(p: string): boolean {
		return p.startsWith("config/");
	}

	it("P1: only the calls whose resolved path is actually ignored produce findings, each on its own line", () => {
		const code = [
			'writeFileSync("config/policy.json", a);',
			'writeFileSync("committed/schema.json", b);',
			'writeFileSync(join("config", "caps.json"), c);',
		].join("\n");
		const results = detectGitignoredWrites(code, TS, ignoredUnderConfig);
		expect(results).toEqual([
			{ line: 1, text: 'writeFileSync("config/policy.json", a);' },
			{ line: 3, text: 'writeFileSync(join("config", "caps.json"), c);' },
		]);
	});

	it("P2: findings are capped at exactly 10 even when 15 qualifying calls exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) lines.push(`writeFileSync("config/file${i}.json", data);`);
		const results = detectGitignoredWrites(lines.join("\n"), TS, ignoredUnderConfig);
		expect(results.length).toBe(10);
		expect(results[9]?.line).toBe(10);
		expect(results[9]?.text).toBe('writeFileSync("config/file9.json", data);');
	});
});
