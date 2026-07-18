import { describe, expect, it } from "vitest";
import {
	extractCodeInvariants,
	extractMarkdownInvariants,
	renderInvariantTaxonomy,
} from "./code-invariants.js";

describe("extractCodeInvariants", () => {
	it("extracts INVARIANT/SAFETY comments and assertions", () => {
		const code = [
			"// INVARIANT: the ledger version only increases",
			"/* SAFETY: caller holds the write lock */",
			"debug_assert!(epoch > last_epoch);",
			"assert_eq!(a, b);",
			"const x = 1; // ordinary comment",
		].join("\n");
		const out = extractCodeInvariants(code);
		expect(out.map((i) => i.kind)).toEqual([
			"invariant_comment",
			"safety_comment",
			"assertion",
			"assertion",
		]);
		expect(out[0]?.text).toContain("only increases");
		expect(out[1]?.line).toBe(2);
	});

	it("returns empty for invariant-free code", () => {
		expect(extractCodeInvariants("const a = 1;\nfunction f() {}")).toEqual([]);
	});
});

describe("extractMarkdownInvariants", () => {
	it("extracts registry rows with ids and doctrine sentences", () => {
		const md = [
			"| **FG-INV-18** | derived indexes are never authoritative |",
			"- FG-INV-19: replay is byte-identical",
			"The commit stream MUST remain the sole source of truth for recovery.",
			"Writers must never bypass the coordinator during rebase.",
			"ordinary prose about the design goes here",
		].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out.map((i) => i.kind)).toEqual([
			"registry_row",
			"registry_row",
			"doctrine",
			"doctrine",
		]);
		expect(out[0]?.id).toBe("FG-INV-18");
		expect(out[0]?.text).toContain("never authoritative");
	});

	it("skips fenced examples and blockquotes (round-2 #32)", () => {
		const md = [
			"| FG-INV-01 | real registry row |",
			"```md",
			"| FG-INV-99 | example row in a fence |",
			"The commit stream MUST stay sole truth (example).",
			"```",
			"> Quoted: the design MUST never lose data.",
		].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out.map((i) => i.id ?? i.kind)).toEqual(["FG-INV-01"]);
	});

	it("rejects malformed ids, lowercase must prose, and short lines", () => {
		const md = [
			"| A--B-1 | malformed double dash |",
			"you must fill the form", // lowercase prose "must", short
			"| X9-2 | segment starting with letter is fine |",
		].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out.map((i) => i.id ?? i.kind)).toEqual(["X9-2"]);
	});
});

describe("renderInvariantTaxonomy", () => {
	it("renders one labeled entry per invariant with provenance", () => {
		const rendered = renderInvariantTaxonomy("plan.md", [
			{ line: 4, kind: "registry_row", id: "FG-INV-18", text: "indexes rebuildable" },
			{ line: 9, kind: "doctrine", text: "MUST stay sole truth" },
		]);
		expect(rendered).toContain("# Invariant taxonomy — plan.md");
		expect(rendered).toContain("**FG-INV-18** (registry_row, plan.md:4): indexes rebuildable");
		expect(rendered).toContain("**INV-x2** (doctrine, plan.md:9)");
	});
});
