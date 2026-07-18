import { describe, expect, it } from "vitest";
import { claimBindsToNamespace, defLineSet, idLineSet, localNounBindings } from "./binding.js";
import { extractSpecFacts } from "./extract-facts.js";

const facts = (text: string) => extractSpecFacts(text, "docs/plan.md");

describe("claimBindsToNamespace", () => {
	it("binds via same-line co-occurrence", () => {
		const f = facts("Six bets (B1, B2, B7) compose.");
		const ns = f.namespaces[0];
		expect(ns).toBeDefined();
		if (!ns) return;
		const claim = f.countClaims[0];
		expect(claim && claimBindsToNamespace(claim, f, idLineSet(ns), defLineSet(ns))).toBe(true);
	});

	it("binds via heading-section containment, not mere presence elsewhere", () => {
		const f = facts(
			["## The six bets", "- B1 a", "- B2 b", "- B7 c", "## Other", "text"].join(
				"\n",
			),
		);
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim && claimBindsToNamespace(claim, f, idLineSet(ns), defLineSet(ns))).toBe(
			true,
		);
	});

	it("does not bind an unrelated noun", () => {
		const f = facts(["Six reasons this works.", "- W1 a", "- W2 b", "- W3 c"].join("\n"));
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim ? claimBindsToNamespace(claim, f, idLineSet(ns), defLineSet(ns)) : null).toBe(
			false,
		);
	});
});

describe("localNounBindings", () => {
	it("maps bound noun singulars to style-qualified prefixes", () => {
		const f = facts(["## The six bets", "- B1 a", "- B2 b", "- B7 c"].join("\n"));
		const b = localNounBindings(f);
		expect(b.get("bet")).toEqual(new Set(["compact B"]));
	});

	it("returns no bindings without co-occurrence evidence", () => {
		const f = facts(["Six reasons.", "- W1 a", "- W2 b", "- W3 c"].join("\n"));
		expect(localNounBindings(f).size).toBe(0);
	});
});

describe("heading-derived binding hardening (sol-max batch 1)", () => {
	const bind = (text: string) =>
		[...localNounBindings(facts(text))].map(([k, v]) => `${k}=>${[...v].join(",")}`);

	it("does not bind a heading noun over prose-only (undefined) ids (#9)", () => {
		expect(bind("## Six bets\nB1, B2, and B3 were retired.")).toEqual([]);
	});

	it("binds only the deepest owning heading, not an ancestor (#10)", () => {
		expect(bind("# Protocol requirements\n## Bets\n- B1 a\n- B2 b\n- B3 c")).toEqual([
			"bet=>compact B",
		]);
	});

	it("includes the real registry noun from a multi-noun heading (#11)", () => {
		const b = bind("## Bets and owners\n- B1 a\n- B2 b\n- B3 c");
		expect(b).toContain("bet=>compact B");
	});

	it("count-claim path binds only the deepest owning heading, not an ancestor (round-4 #7)", () => {
		expect(bind("# Six protocol requirements\n## Bets\n- B1 a\n- B2 b\n- B3 c")).toEqual([
			"bet=>compact B",
		]);
	});

	it("does not bind a secondary heading noun that would fabricate drift (round-4 #8)", () => {
		expect(bind("## Bets and owners\n- B1 a\n- B2 b\n- B3 c")).toEqual(["bet=>compact B"]);
	});

	it("does not overflow the stack on a large registry (round-4 #9)", () => {
		const doc = ["## Bets", ...Array(130_000).fill("- B1"), "- B2", "- B3"].join("\n");
		expect(() => localNounBindings(facts(doc))).not.toThrow();
	});
});

describe("binding hardening (sol-max round 5)", () => {
	const bind = (text: string) =>
		[...localNounBindings(facts(text))].map(([k, v]) => `${k}=>${[...v].join(",")}`);

	it("does not cross-bind nouns/namespaces packed on one ambiguous line (#10)", () => {
		const b = localNounBindings(
			facts("Six bets B1 B2 B3 B4 B5 B6 and four gates G1 G2 G3 G4"),
		);
		expect(b.get("bet")?.has("compact G") ?? false).toBe(false);
		expect(b.get("gate")?.has("compact B") ?? false).toBe(false);
	});

	it("binds when the earliest definition is on the heading line (#11)", () => {
		expect(bind("## Bets B1\n- B2\n- B3\nThree bets.")).toEqual(["bet=>compact B"]);
	});

	it("binds the real plural, skipping a singular -s modifier in the heading (#12)", () => {
		expect(bind("## Access policies\n- P1\n- P2\n- P3")).toEqual(["policy=>compact P"]);
	});

	it("binds in sub-cubic time across many namespaces × claims × headings (#1)", () => {
		const parts: string[] = [];
		for (let i = 0; i < 800; i++) {
			const p =
				String.fromCharCode(65 + (i % 26)) +
				String.fromCharCode(65 + (Math.floor(i / 26) % 26)) +
				String.fromCharCode(65 + (Math.floor(i / 676) % 26));
			parts.push(`## Section ${p}`, `- ${p}-1 x`, `- ${p}-2 y`, "three widgets");
		}
		const start = Date.now();
		localNounBindings(facts(parts.join("\n")));
		expect(Date.now() - start).toBeLessThan(2000);
	});
});
