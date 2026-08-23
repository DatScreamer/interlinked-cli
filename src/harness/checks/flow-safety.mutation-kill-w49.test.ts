// Mutation-kill tests for src/harness/checks/flow-safety.ts (wave pass1_w49).
//
// Targets the four spread-detection regex mutants in
// checkBoundaryCopyNoRevalidation's `spreadRe`:
//   /\{[^{}]*\.\.\.\s*((?:req|request)\.(?:body|query|params)\b[\w$.]*|process\.(?:argv|env)[\w$.]*)/g
//
// Each mutant swaps a trailing `[\w$.]*` class (word/`$`/dot chars) for a
// broader class that also matches structural characters like `}`, `,`,
// ` `, and `{`. When the object-literal separator between two ADJACENT
// spread literals contains no word character (e.g. `}, {`), the mutated
// class greedily consumes across the separator and into the second `{`,
// so the regex's global `lastIndex` lands *past* the second literal's
// opening brace. The next `exec()` call then finds no more matches, and
// `checkBoundaryCopyNoRevalidation` reports only 1 finding instead of 2.
//
// This is a precise differential: unmutated code reports 2; every one of
// the four mutants collapses it to 1.

import { describe, expect, it } from "vitest";
import { checkBoundaryCopyNoRevalidation } from "./flow-safety.js";

describe("checkBoundaryCopyNoRevalidation — spread regex adjacency (mutation kill)", () => {
	// test-contract: bug — Stryker survivors ce4d6c96/a1b84a04 mutate the
	// req-branch trailing character class of spreadRe so it also consumes
	// the `}, {` separator between adjacent spread literals, swallowing
	// the second literal's opening brace and dropping its finding.
	it("P1: reports both adjacent req.* spreads separated only by non-word chars", () => {
		// Between `req.body}` and the next `{` there are only `,`, ` `, and `{`
		// itself — none are `\w`, so the correct [\w$.]* class stops
		// immediately after "body" (the very next char '}' isn't in
		// [\w$.]). A mutant class that also matches '}', ',', ' ', '{'
		// consumes forward across the separator and swallows the second
		// opening brace, deleting the second finding.
		const content = "const pairs = [{...req.body},\n{...req.query}];\n";
		const matches = checkBoundaryCopyNoRevalidation(content, "app.ts");
		expect(matches.length).toBe(2);
	});

	// test-contract: bug — Stryker survivors ff29c1c2/7aee5b40 mutate the
	// process-branch trailing character class of spreadRe the same way,
	// for the `process.argv`/`process.env` alternative.
	it("P2: reports both adjacent process.* spreads separated only by non-word chars", () => {
		const content = "const pairs = [{...process.argv},\n{...process.env}];\n";
		const matches = checkBoundaryCopyNoRevalidation(content, "app.ts");
		expect(matches.length).toBe(2);
	});

	// test-contract: boundary — a single spread must not be double-counted
	// or dropped; anchors the P1/P2 counts against a trivial baseline.
	it("N1: still reports only one finding for a single spread (baseline sanity)", () => {
		const content = "const a = { ...req.body };\n";
		const matches = checkBoundaryCopyNoRevalidation(content, "app.ts");
		expect(matches.length).toBe(1);
	});

	// test-contract: public-api — checkBoundaryCopyNoRevalidation only
	// flags spreads of req/request/process external-input sources; a
	// spread of an unrelated local identifier must NOT be reported.
	it("N2: does not report a spread of a non-external identifier", () => {
		const content = "const a = { ...safeLocalObject };\n";
		const matches = checkBoundaryCopyNoRevalidation(content, "app.ts");
		expect(matches.length).toBe(0);
		expect(matches).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("safeLocalObject") })]),
		);
	});
});
