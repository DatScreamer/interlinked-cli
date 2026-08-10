// Behavioral retrieval cost (trajectory program, step 3a).
//
// Retrieval quality is usually argued about in the abstract. It has an
// observable signature: an agent that cannot find things searches repeatedly
// for one symbol and reads a pile of files before it can make one edit. Those
// are recorded facts, not opinions.
//
// The attribution choice is the point. Read-fanout is charged to the FILE that
// was finally edited, not to the agent — that turns "this agent flailed" into
// "this file is expensive to reach", which is a property of the CODEBASE and
// therefore ratchetable. It is also self-calibrating across repos: no threshold
// needs tuning, because the agents supply the distribution.
//
// Composes with outcomes.ts on purpose — the open question is whether high
// retrieval cost actually predicts trouble. If it does not, no ratchet gets
// built on it.

import { describe, expect, it } from "vitest";
import type { OutcomeEvent } from "./outcomes.js";
import { retrievalCostByFile } from "./retrieval-cost.js";

function read(file: string): OutcomeEvent {
	return { tool: "Read", decision: "allow", outcome: "success", file };
}
function search(term: string): OutcomeEvent {
	return { tool: "Grep", decision: "allow", outcome: "success", searchTerm: term };
}
function edit(file: string): OutcomeEvent {
	return { tool: "Edit", decision: "allow", outcome: "success", file, sha: `${file}-1` };
}

describe("retrievalCostByFile — positive (must charge cost)", () => {
	it("P1: OTHER files read before an edit are charged to the edited file", () => {
		// a.ts and b.ts are excess exploration; reading c.ts itself is the
		// necessary minimum and is excluded (see N3) — the metric measures how
		// much MORE than the target an agent had to read to get here.
		const cost = retrievalCostByFile([read("a.ts"), read("b.ts"), read("c.ts"), edit("c.ts")]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(2);
	});

	it("P2: searches before an edit are charged too", () => {
		const cost = retrievalCostByFile([search("thing"), search("other"), edit("c.ts")]);
		expect(cost.get("c.ts")?.searchesBeforeEdit).toBe(2);
	});

	it("P3: a repeated search for the SAME term is counted as a retrieval failure", () => {
		const cost = retrievalCostByFile([search("thing"), search("thing"), search("thing"), edit("c.ts")]);
		expect(cost.get("c.ts")?.repeatSearches).toBe(2);
	});

	it("P4: only the FIRST edit of a file accrues cost — later edits are already oriented", () => {
		const cost = retrievalCostByFile([read("a.ts"), edit("c.ts"), read("b.ts"), edit("c.ts")]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(1);
	});

	it("P5: cost accrues per file, so two edited files each carry their own", () => {
		const cost = retrievalCostByFile([read("a.ts"), edit("x.ts"), read("b.ts"), read("d.ts"), edit("y.ts")]);
		expect(cost.get("x.ts")?.readsBeforeEdit).toBe(1);
		expect(cost.get("y.ts")?.readsBeforeEdit).toBe(2);
	});
});

describe("retrievalCostByFile — negative (must not manufacture cost)", () => {
	it("N1: an edit with no preceding exploration is free", () => {
		const cost = retrievalCostByFile([edit("c.ts")]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(0);
		expect(cost.get("c.ts")?.searchesBeforeEdit).toBe(0);
	});

	it("N2: reading the SAME file twice is one file's worth of cost, not two", () => {
		const cost = retrievalCostByFile([read("a.ts"), read("a.ts"), edit("c.ts")]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(1);
	});

	it("N3: reading the file you then edit is orientation, not retrieval cost", () => {
		const cost = retrievalCostByFile([read("c.ts"), edit("c.ts")]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(0);
	});

	it("N4: distinct search terms are exploration, not repeat-search failure", () => {
		const cost = retrievalCostByFile([search("a"), search("b"), search("c"), edit("c.ts")]);
		expect(cost.get("c.ts")?.repeatSearches).toBe(0);
	});

	it("N5: a session with no edits charges nobody", () => {
		expect(retrievalCostByFile([read("a.ts"), search("x")]).size).toBe(0);
	});

	it("N6: exploration AFTER the last edit is not charged backwards", () => {
		const cost = retrievalCostByFile([edit("c.ts"), read("a.ts"), read("b.ts")]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(0);
	});
});
