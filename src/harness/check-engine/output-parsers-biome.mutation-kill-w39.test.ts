// Mutation-kill suite (wave 39) for output-parsers-biome.ts.
// Targets 3 regex survivors + the "syntax" isParse classification (2 survivors).
// The remaining 10 survivors mutate the post-match undefined guard
// (`file/lineNo/col/rule === undefined`), which is unreachable: none of the
// regex's four capture groups is optional (`?`), so a successful match always
// yields defined strings for all four — see guard_redundant_flags in the
// closing report rather than a test here.

import { describe, expect, it } from "vitest";
import { parseBiomeOutput } from "./output-parsers-biome.js";

describe("parseBiomeOutput — mutation kill w39", () => {
	// NOTE (closing verifier, 2026-08-22): deleted "does not match a
	// diagnostic-shaped pattern that is not at the start of the line" —
	// genuinely wrong assertion. The capture group is `(.+?)`, which matches
	// any characters (including "noise before "), so leading text before the
	// path is absorbed into the `file` capture rather than being excluded by
	// `^`. `^` only rejects a match starting after a literal newline inside
	// the string; since output is split on "\n" first, every candidate line
	// already begins at position 0, so this case can never distinguish a
	// mutated anchor from the real one.

	// test-contract: boundary — column numbers with 2+ digits must parse.
	it("parses a two-digit column number", () => {
		const out = parseBiomeOutput("file.ts:3:42 lint/foo bar\n");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "biome",
			severity: "warning",
			file: "file.ts",
			line: 3,
			column: 42,
			ruleId: "lint/foo",
		});
	});

	// test-contract: boundary — one-or-more whitespace between col and the rule
	// token; real biome output can emit more than one space there.
	it("parses a header with two spaces between the column and the rule token", () => {
		const out = parseBiomeOutput("src/a.ts:3:7  lint/foo ━━━\n");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			file: "src/a.ts",
			line: 3,
			column: 7,
			ruleId: "lint/foo",
		});
	});

	// test-contract: invariant — a "syntax" diagnostic (distinct from "parse")
	// must classify as isParse=true: severity "error" and the
	// "does not parse" message, exactly like the "parse" family.
	it("classifies a SYNTAX diagnostic as a parse error, not a plain warning", () => {
		const out = parseBiomeOutput("poison.ts:1:7 syntax ━━━━━━━━━━━\n");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: "biome",
			severity: "error",
			file: "poison.ts",
			line: 1,
			column: 7,
			ruleId: "syntax",
		});
		expect(out[0]?.message).toBe("syntax: file does not parse");
	});
});
