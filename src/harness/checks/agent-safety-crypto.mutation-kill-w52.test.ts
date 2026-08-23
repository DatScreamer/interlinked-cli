import { describe, expect, it } from "vitest";
import { checkRecursiveWalkerLstat } from "./agent-safety-crypto.js";

// Wave pass1_w52 — targeted kills for src/harness/checks/agent-safety-crypto.ts
// survivors, all inside checkRecursiveWalkerLstat's helper machinery
// (declRe3 in collectWalkerDecls, selfRe / absStat in walkerLstatMatch).

function walkerSrc(declLine: string): string {
	return [
		"class Walker {",
		declLine,
		"    const items = readdirSync(dir);",
		"    if (statSync(item)) {",
		"      this.walk(item);",
		"    }",
		"  }",
		"}",
		"",
	].join("\n");
}

describe("checkRecursiveWalkerLstat — declRe3 whitespace/return-type boundaries (positive — must fire)", () => {
	// test-contract: public-api — checkRecursiveWalkerLstat must flag a
	// recursive-walker method regardless of incidental spacing around its
	// TS return-type annotation; this pins declRe3's whitespace tolerance.
	it("P1: detects a class-method decl with a space BEFORE the return-type colon", () => {
		// Kills mutants 8cb94a6d (W1 \\s*->\\S*), 202bf5c7 ([^{]+ -> [^{]),
		// 573e1662 ([^{]+ -> [{]+): each makes declRe3 fail to match this
		// exact spacing, so the walker's declaration is never collected and
		// no finding is produced.
		const src = walkerSrc("  walk(dir) : void {");
		const matches = checkRecursiveWalkerLstat(src, "walker.ts");
		expect(matches).toEqual([{ line: 4, text: "if (statSync(item)) {" }]);
	});

	// test-contract: public-api — same spacing-tolerance contract as P1,
	// exercised on the other side of the ':' return-type separator.
	it("P2: detects a class-method decl with NO space after the return-type colon", () => {
		// Kills mutant ffb15bc1 (W2 \\s*->\\s, now requires a mandatory
		// whitespace right after ':' that this input does not have).
		const src = walkerSrc("  walk(dir):void {");
		const matches = checkRecursiveWalkerLstat(src, "walker.ts");
		expect(matches).toEqual([{ line: 4, text: "if (statSync(item)) {" }]);
	});

	// test-contract: public-api — same spacing-tolerance contract as P1/P2,
	// exercised at the fully-collapsed (zero-whitespace) end of the range.
	it("P3: detects a class-method decl with ZERO whitespace between ')' and '{'", () => {
		// Kills mutants 123cd0f1 (W1 \\s*->\\s) and b3b59eeb (W3 \\s*->\\s):
		// both require a mandatory single whitespace character in a spot
		// where this input has none at all.
		const src = walkerSrc("  walk(dir){");
		const matches = checkRecursiveWalkerLstat(src, "walker.ts");
		expect(matches).toEqual([{ line: 4, text: "if (statSync(item)) {" }]);
	});
});

describe("checkRecursiveWalkerLstat — selfRe must require a genuine call to the declared name (negative — must not fire)", () => {
	// test-contract: bug — the detector's whole purpose is to flag genuine
	// self-recursion; an identifier that merely ends in the method name
	// ("dowalk") must not be mistaken for a call to "walk".
	it("N1: does NOT fire when the recursive-looking identifier is only a substring (no leading word boundary)", () => {
		// Kills mutant 48330a17: dropping "(?:\\bthis\\.)?\\b" from the
		// selfRe construction removes the leading word-boundary guard, so
		// "dowalk(" would spuriously satisfy the self-call check even
		// though "walk" is not a standalone identifier there.
		const src = [
			"class Walker {",
			"  walk(dir) {",
			"    const items = readdirSync(dir);",
			"    dowalk(item);",
			"    statSync(item);",
			"  }",
			"}",
			"",
		].join("\n");
		expect(checkRecursiveWalkerLstat(src, "walker.ts")).toEqual([]);
	});

	// test-contract: bug — a bare reference to the method's own name that
	// is never called ("logger.log(walk)") is not a recursive call and
	// must not be flagged.
	it("N2: does NOT fire when the declared name appears but is never actually called", () => {
		// Kills mutant dd275fe4: dropping "\\b\\s*\\(" from the selfRe
		// construction removes the trailing "must be followed by a call"
		// requirement, so a bare reference to the name (no parens) would
		// spuriously satisfy the self-call check.
		const src = [
			"class Walker {",
			"  walk(dir) {",
			"    const items = readdirSync(dir);",
			"    logger.log(walk);",
			"    statSync(item);",
			"  }",
			"}",
			"",
		].join("\n");
		expect(checkRecursiveWalkerLstat(src, "walker.ts")).toEqual([]);
	});
});

describe("checkRecursiveWalkerLstat — reported line number must track the real statSync position (positive — must fire)", () => {
	// test-contract: public-api — the reported line/text must point at the
	// real unguarded statSync call so an agent can find and fix it, not
	// some other line near it.
	it("P4: reports the line the un-guarded statSync call is actually on, not an adjacent line", () => {
		// Kills mutant 7af6e125 (`bodyOpen + 1 + sm.index` -> `bodyOpen - 1
		// + sm.index` in the absStat computation). Placing the statSync
		// call at column 0 of its own line (immediately after a newline)
		// means shifting the computed absolute offset back by 2 crosses
		// into the PRECEDING line, so the mutant reports the wrong line
		// number and wrong matched text.
		const src = [
			"class Walker {",
			"  walk(dir) {",
			"const items=readdirSync(dir);",
			"statSync(item);",
			"this.walk(item);",
			"  }",
			"}",
			"",
		].join("\n");
		const matches = checkRecursiveWalkerLstat(src, "walker.ts");
		expect(matches).toEqual([{ line: 4, text: "statSync(item);" }]);
	});
});
