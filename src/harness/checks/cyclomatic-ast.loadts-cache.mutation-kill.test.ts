// Kills 2 surviving mutants in loadTs()'s cache guard: the `tsCache !==
// undefined` early-return condition, and the try-block body that performs the
// require. Both collapse the cache into "re-attempt resolution on every
// call" — observable only by counting how many times the underlying
// `require("typescript")` actually ran across two loadTs() invocations.
// Isolated in its own file — the whole-file node:module mock would break the
// happy-path suite in cyclomatic-ast.test.ts. Mirrors the call-counting
// technique in tsc-overlay.no-typescript.test.ts.

import { describe, expect, it, vi } from "vitest";

const requireTypescriptMock = vi.fn();

vi.mock("node:module", () => ({
	createRequire: () => (id: string) => {
		requireTypescriptMock(id);
		return { fakeTsModule: true };
	},
}));

import { astComplexityAvailable } from "./cyclomatic-ast.js";

describe("cyclomatic-ast — loadTs() caches the resolved module", () => {
	// test-contract: invariant — loadTs()'s own doc comment: "Cached (including
	// the null result) so a missing dep costs one failed require" — a
	// SUCCESSFUL resolve must be cached too; a second call must not re-invoke
	// createRequire.
	it("requires the typescript module exactly once across two astComplexityAvailable() calls", () => {
		expect(astComplexityAvailable()).toBe(true);
		expect(astComplexityAvailable()).toBe(true);
		expect(requireTypescriptMock).toHaveBeenCalledTimes(1);
	});
});
