import { describe, expect, it } from "vitest";
import { isDefinitionSite } from "./definition-site.js";
import { stripEmphasis } from "./emphasis-strip.js";

/**
 * Ask the real question the extractor asks: does the id `token` on this raw
 * line earn definition credit? Columns are resolved in STRIPPED coordinates,
 * exactly as `collectHits` records them, so a fixture can be written the way it
 * appears in a document instead of hand-counting offsets.
 */
function credits(raw: string, token: string): boolean {
	const stripped = stripEmphasis(raw);
	const col = stripped.indexOf(token);
	// Guard the fixture itself: a typo'd token would otherwise read as col -1
	// and quietly answer "false" for every case.
	expect(col).toBeGreaterThanOrEqual(0);
	return isDefinitionSite(raw, stripped, col);
}

describe("isDefinitionSite — positive (must credit a definition)", () => {
	it("P1: credits the first cell of a table row", () => {
		expect(credits("| FG-INV-01 | commit stream is truth |", "FG-INV-01")).toBe(true);
		expect(credits("| **T1 blocking-fast** | < ~2s | PreToolUse |", "T1")).toBe(true);
	});

	it("P2: credits an id anywhere in a heading, not just at its head", () => {
		expect(credits("### Detector D1 - Assertion Side Effects", "D1")).toBe(true);
		expect(credits("### Hash-chained guard-decision audit (ASI11)", "ASI11")).toBe(true);
	});

	it("P3: credits the start of a bullet, ordered, and task item", () => {
		expect(credits("- **L0** — Does Cowork shell out to a hook runtime?", "L0")).toBe(true);
		expect(credits("2. FG-INV-02 holds after replay", "FG-INV-02")).toBe(true);
		expect(credits("- [ ] FG-INV-03: implement rule", "FG-INV-03")).toBe(true);
		// A ticked box puts a LETTER before the id, so only marker-aware head
		// resolution credits this one.
		expect(credits("- [x] FG-INV-04: shipped", "FG-INV-04")).toBe(true);
	});

	it("P4: credits a head decorated with non-word marks", () => {
		expect(credits("| ★R1 | refactorer:8 | must not run mutation |", "R1")).toBe(true);
		expect(credits("- → B7 determinism", "B7")).toBe(true);
	});

	it("P5: sees through a blockquote wrapper to the real shape", () => {
		expect(credits("> | REQ-1 | quoted registry row |", "REQ-1")).toBe(true);
		expect(credits("> FG-INV-01: rule", "FG-INV-01")).toBe(true);
	});

	it("P6: credits a bold-leading line, whose shape survives only unstripped", () => {
		expect(credits("**FG-INV-18** — replay is deterministic", "FG-INV-18")).toBe(true);
	});
});

describe("isDefinitionSite — negative (must not credit a reference)", () => {
	it("N1: refuses a later table cell", () => {
		expect(credits("| low (types, docs, generated) | T1 only, seconds |", "T1")).toBe(false);
		expect(credits("| 4a | T1 assembler: trace-assembler.ts |", "T1")).toBe(false);
	});

	it("N2: refuses a mid-sentence mention inside a list item", () => {
		expect(
			credits("2. **Run existing properties as a T2 verifier** with a budget", "T2"),
		).toBe(false);
		expect(credits("- Anything that cannot verdict in T1 goes to T2.", "T1")).toBe(false);
	});

	it("N3: refuses a later cell even under a blockquote wrapper", () => {
		expect(credits("> | REQ-1 | supersedes REQ-2 |", "REQ-2")).toBe(false);
		// Only cell-precise handling of the quoted row rejects this one: nothing
		// before REQ-2 is a word, so the head rule alone would credit it.
		expect(credits("> | ✓ | REQ-2 rechecked |", "REQ-2")).toBe(false);
	});

	it("N4: refuses any position on a line with no definition shape", () => {
		expect(credits("Body text referencing FG-INV-01 again.", "FG-INV-01")).toBe(false);
		expect(credits("FG-INV-01 opens this paragraph.", "FG-INV-01")).toBe(false);
	});

	it("N5: refuses a trailing id in the same first cell", () => {
		expect(credits("| REQ-1 REQ-2 | one cell, two ids |", "REQ-2")).toBe(false);
	});

	it("N6: refuses a digit-prefixed head — a row about something else", () => {
		expect(credits("| 4a T1 | assembler |", "T1")).toBe(false);
	});
});

describe("isDefinitionSite — degenerate rows", () => {
	it("credits the first cell of a row with no closing pipe", () => {
		expect(credits("| REQ-1 unterminated row", "REQ-1")).toBe(true);
	});

	it("refuses a row whose first cell is empty", () => {
		expect(credits("|  | REQ-1 |", "REQ-1")).toBe(false);
	});
});
