import { describe, expect, it } from "vitest";
import { findOverlappingPattern, patternsOverlap } from "./glob-overlap.js";

describe("patternsOverlap — mutation-kill w39", () => {
	// test-contract: invariant — kills BooleanLiteral flip of the final "return false"
	it("mismatched literal segment returns false, not true", () => {
		expect(patternsOverlap("src/auth/login.ts", "src/auth/logout.ts")).toBe(false);
	});

	// test-contract: invariant — kills BooleanLiteral flip of the default ignoreCase=false
	it("default ignoreCase is case-sensitive (false), not case-insensitive", () => {
		expect(patternsOverlap("SRC/A.ts", "src/a.ts")).toBe(false);
	});

	// test-contract: invariant — kills forcing the "**" OR-condition/block/string-literal to no-op
	// (part1==="**") side: without the early return, the loop falls through to the
	// includes("*") regex branch which "continue"s instead of short-circuiting the
	// whole function, so a later mismatched segment then returns false.
	it("** short-circuits the whole match even when a later segment would mismatch", () => {
		expect(patternsOverlap("src/**/x", "src/other/y")).toBe(true);
	});

	// test-contract: invariant — kills forcing the "part2==='**'" side to no-op
	it("** on the second pattern short-circuits even when a later segment mismatches", () => {
		expect(patternsOverlap("src/other/x", "src/**/y")).toBe(true);
	});

	// test-contract: invariant — kills forcing part1.includes("*")||part2.includes("*") to
	// always-true (ConditionalExpression + both StringLiteral "*"->"" variants): a purely
	// literal mismatch containing a regex-metachar-like "." must still return false, not
	// be swallowed by an incorrectly-entered wildcard-regex branch.
	it("literal (non-wildcard) segments with a dot are compared literally, not as regex", () => {
		expect(patternsOverlap("src/a.ts", "src/axts")).toBe(false);
	});

	// test-contract: public-api — kills BooleanLiteral flip in findOverlappingPattern's
	// default ignoreCase=false
	it("findOverlappingPattern default ignoreCase is case-sensitive", () => {
		expect(findOverlappingPattern("SRC/Auth/login.ts", ["src/auth/login.ts"])).toBeNull();
	});
});
