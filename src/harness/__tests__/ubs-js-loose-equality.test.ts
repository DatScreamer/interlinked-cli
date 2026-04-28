// Tests for `ubs_js_loose_equality` (row 27 of Phase-1 Plan 04 phase matrix).
// Detects `==` / `!=` in JS/TS files, but allows the documented `x == null`
// idiom (per Plan 04 §4.2 ask-tier FP guard).

import { describe, expect, it } from "vitest";
import { checkJsLooseEquality } from "../checks/agent-safety.js";

describe("checkJsLooseEquality", () => {
	it("flags `if (x == y)` in TS", () => {
		const code = "if (x == y) { return; }";
		const matches = checkJsLooseEquality(code, "compare.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `if (x != y)` in TS", () => {
		const code = "if (x != y) doThing();";
		const matches = checkJsLooseEquality(code, "compare.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `if (x === y)` (correct usage)", () => {
		const code = "if (x === y) { return; }";
		expect(checkJsLooseEquality(code, "compare.ts")).toEqual([]);
	});

	it("does NOT flag `if (x !== y)` (correct usage)", () => {
		const code = "if (x !== y) doThing();";
		expect(checkJsLooseEquality(code, "compare.ts")).toEqual([]);
	});

	it("does NOT flag the `x == null` FP guard idiom (Plan 04 documented exception)", () => {
		const code = "if (x == null) return;";
		expect(checkJsLooseEquality(code, "compare.ts")).toEqual([]);
	});

	it("does NOT flag the `x != null` FP guard idiom (Plan 04 documented exception)", () => {
		const code = "if (x != null) doThing();";
		expect(checkJsLooseEquality(code, "compare.ts")).toEqual([]);
	});

	it("returns empty for non-JS/TS files", () => {
		expect(checkJsLooseEquality("if x == y: pass", "main.py")).toEqual([]);
	});

	it("ignores `==` inside a string literal", () => {
		const code = 'const msg = "use === not ==";';
		expect(checkJsLooseEquality(code, "comp.ts")).toEqual([]);
	});

	it("ignores `==` inside a comment", () => {
		const code = "// remember to use === not ==\nconst x = 1;";
		expect(checkJsLooseEquality(code, "comp.ts")).toEqual([]);
	});
});
