// T1 action-match scorer — the cheapest per-step comparison signal
// (docs/design/reproducibility/tier1-teacher-forced-eval.md): same tool +
// same normalized input. Normalization is key-order-insensitive (two agents
// emitting identical args in different property order MUST match) but
// value-sensitive.

import { describe, expect, it } from "vitest";
import { actionMatch, canonicalizeInput } from "./action-match.js";

describe("canonicalizeInput", () => {
	it("is key-order insensitive at every depth", () => {
		const a = canonicalizeInput({ b: 1, a: { z: 2, y: [3, { q: 4, p: 5 }] } });
		const b = canonicalizeInput({ a: { y: [3, { p: 5, q: 4 }], z: 2 }, b: 1 });
		expect(a).toBe(b);
	});

	it("distinguishes different values and preserves array order", () => {
		expect(canonicalizeInput({ a: [1, 2] })).not.toBe(canonicalizeInput({ a: [2, 1] }));
		expect(canonicalizeInput({ a: 1 })).not.toBe(canonicalizeInput({ a: "1" }));
	});

	it("handles null and non-object inputs", () => {
		expect(canonicalizeInput(null)).toBe("null");
		expect(canonicalizeInput(undefined)).toBe("null");
	});
});

describe("actionMatch", () => {
	it("matches identical tool + input regardless of key order", () => {
		const score = actionMatch(
			{ tool: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } },
			{ tool: "Edit", input: { new_string: "b", old_string: "a", file_path: "/x.ts" } },
		);
		expect(score).toEqual({ same_tool: true, same_input: true, match: true });
	});

	it("fails on tool mismatch even with equal input", () => {
		const score = actionMatch(
			{ tool: "Read", input: { file_path: "/x.ts" } },
			{ tool: "Grep", input: { file_path: "/x.ts" } },
		);
		expect(score.same_tool).toBe(false);
		expect(score.match).toBe(false);
	});

	it("fails on input mismatch with same tool", () => {
		const score = actionMatch(
			{ tool: "Bash", input: { command: "ls" } },
			{ tool: "Bash", input: { command: "ls -la" } },
		);
		expect(score).toEqual({ same_tool: true, same_input: false, match: false });
	});

	it("treats null inputs as equal only to null/absent inputs", () => {
		expect(actionMatch({ tool: "X", input: null }, { tool: "X", input: null }).match).toBe(true);
		expect(actionMatch({ tool: "X", input: null }, { tool: "X", input: {} }).match).toBe(false);
	});
});
