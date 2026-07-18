import { describe, expect, it } from "vitest";
import { extractSpecFacts } from "./extract-facts.js";
import {
	extractClaimSentences,
	extractDeclaredFacts,
	extractFencedBlocks,
	extractPathRefs,
	fencedLineSet,
} from "./extract-misc.js";

const lines = (text: string): string[] => text.split("\n");
const noFences = new Set<number>();

describe("extractFencedBlocks / fencedLineSet", () => {
	it("tracks fence spans with language and covers marker lines", () => {
		const blocks = extractFencedBlocks(
			lines("intro\n```ts\ncode\n```\nafter\n~~~\nplain\n~~~"),
		);
		expect(blocks).toEqual([
			{ startLine: 2, endLine: 4, lang: "ts" },
			{ startLine: 6, endLine: 8, lang: "" },
		]);
		const set = fencedLineSet(blocks);
		expect(set.has(3)).toBe(true);
		expect(set.has(5)).toBe(false);
	});

	it("treats an unterminated fence as running to EOF", () => {
		const blocks = extractFencedBlocks(lines("a\n```py\nx\ny"));
		expect(blocks).toEqual([{ startLine: 2, endLine: 4, lang: "py" }]);
	});

	it("never closes a backtick fence with tildes or vice versa (CommonMark)", () => {
		const blocks = extractFencedBlocks(
			lines("```md\n# example\n~~~\n[bad](#missing)\n```"),
		);
		expect(blocks).toEqual([{ startLine: 1, endLine: 5, lang: "md" }]);
	});

	it("requires the closing fence to be at least the opener's length", () => {
		const blocks = extractFencedBlocks(
			lines("````md\n# fake\n```\n[bad](#missing)\n````"),
		);
		expect(blocks).toEqual([{ startLine: 1, endLine: 5, lang: "md" }]);
	});

	it("does not treat a fence-with-info-string line as a closer", () => {
		const blocks = extractFencedBlocks(lines("```md\n```ts\nstill inside\n```"));
		expect(blocks).toEqual([{ startLine: 1, endLine: 4, lang: "md" }]);
	});

	it("accepts multi-token info strings on the opener (round-2 #22)", () => {
		const blocks = extractFencedBlocks(
			lines('```ts title="demo"\ncode\n```\n# Real heading'),
		);
		expect(blocks).toEqual([{ startLine: 1, endLine: 3, lang: "ts" }]);
	});
});

describe("extractPathRefs", () => {
	it("extracts repo-relative paths with tense classification", () => {
		const refs = extractPathRefs(
			lines(
				"The registry lives at `src/harness/spec/types.ts` today.\nWe will add `scripts/check.sh` later.\nAlso `invariants.toml` is referenced.",
			),
			noFences,
		);
		expect(refs).toEqual([
			expect.objectContaining({
				path: "src/harness/spec/types.ts",
				tense: "present",
			}),
			expect.objectContaining({ path: "scripts/check.sh", tense: "future" }),
			expect.objectContaining({ path: "invariants.toml", tense: "unknown" }),
		]);
	});

	it("skips URLs, globs, absolute paths, commands, and fenced lines", () => {
		const refs = extractPathRefs(
			lines(
				"`https://x.y/z` `src/**/*.ts` `/etc/passwd` `npm run build` and fenced:",
			),
			noFences,
		);
		expect(refs).toEqual([]);
		expect(extractPathRefs(lines("`real/path.ts`"), new Set([1]))).toEqual([]);
	});
});

describe("extractDeclaredFacts", () => {
	it("extracts fact markers with name/value/line", () => {
		const facts = extractDeclaredFacts(
			lines("cap is <!-- fact:line_cap -->500<!-- /fact:line_cap --> lines"),
		);
		expect(facts).toEqual([{ name: "line_cap", value: "500", line: 1 }]);
	});

	it("requires matching close names and ignores malformed markers", () => {
		expect(
			extractDeclaredFacts(
				lines("<!-- fact:a -->1<!-- /fact:b --> and <!-- fact:c -->2"),
			),
		).toEqual([]);
	});

	it("stays linear on many unclosed openers (round-2 #2 ReDoS)", () => {
		const evil = "<!-- fact:x -->".repeat(8_000);
		const start = Date.now();
		extractDeclaredFacts([evil]);
		expect(Date.now() - start).toBeLessThan(500);
	});
});

describe("extractClaimSentences", () => {
	it("flags guarantee verbs and detects claim tags", () => {
		const claims = extractClaimSentences(
			lines(
				"This guarantees serializability.\nReplay is byte-identical [claim: theorem].\nNothing notable here.",
			),
			noFences,
		);
		expect(claims).toEqual([
			expect.objectContaining({ verb: "guarantees", tagged: false, line: 1 }),
			expect.objectContaining({ verb: "byte-identical", tagged: true, line: 2 }),
		]);
	});
});

describe("extractSpecFacts (orchestrator)", () => {
	it("assembles all families and excludes fenced prose facts", () => {
		const facts = extractSpecFacts(
			[
				"# 1. Title",
				"See §2 and [link](#missing).",
				"Six bets: B1 B2 B7. Range FG-INV-01 through FG-INV-20.",
				"```md",
				"# fake heading with §9 and `fake/path.ts`",
				"```",
				"Real `src/index.ts` lives here.",
			].join("\n"),
			"docs/plan.md",
		);
		expect(facts.filePath).toBe("docs/plan.md");
		expect(facts.lineCount).toBe(7);
		expect(facts.headings.map((h) => h.text)).toEqual(["1. Title"]);
		expect(facts.sectionRefs.map((r) => r.ref)).toEqual(["2"]);
		expect(facts.anchorLinks[0]?.anchor).toBe("missing");
		// FG-INV appears ONLY as a range-claim endpoint (no backing registry), so
		// it must NOT seed a census — a claim can't validate its own extent
		// (sol-max #12). B1/B2/B7 are real compact ids and survive.
		expect(facts.namespaces.map((n) => n.prefix).sort()).toEqual(["B"]);
		expect(facts.countClaims[0]?.noun).toBe("bets");
		// The range claim itself is still extracted — only its census seeding is gone.
		expect(facts.rangeClaims[0]?.to).toBe(20);
		expect(facts.pathRefs.map((p) => p.path)).toEqual(["src/index.ts"]);
		expect(facts.fencedBlocks).toHaveLength(1);
	});
});
