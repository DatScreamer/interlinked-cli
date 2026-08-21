import { describe, expect, it } from "vitest";
import {
	checkBooleanTrap,
	checkFunctionArity,
	checkManyOptionalParams,
	checkPositionalOptionalBoolean,
} from "./taste.js";

describe("taste checks: mutation-directed contracts", () => {
	// test-contract: boundary — calls without a callable identifier must not be reported as boolean traps.
	it("does not report boolean literals in a non-call expression", () => {
		expect(checkBooleanTrap("const flags = [true, false];", "src/feature.ts")).toEqual([]);
	});

	// test-contract: public-api — a call with two top-level boolean literals is the documented boolean-trap smell.
	it("reports two top-level boolean literals while preserving the source line", () => {
		const result = checkBooleanTrap(
			'createUser("alice", true, false);',
			"src/feature.ts",
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ line: 1, text: 'createUser("alice", true, false);' });
	});

	// test-contract: invariant — test files are intentionally excluded from taste diagnostics.
	it("skips boolean traps in test files", () => {
		expect(checkBooleanTrap("createUser(\"alice\", true, false);", "feature.test.ts")).toEqual(
			[],
		);
	});

	// test-contract: public-api — non-destructured functions at the five-parameter threshold are reported, while four are accepted.
	it("uses the five-parameter arity threshold", () => {
		expect(checkFunctionArity("function four(a, b, c, d) {}", "src/feature.ts")).toEqual([]);
		expect(checkFunctionArity("function five(a, b, c, d, e) {}", "src/feature.ts")).toMatchObject([
			{ line: 1, text: expect.stringContaining("five") },
		]);
	});

	// test-contract: invariant — a single destructured object parameter is one named options value, not a long positional list.
	it("does not flag destructured options parameters as high arity", () => {
		expect(
			checkFunctionArity("function configure({ a, b, c, d, e }) {}", "src/feature.ts"),
		).toEqual([]);
	});

	// test-contract: public-api — optional positional booleans are flagged in function signatures, including typed defaults.
	it("reports optional positional boolean signatures", () => {
		const result = checkPositionalOptionalBoolean(
			"function setUser(name: string, force?: boolean) {}\nfunction archive(force: boolean = false) {}",
			"src/feature.ts",
		);
		expect(result).toHaveLength(2);
		expect(result.map((match) => match.line)).toEqual([1, 2]);
	});

	// test-contract: invariant — required booleans and tri-state unions are outside the narrow optional-boolean contract.
	it("does not report required or tri-state positional booleans", () => {
		const content =
			"function required(name: string, force: boolean) {}\n" +
			"function triState(force?: boolean | null) {}";
		expect(checkPositionalOptionalBoolean(content, "src/feature.ts")).toEqual([]);
	});

	// test-contract: public-api — three optional positional parameters are reported as a combinatorial call-shape smell.
	it("reports three or more optional parameters", () => {
		const result = checkManyOptionalParams(
			"function configure(a?: string, b = 1, c?: boolean) {}",
			"src/feature.ts",
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ line: 1, text: expect.stringContaining("configure") });
	});

	// test-contract: boundary — rest parameters are variadic and do not create optional-parameter combinations.
	it("does not count a rest parameter as an optional parameter", () => {
		expect(checkManyOptionalParams("function collect(...items: string[]) {}", "src/feature.ts")).toEqual(
			[],
		);
	});
});
