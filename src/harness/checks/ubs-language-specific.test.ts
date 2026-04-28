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
});
