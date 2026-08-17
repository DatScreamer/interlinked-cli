import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { extractFunctionShingles, findClones, shingleSet, tokenize, type FunctionShingles } from "./dry.js";

// Mutation-kill companion for dry.ts (scratch/fleet-r3/CONTRACT-W6.md, LEAN MODE).
// Targets the 33 killable survivors from
// `npx tsx src/index.ts mutation survivors --file src/harness/checks/dry.ts --json`.
//
// 13 further survivors on this file are NOT targeted here -- they are
// structurally equivalent given the surrounding code (one-line arguments
// recorded per mutantId in scratch/fleet-r3/receipts/harness-checks-dry.jsonl):
// jaccard's empty-set guard, its LogicalOperator variant, its two single-side
// ConditionalExpression variants, its small/large swap-condition (all 4
// variants), and its final union===0 guard are all provably redundant given
// Set.has() symmetry and the identity union = a.size + b.size - inter;
// extractFunctionShingles's `fns.length === 0` early-return is redundant
// because looping zero times over an empty array is already a no-op;
// shingleSet's `tokens.length < n` early-return is redundant because the
// for-loop's own `i + n <= tokens.length` condition already produces zero
// iterations in that case; buildEntry's `shingles.size < MIN_SHINGLES` guard
// is empirically unreachable because MIN_LOGICAL_LINES(5) already forces at
// least 5 distinct shingles once a function clears the first guard.

describe("tokenize -- TOKEN_RE boundary cases", () => {
	// TOKEN_RE's number alternative requires ONE-OR-MORE digits (`\d+`); a
	// single-digit (`\d`) mutant would split a multi-digit run into separate
	// one-character tokens.
	// test-contract: boundary — TOKEN_RE `\d+` must be greedy, not `\d`
	it("keeps a multi-digit integer as one token", () => {
		expect(tokenize("123")).toEqual(["123"]);
	});

	// The trailing `(?:\.\d+)?` makes the decimal part OPTIONAL; a mutant
	// that drops the `?` requires a decimal part, so a bare integer matches
	// no alternative at all and is silently dropped from the token stream.
	// test-contract: boundary — decimal suffix of TOKEN_RE must stay optional
	it("tokenizes a bare integer with no decimal point", () => {
		expect(tokenize("5")).toEqual(["5"]);
	});

	// The decimal group requires ONE-OR-MORE digits after the dot (`\.\d+`);
	// a single-digit mutant would consume only one decimal digit, splitting
	// the remainder into its own separate token.
	// test-contract: boundary — TOKEN_RE decimal digits must be greedy `\d+`
	it("keeps a multi-digit decimal as one token", () => {
		expect(tokenize("1.23")).toEqual(["1.23"]);
	});
});

describe("shingleSet -- window and key boundary cases", () => {
	// When tokens.length === n exactly, the for-loop's own
	// `i + n <= tokens.length` condition is satisfied once (i=0), producing
	// exactly one shingle. An EqualityOperator mutant on the early-return
	// guard (`<` -> `<=`) would treat this as "too few tokens" and wrongly
	// return an empty set instead.
	// test-contract: boundary — tokens.length===n is eligible, not excluded
	it("produces exactly one shingle when tokens.length equals n", () => {
		const result = shingleSet(["a", "b", "c", "d"], 4);
		expect(result.size).toBe(1);
	});

	// The shingle key must join tokens with a separator that cannot occur
	// inside a token (the null character), so two DIFFERENT windows never
	// collide into the same Set entry. With the real separator these two
	// boundary-adjacent windows join to different strings; with a ""
	// separator both collapse to the same string and the Set dedupes them to
	// one entry, undercounting distinct shingles.
	// test-contract: invariant — join separator must prevent token-boundary collisions
	it("keeps boundary-adjacent windows distinct via the null-character separator", () => {
		const result = shingleSet(["", "x", "y", "z", ""], 4);
		expect(result.size).toBe(2);
	});
});

describe("extractFunctionShingles / buildEntry -- via the public extraction API", () => {
	// extractFunctionShingles's own doc comment: "Returns [] for unsupported
	// extensions and test files." A ConditionalExpression mutant on the
	// isTestFile guard would stop skipping test files.
	// test-contract: public-api — doc comment: returns [] for test files
	it("returns no functions for a test file even when it contains a real function body", () => {
		const content = "function realFn() {\n\talpha\n\tbeta\n\tgamma\n\tdelta\n}";
		expect(extractFunctionShingles(content, "src/foo.test.ts")).toEqual([]);
	});

	// MIN_LOGICAL_LINES is the file's documented "Key false-positive guard":
	// a function just under it must be reported via emptyEntry (empty
	// shingle set), never the real computation. This fixture kills BOTH the
	// ConditionalExpression mutant on the guard condition AND the
	// BlockStatement mutant that guts its body -- either mutation lets
	// execution fall through to the real (non-empty) shingle computation.
	// test-contract: invariant — sub-MIN_LOGICAL_LINES functions get an empty shingle set
	it("returns an empty shingle set for a function just under MIN_LOGICAL_LINES", () => {
		const content = "class C {\n\tm() {\n;\n;\n}\n}";
		const fns = extractFunctionShingles(content, "src/probe.ts");
		expect(fns.length).toBe(1);
		expect(nonNull(fns[0]).logicalLines).toBe(4);
		expect(nonNull(fns[0]).shingles.size).toBe(0);
	});

	// The guard's comparison is strict `<`, so a function with EXACTLY 5
	// logical lines is eligible (only < 5 is too-small). An
	// EqualityOperator mutant (`<` -> `<=`) would wrongly early-return an
	// empty entry at this exact boundary.
	// test-contract: boundary — MIN_LOGICAL_LINES itself must be eligible, not excluded
	it("does not early-return at exactly MIN_LOGICAL_LINES", () => {
		const content = "class C {\n\tm() {\n;\n;\n;\n}\n}";
		const fns = extractFunctionShingles(content, "src/probe.ts");
		expect(fns.length).toBe(1);
		expect(nonNull(fns[0]).logicalLines).toBe(5);
		expect(nonNull(fns[0]).shingles.size).toBe(5);
	});

	// logicalLines counts NON-BLANK lines only (doc comment: "Count of
	// logical (non-blank) body lines"); a raw whitespace-only line must be
	// excluded exactly like a truly empty one. This single fixture (one body
	// line that is a lone space) kills FOUR independent mutants that each
	// break the blank-detection: removing the `.filter()` call, forcing its
	// callback to `true`, dropping `.trim()` before the comparison (raw " "
	// !== "" is true), and swapping the comparison's string literal away
	// from "".
	// test-contract: invariant — logicalLines excludes whitespace-only lines
	it("excludes a whitespace-only line from the logical-line count", () => {
		const content = "class C {\n\tm() {\n;\n \n;\n}\n}";
		const fns = extractFunctionShingles(content, "src/probe.ts");
		expect(fns.length).toBe(1);
		expect(nonNull(fns[0]).logicalLines).toBe(4);
		expect(nonNull(fns[0]).shingles.size).toBe(0);
	});

	// buildEntry slices the function's own lines via
	// `strippedLines.slice(fn.line - 1, fn.endLine)` (1-based fn.line
	// converted to a 0-based start). An ArithmeticOperator mutant
	// (`fn.line + 1`) starts the slice two lines late, dropping the
	// signature line and the first body line from both the line count and
	// the token stream -- for this fixture it shrinks logicalLines from 6 to
	// 4, which even re-trips the MIN_LOGICAL_LINES guard.
	// test-contract: invariant — body slice must start at fn.line, 0-based
	it("slices the function body starting at fn.line, not two lines later", () => {
		const content = "// pad1\n// pad2\nfunction tinyfn() {\n\talpha\n\tbeta\n\tgamma\n\tdelta\n}";
		const fns = extractFunctionShingles(content, "src/probe.ts");
		expect(fns.length).toBe(1);
		const fn = nonNull(fns[0]);
		expect(fn.line).toBe(3);
		expect(fn.logicalLines).toBe(6);
		expect(fn.shingles.size).toBe(7);
	});

	// bodyLines must be joined with "\n" before tokenizing, so a token
	// ending one line can never fuse with a token starting the next. A
	// StringLiteral mutant ("\n" -> "") concatenates "al"/"pha"/"gam"/"ma"
	// into one "alphagamma" identifier instead of four separate tokens,
	// shrinking the resulting shingle set from 6 to 3.
	// test-contract: invariant — body lines join with a newline, not ""
	it("does not fuse tokens across a line boundary when joining body lines", () => {
		const content = "class C {\n\tm() {\nal\npha\ngam\nma\n}\n}";
		const fns = extractFunctionShingles(content, "src/probe.ts");
		expect(fns.length).toBe(1);
		expect(nonNull(fns[0]).shingles.size).toBe(6);
	});
});

describe("findClones -- eligibility filters (empty-shingle exclusion)", () => {
	// findClones's own doc comment: "functions with an empty shingle set
	// (too small) are skipped before any pairing". threshold=0 removes
	// jaccard's own empty-guard as a fallback mask (`sim < threshold` is
	// `0 < 0`, false), so a missing upstream filter is directly observable
	// as a spurious same-similarity-zero finding. This fixture kills the
	// MethodExpression mutant that removes `input.edited.filter(...)`
	// entirely AND the two mutants on its callback
	// (`e.shingles.size > 0` -> `true` / `>= 0`) -- all three make the
	// filter keep everything.
	// test-contract: public-api — doc comment: empty-shingle edited fns are skipped
	it("excludes empty-shingle edited functions even at threshold 0", () => {
		const emptyA: FunctionShingles = { name: "emptyA", file: "src/a.ts", line: 1, logicalLines: 1, shingles: new Set() };
		const emptyB: FunctionShingles = { name: "emptyB", file: "src/b.ts", line: 1, logicalLines: 1, shingles: new Set() };
		const findings = findClones({ edited: [emptyA, emptyB], candidates: [], threshold: 0 });
		expect(findings).toEqual([]);
	});

	// Same guarantee as above, for the CANDIDATE-side filter. Kills the
	// MethodExpression mutant on `input.candidates.filter(...)` and its two
	// callback mutants (`c.shingles.size > 0` -> `true` / `>= 0`).
	// test-contract: public-api — doc comment: empty-shingle candidates are skipped
	it("excludes empty-shingle candidate functions even at threshold 0", () => {
		const real: FunctionShingles = { name: "real", file: "src/real.ts", line: 1, logicalLines: 5, shingles: new Set(["s1", "s2", "s3"]) };
		const emptyC: FunctionShingles = { name: "emptyC", file: "src/c.ts", line: 1, logicalLines: 1, shingles: new Set() };
		const findings = findClones({ edited: [real], candidates: [emptyC], threshold: 0 });
		expect(findings).toEqual([]);
	});
});

describe("findClones.consider -- self-pair, threshold boundary, and best-match selection", () => {
	// Module doc comment: "self-pairs are skipped by identity" when the same
	// function (by file+line) appears in both `edited` and `candidates`.
	// Kills the ConditionalExpression mutant on the isSameFunction
	// call-site AND both isSameFunction mutants (BlockStatement body
	// gutted, ConditionalExpression condition forced to false) -- all three
	// let a function match itself.
	// test-contract: public-api — doc comment: self-pairs skipped by file+line identity
	it("does not report a function as a clone of itself via file+line identity", () => {
		const fnX: FunctionShingles = { name: "dup", file: "src/dup.ts", line: 10, logicalLines: 5, shingles: new Set(["p", "q", "r"]) };
		const fnXAgain: FunctionShingles = { name: "dup", file: "src/dup.ts", line: 10, logicalLines: 5, shingles: new Set(["p", "q", "r"]) };
		const findings = findClones({ edited: [fnX], candidates: [fnXAgain], threshold: 0.1 });
		expect(findings).toEqual([]);
	});

	// Module doc comment: similarity is reported when it "meets or exceeds a
	// threshold", i.e. `sim < threshold` is the correct exclusion test. An
	// EqualityOperator mutant (`<=`) would wrongly exclude a pair whose
	// similarity equals the threshold exactly.
	// test-contract: boundary — sim===threshold must be included, not excluded
	it("includes a pair whose similarity equals the threshold exactly", () => {
		const p: FunctionShingles = { name: "p", file: "src/p.ts", line: 1, logicalLines: 5, shingles: new Set(["x1", "x2", "x3"]) };
		const q: FunctionShingles = { name: "q", file: "src/q.ts", line: 1, logicalLines: 5, shingles: new Set(["x1", "x2", "x4"]) };
		const findings = findClones({ edited: [p], candidates: [q], threshold: 0.5 });
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).similarity).toBe(0.5);
	});

	// `best` must track the HIGHEST similarity seen, not simply the LAST
	// candidate considered. Kills the ConditionalExpression mutant that
	// always updates (`!best || sim > best.sim` -> `true`) AND the
	// EqualityOperator mutant that inverts the comparison
	// (`sim > best.sim` -> `sim <= best.sim`) -- both let a later, WORSE
	// candidate overwrite the earlier, better one.
	// test-contract: invariant — best-match tracks max similarity, not last-seen
	it("keeps the earlier higher-similarity candidate over a later worse one", () => {
		const base: FunctionShingles = { name: "base", file: "src/base.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "d"]) };
		const better: FunctionShingles = { name: "better", file: "src/better.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "e"]) }; // sim 3/5 = 0.6
		const worse: FunctionShingles = { name: "worse", file: "src/worse.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "g", "h", "i"]) }; // sim 1/7
		const findings = findClones({ edited: [base], candidates: [better, worse], threshold: 0.1 });
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).similarity).toBe(0.6);
	});

	// `best` must UPDATE when a strictly better candidate is found LATER.
	// Kills the ConditionalExpression mutant that disables updates entirely
	// (`sim > best.sim` -> `false`) -- it would keep the earlier, worse
	// candidate even though a better one follows.
	// test-contract: invariant — best-match must update on a later strict improvement
	it("updates to a later strictly-better candidate", () => {
		const base: FunctionShingles = { name: "base", file: "src/base2.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "d"]) };
		const worse: FunctionShingles = { name: "worse", file: "src/worse2.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "g", "h", "i"]) }; // sim 1/7
		const better: FunctionShingles = { name: "better", file: "src/better2.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "e"]) }; // sim 3/5 = 0.6
		const findings = findClones({ edited: [base], candidates: [worse, better], threshold: 0.1 });
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).similarity).toBe(0.6);
	});

	// On an exact similarity TIE, the FIRST candidate considered must win
	// (`sim > best.sim` is strict). An EqualityOperator mutant (`>=`) would
	// let the second, later-considered tied candidate overwrite the first.
	// test-contract: boundary — a similarity tie keeps the first candidate, not the last
	it("keeps the first candidate on an exact similarity tie", () => {
		const base: FunctionShingles = { name: "base", file: "src/base3.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "d"]) };
		const tie1: FunctionShingles = { name: "tie1", file: "src/tie1.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "e"]) }; // sim 0.6
		const tie2: FunctionShingles = { name: "tie2", file: "src/tie2.ts", line: 1, logicalLines: 5, shingles: new Set(["a", "b", "c", "f"]) }; // sim 0.6
		const findings = findClones({ edited: [base], candidates: [tie1, tie2], threshold: 0.1 });
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).otherName).toBe("tie1");
	});
});

describe("findClones -- descending-similarity sort of the final findings list", () => {
	// Module doc comment: "Findings are sorted by descending similarity."
	// This fixture's INSERTION order (the low-similarity finding is pushed
	// before the high-similarity one) requires an actual reorder to satisfy
	// that contract. Kills the MethodExpression mutant that removes the
	// `.sort(...)` call entirely AND the ArrowFunction mutant that replaces
	// the comparator with `() => undefined` (a same-as-zero, stable no-op)
	// -- both leave insertion order untouched. The exact `similarity` values
	// (0.6, 1) also kill the ArithmeticOperator mutant on the rounding
	// (`* 100` instead of `/ 100`).
	// test-contract: public-api — doc comment: findings sorted by descending similarity
	it("reorders a low-then-high insertion into high-then-low", () => {
		const low: FunctionShingles = { name: "lowFn", file: "src/low.ts", line: 1, logicalLines: 5, shingles: new Set(["p1", "p2", "p3", "p4"]) };
		const lowMatch: FunctionShingles = { name: "lowMatch", file: "src/lowMatch.ts", line: 1, logicalLines: 5, shingles: new Set(["p1", "p2", "p3", "p5"]) }; // sim 0.6
		const high: FunctionShingles = { name: "highFn", file: "src/high.ts", line: 1, logicalLines: 5, shingles: new Set(["q1", "q2", "q3", "q4"]) };
		const highMatch: FunctionShingles = { name: "highMatch", file: "src/highMatch.ts", line: 1, logicalLines: 5, shingles: new Set(["q1", "q2", "q3", "q4"]) }; // sim 1
		const findings = findClones({ edited: [low, high], candidates: [lowMatch, highMatch], threshold: 0.5 });
		expect(findings.length).toBe(2);
		expect(nonNull(findings[0]).name).toBe("highFn");
		expect(nonNull(findings[0]).similarity).toBe(1);
		expect(nonNull(findings[1]).name).toBe("lowFn");
		expect(nonNull(findings[1]).similarity).toBe(0.6);
	});

	// When insertion order is ALREADY correctly descending, sorting must
	// leave it unchanged. Kills the ArithmeticOperator mutant on the
	// comparator (`y.similarity - x.similarity` -> `y.similarity +
	// x.similarity`): a sum of two positive similarities is positive
	// regardless of argument order, so it would wrongly swap a pair that
	// was already in the right order.
	// test-contract: invariant — comparator must be a difference, not a sum
	it("leaves an already-descending insertion order unchanged", () => {
		const high: FunctionShingles = { name: "highFn2", file: "src/high2.ts", line: 1, logicalLines: 5, shingles: new Set(["q1", "q2", "q3", "q4"]) };
		const highMatch: FunctionShingles = { name: "highMatch2", file: "src/highMatch2.ts", line: 1, logicalLines: 5, shingles: new Set(["q1", "q2", "q3", "q4"]) }; // sim 1
		const low: FunctionShingles = { name: "lowFn2", file: "src/low2.ts", line: 1, logicalLines: 5, shingles: new Set(["p1", "p2", "p3", "p4"]) };
		const lowMatch: FunctionShingles = { name: "lowMatch2", file: "src/lowMatch2.ts", line: 1, logicalLines: 5, shingles: new Set(["p1", "p2", "p3", "p5"]) }; // sim 0.6
		const findings = findClones({ edited: [high, low], candidates: [highMatch, lowMatch], threshold: 0.5 });
		expect(findings.length).toBe(2);
		expect(nonNull(findings[0]).name).toBe("highFn2");
		expect(nonNull(findings[0]).similarity).toBe(1);
	});
});
