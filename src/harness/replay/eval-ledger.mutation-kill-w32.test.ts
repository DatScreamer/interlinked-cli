// Mutation-kill pass (wave 32) for eval-ledger.ts survivors.
// Targets manifest-listed survived mutants directly; each case is tagged
// with a test-contract comment naming the mutant(s) it distinguishes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allocRunId, ledgerPath, loadLedger, parseLedgerRow } from "./eval-ledger.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-ledger-w32-"));
	cleanups.push(dir);
	return dir;
}

function fullReference(): Record<string, unknown> {
	return { session_id: "sess", seq: 1, tool_use_id: "toolu_1", model: "vendor-model-v6" };
}

function fullActionMatch(): Record<string, unknown> {
	return { same_tool: true, same_input: true, match: true };
}

function fullStructural(): Record<string, unknown> {
	return { kind: "ast", comparable: true, distance: 0, normalized: 0 };
}

function fullScores(): Record<string, unknown> {
	return { action_match: fullActionMatch(), structural: fullStructural() };
}

function fullRow(): Record<string, unknown> {
	return {
		schema: "replay-eval.v1",
		run_id: "run-a",
		ts: "2026-07-24T15:00:00.000Z",
		mode: "off_policy",
		reference: fullReference(),
		candidate: { model: "candidate-x", decode: "default" },
		scores: fullScores(),
		reference_tool: "Bash",
	};
}

describe("allocRunId — mutation kills", () => {
	// test-contract: invariant — mutant c194d09f4c257737: regex1 must collapse RUNS of
	// non-alnum chars into one dash, not replace each char individually
	it("collapses a run of two consecutive non-alnum chars into a single dash", () => {
		const id = allocRunId("a  b", () => "2026-07-24T15:04:05.678Z");
		expect(id).toBe("run-20260724T150405-a-b");
	});

	// test-contract: invariant — mutant c54438a47e5e0a62: trim regex must REMOVE the
	// matched dash (replacement ""), not substitute mutant literal text
	it("trims an all-symbol slug down to empty, falling back to 'candidate'", () => {
		const id = allocRunId("!!!", () => "2026-07-24T15:04:05.678Z");
		expect(id).toBe("run-20260724T150405-candidate");
	});
});

describe("ledgerPath / safeRunId — mutation kills", () => {
	// test-contract: invariant — mutant 5d23b3ad05237cd3: unsafe run-id chars must be
	// replaced with a dash, not deleted
	it("replaces each unsafe run-id character with a dash", () => {
		const path = ledgerPath("/base", "run/a b");
		expect(path).toBe(join("/base", ".interlinked", "replay", "eval", "run-a-b", "ledger.jsonl"));
	});
});

describe("parseLedgerRow — reference field guards", () => {
	// test-contract: invariant — mutant f5699a7f45b4ffce: parseReference's isJsonObject
	// guard must reject (not crash on) a null reference
	it("N: rejects a null reference", () => {
		expect(parseLedgerRow({ ...fullRow(), reference: null })).toBeNull();
	});

	// test-contract: invariant — mutants 9116c71b281a1e8c, 5909db3cf15748ed: a
	// non-string session_id must fail parseReference AND the outer !reference guard
	it("N: rejects a non-string session_id", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), session_id: 123 } };
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutants 090fea47f7b3e2e7, 201a1e90dff5a1b9: seq must be
	// rejected when it is neither null nor a number
	it("N: rejects a seq that is neither null nor a number", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), seq: "bad" } };
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant b777c9bdea87f512: a null seq must be ACCEPTED
	// (the seq!==null short-circuit must not force the typeof check)
	it("P: accepts a null seq", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), seq: null } };
		expect(parseLedgerRow(row)).toEqual(row);
	});

	// test-contract: invariant — mutants 0d0d7c5706489587, 0cf62f8d810d3e31: tool_use_id
	// must be rejected when neither null nor a string
	it("N: rejects a tool_use_id that is neither null nor a string", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), tool_use_id: 42 } };
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant 384ff53867135de0: a null tool_use_id must be
	// ACCEPTED
	it("P: accepts a null tool_use_id", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), tool_use_id: null } };
		expect(parseLedgerRow(row)).toEqual(row);
	});

	// test-contract: invariant — mutants 5cf69196e0296bb5, 9ba0837243037337: model must
	// be rejected when neither null nor a string
	it("N: rejects a reference model that is neither null nor a string", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), model: 99 } };
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant 281e9fe3b1a734ed: a null reference model must
	// be ACCEPTED
	it("P: accepts a null reference model", () => {
		const row = { ...fullRow(), reference: { ...fullReference(), model: null } };
		expect(parseLedgerRow(row)).toEqual(row);
	});
});

describe("parseLedgerRow — candidate field guards", () => {
	// test-contract: invariant — mutant edacfd6f608bfd2c: parseCandidate's isJsonObject
	// guard must reject (not crash on) a null candidate
	it("N: rejects a null candidate", () => {
		expect(parseLedgerRow({ ...fullRow(), candidate: null })).toBeNull();
	});

	// test-contract: invariant — mutant 491c34ed3690eef5: a valid model with an
	// invalid decode must still be rejected
	it("N: rejects a candidate with a non-string decode", () => {
		const row = { ...fullRow(), candidate: { model: "candidate-x", decode: 123 } };
		expect(parseLedgerRow(row)).toBeNull();
	});
});

describe("parseLedgerRow — action_match score guards", () => {
	// test-contract: invariant — mutant 306bc6b491424014: parseActionMatchScore's
	// isJsonObject guard must reject (not crash on) a null action_match
	it("N: rejects a null action_match", () => {
		const row = { ...fullRow(), scores: { ...fullScores(), action_match: null } };
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant 00341461375c0bfc: same_tool valid but
	// same_input invalid must still be rejected
	it("N: rejects an action_match with a non-boolean same_input", () => {
		const row = {
			...fullRow(),
			scores: { ...fullScores(), action_match: { same_tool: true, same_input: "yes", match: true } },
		};
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant 3675c4858a46d8bd: same_tool/same_input valid
	// but match invalid must still be rejected
	it("N: rejects an action_match with a non-boolean match", () => {
		const row = {
			...fullRow(),
			scores: { ...fullScores(), action_match: { same_tool: true, same_input: true, match: "true" } },
		};
		expect(parseLedgerRow(row)).toBeNull();
	});
});

describe("parseLedgerRow — structural score guards", () => {
	// test-contract: invariant — mutant 1664d5c0aea70def: an array carrying
	// otherwise-valid structural fields must still be rejected (arrays are not
	// JSON objects per isJsonObject's Array.isArray exclusion)
	it("N: rejects an array masquerading as a structural score", () => {
		const arr: Record<string, unknown> = Object.assign([], fullStructural());
		const row = { ...fullRow(), scores: { ...fullScores(), structural: arr } };
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant e86c8e26f696cafc: a non-boolean comparable
	// must be rejected even when kind is valid
	it("N: rejects a structural score with a non-boolean comparable", () => {
		const row = {
			...fullRow(),
			scores: { ...fullScores(), structural: { ...fullStructural(), comparable: "yes" } },
		};
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutants 7b90a27e6ede4404, 37b24e241a0ecf73,
	// ec92d0a9dc2a9eb8 — a non-number distance must be rejected even when
	// normalized is valid
	it("N: rejects a structural score with a non-number distance", () => {
		const row = {
			...fullRow(),
			scores: { ...fullScores(), structural: { ...fullStructural(), distance: "bad" } },
		};
		expect(parseLedgerRow(row)).toBeNull();
	});

	// test-contract: invariant — mutant f01c4697955b5959: a non-number normalized must
	// be rejected even when distance is valid
	it("N: rejects a structural score with a non-number normalized", () => {
		const row = {
			...fullRow(),
			scores: { ...fullScores(), structural: { ...fullStructural(), normalized: "bad" } },
		};
		expect(parseLedgerRow(row)).toBeNull();
	});
});

describe("parseLedgerRow — scores/row-level guards", () => {
	// test-contract: invariant — mutant 6201c0c22ac1d87d: parseScores' isJsonObject
	// guard must reject (not crash on) a null scores object
	it("N: rejects a null scores object", () => {
		expect(parseLedgerRow({ ...fullRow(), scores: null })).toBeNull();
	});

	// test-contract: invariant — mutant a1e2cc4a012b10c8: parseLedgerRow's own
	// isJsonObject guard must reject (not crash on) a null row
	it("N: rejects a null row", () => {
		expect(parseLedgerRow(null)).toBeNull();
	});

	// test-contract: invariant — mutant e31849fa811859b1: a wrong mode tag must be
	// rejected
	it("N: rejects a row whose mode is not off_policy", () => {
		expect(parseLedgerRow({ ...fullRow(), mode: "on_policy" })).toBeNull();
	});

	// test-contract: invariant — mutants 30e95e67a43d5a8c, 03117662b8d44520,
	// ae427d8d2c4565b9 — a non-string run_id must be rejected even with a valid ts
	it("N: rejects a row with a non-string run_id", () => {
		expect(parseLedgerRow({ ...fullRow(), run_id: 42 })).toBeNull();
	});

	// test-contract: invariant — mutant 54bb40870be6dcda: a non-string ts must be
	// rejected even with a valid run_id
	it("N: rejects a row with a non-string ts", () => {
		expect(parseLedgerRow({ ...fullRow(), ts: 42 })).toBeNull();
	});

	// test-contract: invariant — mutant 5e114fdb64951006: a non-string reference_tool
	// must be rejected
	it("N: rejects a row with a non-string reference_tool", () => {
		expect(parseLedgerRow({ ...fullRow(), reference_tool: 42 })).toBeNull();
	});
});

describe("loadLedger — mutation kills", () => {
	// test-contract: invariant — mutant 44b56cc61af6c654: a line that parses as JSON
	// but fails parseLedgerRow must be DROPPED, not pushed as null
	it("N: drops a line that is valid JSON but not a valid ledger row", () => {
		const cwd = tempCwd();
		const path = ledgerPath(cwd, "run-a");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ foo: "bar" })}\n`);
		expect(loadLedger(cwd, "run-a")).toEqual([]);
	});
});
