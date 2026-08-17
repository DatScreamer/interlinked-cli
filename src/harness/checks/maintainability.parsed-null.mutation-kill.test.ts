// Mutation-kill companion for maintainability.ts's two "AST unavailable"
// guards (LEAN MODE, pass-1 fleet, W6). Split into its OWN file because
// `vi.mock` is file-hoisted: mocking `./cyclomatic-ast.js` here would
// silently force every OTHER test in the main companion file onto this
// null-parse path too. Same split, same reason, as
// src/harness/evaluator/complexity-write-guard.mutation-kill.test.ts (see its
// own header comment for the precedent).

import { describe, expect, it, vi } from "vitest";

vi.mock("./cyclomatic-ast.js", () => ({
	parseTsSource: () => null,
	isImplementationFunction: () => false,
	functionName: () => "",
}));

import { computeMaintainability, maintainabilityCheck } from "./maintainability.js";

describe("computeMaintainability — AST unavailable", () => {
	// test-contract: invariant — cyclomatic-ast.ts's own documented contract:
	// when the AST is unavailable, parseTsSource returns null and the caller
	// must degrade to null too, not throw by destructuring a null `parsed`.
	it("returns null instead of throwing when the AST is unavailable", () => {
		expect(computeMaintainability("function f() { return 1; }", "x.ts")).toBeNull();
	});
});

describe("maintainabilityCheck — AST unavailable", () => {
	// test-contract: invariant — maintainabilityCheck degrades to a silent []
	// when computeMaintainability reports null, matching every other check's
	// "absent parser means no-op" contract; it must not call .filter() on null.
	it("returns an empty array instead of throwing when the AST is unavailable", () => {
		expect(maintainabilityCheck("function f() { return 1; }", "x.ts")).toEqual([]);
	});
});
