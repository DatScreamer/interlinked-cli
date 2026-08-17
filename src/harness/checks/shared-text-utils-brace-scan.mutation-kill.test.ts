// Mutation-survivor kill tests for shared-text-utils-brace-scan.ts (fleet-r3,
// scratch/fleet-r3/CONTRACT-R3.md). stripForBraceScan is the ONLY export, so
// every case asserts its exact output string for a content fixture that
// isolates one internal branch. See strip-brace-balance.test.ts for the
// invariant-level (brace-balance) tests and shared-text-utils-brace-scan.test.ts
// for the pre-existing edge-case tests these are layered beside.
//
// Every expected string below was computed by running the real pristine
// module (never hand-derived) and cross-checked against a shadow build of
// each targeted mutant to confirm divergence — see
// scratch/fleet-r3/src_harness_checks_shared-text-utils-brace-scan.ts-shadow-verify.mts.
import { describe, expect, it } from "vitest";
import { stripForBraceScan } from "./shared-text-utils-brace-scan.js";

describe("stripForBraceScan — REGEX_PRECEDER_CHARS (module-level set membership)", () => {
	// Each of these single-char preceders must independently make the `/` that
	// follows a regex-start: the `{}` inside the regex body gets blanked (not
	// counted as a real code brace). Removing any one member from the set
	// changes ONLY that member's row from regex (blanked) to division
	// (unblanked, `{`/`}` visible) — P1..P20 each pin one member.
	const CHARS = [
		"", "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">",
	];
	it.each(CHARS)("P: prevChar %j before `/` is a regex preceder (braces inside are blanked)", (c) => {
		expect(stripForBraceScan(`${c}/{}/`)).toBe(`${c}    `);
	});
});

describe("stripForBraceScan — REGEX_PRECEDER_WORDS (module-level set membership)", () => {
	const WORDS = [
		"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "case",
	];
	it.each(WORDS)("P: word %j immediately before ` /` is a regex preceder (braces inside are blanked)", (w) => {
		expect(stripForBraceScan(`${w} /{}/`)).toBe(`${w}     `);
	});
});

describe("stripForBraceScan — base scan-stack frame must have expr:false (not truthy)", () => {
	it("P: a stray top-level `}` at brace-count 0 is real code, not an interpolation close, so it survives unblanked", () => {
		// If the base frame's `expr` field were truthy, this `}` would be
		// (wrongly) treated as closing a `${…}` interpolation: blanked and the
		// frame popped off the stack entirely.
		expect(stripForBraceScan("}")).toBe("}");
	});
});

describe("stripForBraceScan.blank — newline/CR must be preserved, not blanked", () => {
	it("P1: a literal newline inside a template body is preserved (line numbers stay stable)", () => {
		expect(stripForBraceScan("`a\nb`")).toBe("  \n  ");
	});
	it("P2: a literal carriage-return inside a template body is preserved", () => {
		expect(stripForBraceScan("`a\rb`")).toBe("  \r  ");
	});
});

describe("stripForBraceScan — stepStr internals", () => {
	it("P1: a backslash-escaped char inside a string is blanked at i+1 (the escape target), not i-1", () => {
		// If the escape blanks i-1 instead, the escaped char (here "Q") is never
		// visited at all (the i+=2 jump skips it) and survives in the output.
		expect(stripForBraceScan('"\\Q"')).toBe("    ");
	});
	it("P2: the string-close return value carries a real {i, prevChar} pair, not {} (which would stall the scan)", () => {
		// A mangled return makes i become undefined, so `i < n` fails forever
		// and everything after the closing quote is left unprocessed.
		expect(stripForBraceScan('"a"//c')).toBe("      ");
	});
	it("P3: prevChar after a closing quote is the synthetic value marker \"v\", not \"\" (so a following `/` reads as division)", () => {
		expect(stripForBraceScan('"a"/b/')).toBe("   /b/");
	});
	it("P4: the newline-bail return value advances i forward (i+1), not backward", () => {
		// A backward jump re-enters the char just before the newline as CODE,
		// which (here, a backtick) wrongly opens a nested template frame that
		// then swallows the newline and the trailing "def".
		expect(stripForBraceScan("\"a`\ndef")).toBe("   \ndef");
	});
});

describe("stripForBraceScan — stepBlock internals (block comments)", () => {
	it("P1: a real `*/` closes the comment; a bare `*` or `/` alone mid-body does not", () => {
		expect(stripForBraceScan("/* abc */ def")).toBe("          def");
	});
	it("P2: a bare `*` not immediately followed by `/` must not close the comment early", () => {
		expect(stripForBraceScan("/*a*b*/c")).toBe("       c");
	});
	it("P3: a non-star char immediately followed by `/` must not close the comment early", () => {
		expect(stripForBraceScan("/*a/b*/c")).toBe("       c");
	});
});

describe("stripForBraceScan — stepCodeBrace internals (brace tracking inside `${…}`)", () => {
	it("P1: a real nested `{` inside `${…}` increments the brace count so its matching `}` doesn't prematurely close the interpolation", () => {
		expect(stripForBraceScan("`${{}}`")).toBe("   {}  ");
	});
	it("P2: prevChar after a real top-level `}` is \"}\" (not the value marker), so a following `/` reads as division", () => {
		expect(stripForBraceScan("{}/x/")).toBe("{}/x/");
	});
});

describe("stripForBraceScan — stepCodeOpener internals", () => {
	it("P1: a single-quoted string opens a string frame just like a double-quoted one", () => {
		expect(stripForBraceScan("'a'")).toBe("   ");
	});
	it("P2: the regex-open branch requires c === \"/\" itself, not just isRegexStart(prevChar) alone", () => {
		// `(` is a regex preceder, but the char AT this position is `(`, not
		// `/` — nothing should open here.
		expect(stripForBraceScan("(x")).toBe("(x");
	});
	it("P3: the block-comment-open branch requires c === \"/\" itself, not just c2 === \"*\" alone", () => {
		expect(stripForBraceScan("x*y")).toBe("x*y");
	});
});

describe("stripForBraceScan — stepRegex internals", () => {
	it("P1: a `/` inside a `[...]` character class must not close the regex", () => {
		expect(stripForBraceScan("/[/]/ x")).toBe("      x");
	});
	it("P2: `]` exits the character class so a later `/` DOES close the regex", () => {
		expect(stripForBraceScan("/[a/]/ x")).toBe("       x");
	});
	it("P3: the regex-close return value carries a real {i, prevChar} pair, not {} (which would stall the scan)", () => {
		expect(stripForBraceScan('/x/"y"')).toBe("      ");
	});
	it("P4: prevChar after a closing `/` is the synthetic value marker \"v\", not \"\" (so a following `/` reads as division)", () => {
		expect(stripForBraceScan("/x//y/")).toBe("   /y/");
	});
	it("P5: the newline-bail return value advances i forward (i+1), not undefined (which would stall the scan)", () => {
		expect(stripForBraceScan('/x\n"y"')).toBe('  \n   ');
	});
	it("P6: the newline-bail return value advances i forward (i+1), not backward", () => {
		expect(stripForBraceScan("/a`\ndef")).toBe("   \ndef");
	});
});

describe("stripForBraceScan — stepTmpl internals (template interpolation)", () => {
	it("P1: `${` correctly opens an interpolation and its code is preserved (not blanked as template text)", () => {
		expect(stripForBraceScan("`${x}`")).toBe("   x  ");
	});
	it("P2: a lone `$` not immediately followed by `{` must not open an interpolation", () => {
		expect(stripForBraceScan("`a$b{c}`")).toBe("        ");
	});
	it("P3: the template-close return value carries a real {i, prevChar} pair, not {} (which would stall the scan)", () => {
		expect(stripForBraceScan('`x`"y"')).toBe("      ");
	});
	it("P4: prevChar after a closing backtick is the synthetic value marker \"v\", not \"\" (so a following `/` reads as division)", () => {
		expect(stripForBraceScan("`x`/y/")).toBe("   /y/");
	});
});

describe("stripForBraceScan — precedingWord internals", () => {
	it("P1: the identifier-collect loop must not stop one character early at the string start (off-by-one at index 0)", () => {
		// "instanceof" starts at index 0 here; an off-by-one that stops the
		// backward scan at j=0 instead of j=-1 clips the leading "i", turning
		// the recovered word into "nstanceof" — not a real preceder word.
		expect(stripForBraceScan("instanceof /x/")).toBe("instanceof    ");
	});
});
