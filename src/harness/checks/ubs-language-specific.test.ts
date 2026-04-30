// Colocated red/green tests for the public surface of `ubs-language-specific.ts`.
// The full test surface lives in `src/harness/__tests__/ubs-*.test.ts`; this
// file exists to satisfy the colocation gate while remaining a useful smoke
// signal that the two functions exist and respect the language gate.

import { describe, expect, it } from "vitest";
import {
	checkDivisionByVariable,
	checkJavaOptionalGet,
} from "./ubs-language-specific.js";

describe("ubs-language-specific (smoke)", () => {
	it("checkJavaOptionalGet flags Optional<T>....get() in a Java file", () => {
		const code = "Optional<String> x = svc.find(); return x.get();";
		expect(checkJavaOptionalGet(code, "Sample.java").length).toBeGreaterThan(0);
	});

	it("checkJavaOptionalGet returns empty for non-Java files", () => {
		const code = "Optional<string> x = svc.find(); return x.get();";
		expect(checkJavaOptionalGet(code, "sample.ts")).toEqual([]);
	});

	it("checkDivisionByVariable flags `a / b`", () => {
		expect(checkDivisionByVariable("const r = a / b;", "calc.ts").length).toBeGreaterThan(0);
	});

	it("checkDivisionByVariable does not flag division by a numeric literal", () => {
		expect(checkDivisionByVariable("const r = a / 2;", "calc.ts")).toEqual([]);
	});

	// Regression: markdown table separators like `▲/▼/○` and prose alternation
	// like `staged / modified / clean` are bilateral-id-shaped and would fire
	// the regex if not gated by the source-extension allow-list. Doc edits
	// repeatedly tripped this during the statusline redesign before the gate
	// was confirmed.
	it("checkDivisionByVariable skips markdown files even with division-looking content", () => {
		const tableContent =
			"| `▲/▼/○` glyph | source | (none) | Up / stale / not-installed |";
		expect(checkDivisionByVariable(tableContent, "docs/design/foo.md")).toEqual([]);
		expect(checkDivisionByVariable(tableContent, "README.mdx")).toEqual([]);
	});

	it("checkDivisionByVariable skips plain-text and unknown extensions", () => {
		const prose = "states: pending / in_progress / completed";
		expect(checkDivisionByVariable(prose, "notes.txt")).toEqual([]);
		expect(checkDivisionByVariable(prose, "config.yaml")).toEqual([]);
		expect(checkDivisionByVariable(prose, "/tmp/no-extension")).toEqual([]);
	});
});
