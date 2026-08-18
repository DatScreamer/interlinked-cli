// Kills 3 surviving mutants that only manifest when the optional `typescript`
// dep fails to resolve: astComplexityAvailable's `loadTs() !== null` guard,
// parseTsSource's `!ts` guard, and computeCyclomaticAst's `!parsed` guard. All
// three collapse to the SAME root cause (loadTs() returning null), so they
// share one node:module mock. Isolated in its own file — the whole-file mock
// would break the happy-path suite in cyclomatic-ast.test.ts. Mirrors the
// established pattern in type-smuggling-ts-unavailable.test.ts /
// jsdoc-param-drift-ts-unavailable.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: () => () => {
			throw new Error("Cannot find module 'typescript'");
		},
	};
});

import { astComplexityAvailable, computeCyclomaticAst, parseTsSource } from "./cyclomatic-ast.js";

describe("cyclomatic-ast — TypeScript not installed (loadTs() resolves to null)", () => {
	// test-contract: invariant — astComplexityAvailable is the one documented
	// signal (surfaced by `interlinked harness status`) that the AST path
	// degraded; it must read false, not true, when the optional dep is absent.
	it("astComplexityAvailable reports false when typescript cannot be resolved", () => {
		expect(astComplexityAvailable()).toBe(false);
	});

	// test-contract: invariant — parseTsSource's documented degrade contract
	// ("Returns null when the optional typescript dep is unavailable") is a
	// null return, not a thrown error.
	it("parseTsSource returns null instead of throwing", () => {
		expect(parseTsSource("const x = 1;", "src/x.ts")).toBeNull();
	});

	// test-contract: invariant — computeCyclomaticAst's documented degrade
	// contract ("caller falls back to the regex walker") is the same
	// null-return, one level up the call chain.
	it("computeCyclomaticAst returns null instead of throwing", () => {
		expect(computeCyclomaticAst("function f() { return 1; }", "src/x.ts")).toBeNull();
	});
});
