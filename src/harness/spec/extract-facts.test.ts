import { describe, expect, it } from "vitest";
import { extractSpecFacts } from "./extract-facts.js";

/**
 * Count claims come from PROSE. A number inside a table cell describes that one
 * row; it is not an assertion about how many rows the registry has. This was
 * dogfooded: a status table whose Evidence column read "41 survivors" and
 * "6 cases" produced four bogus "stale claim" findings about an 11-id namespace.
 */
describe("extractSpecFacts — count claims are prose, not table data", () => {
	const TABLE = [
		"# Board",
		"",
		"| # | Unit | Evidence |",
		"|---|---|---|",
		"| A1 | harvest wired | 41 survivors delivered |",
		"| A2 | overlays | 6 cases added |",
		"| A3 | scoping | 2 cases |",
		"",
	].join("\n");

	it("does not read a count claim out of a table cell", () => {
		const facts = extractSpecFacts(TABLE, "board.md");
		expect(facts.countClaims).toEqual([]);
	});

	it("still finds the ids that the table DEFINES", () => {
		// Masking applies to claims only — the id census must keep scanning tables,
		// or a registry written as a table would stop being a registry.
		const facts = extractSpecFacts(TABLE, "board.md");
		const ids = facts.namespaces.flatMap((n) => n.ids.map((i) => i.id));
		expect(ids).toContain("A1");
		expect(ids).toContain("A3");
	});

	it("still reads a real count claim from prose next to the table", () => {
		const withProse = `${TABLE}\nThere are 3 units in this phase.\n`;
		const facts = extractSpecFacts(withProse, "board.md");
		expect(facts.countClaims.map((c) => c.value)).toContain(3);
	});

	it("leaves prose containing a lone pipe alone", () => {
		// Requires TWO pipes, so an inline `a | b` alternation is not a table row.
		const facts = extractSpecFacts("Use 3 modes: fast | slow.\n", "d.md");
		expect(facts.countClaims.map((c) => c.value)).toContain(3);
	});

	it("masks an indented table row too", () => {
		const facts = extractSpecFacts("# T\n\n  | A1 | 9 cases |\n", "d.md");
		expect(facts.countClaims).toEqual([]);
	});
});
