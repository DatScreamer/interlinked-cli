// ===========================================
// file-checks endpoint-security / agent-laziness group unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

function ctx(content: string, file = "/tmp/sample.ts"): FileCheckContext {
	return { file, content, relPath: "sample.ts", cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

function orchestrate(content: string, file = "/tmp/sample.ts"): CodeQualityResults {
	const r = emptyResults();
	runPerFileChecks({
		file,
		content,
		cwd: "/tmp",
		r,
		moduleExportsCache: new Map(),
		allEnvRefs: new Map(),
		piiOpts: {},
	});
	return r;
}

describe("runEndpointAndLazinessChecks", () => {
	it("flags a not-implemented stub throw (stub_not_implemented_throw)", () => {
		const c = ctx('function handler() { throw new Error("not implemented"); }\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.stubNotImplementedThrow.length).toBeGreaterThan(0);
		expect(c.r.stubNotImplementedThrow[0].check).toBe("stub_not_implemented_throw");
	});

	it("flags a dead branch literal (dead_branch_literal)", () => {
		const c = ctx('if (true) { doThing(); }\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.deadBranchLiteral.length).toBeGreaterThan(0);
		expect(c.r.deadBranchLiteral[0].check).toBe("dead_branch_literal");
	});

	it("produces the same dead_branch_literal findings as the orchestrator (delegation)", () => {
		const src = 'if (true) { doThing(); }\n';
		const c = ctx(src);
		runEndpointAndLazinessChecks(c);
		expect(c.r.deadBranchLiteral).toEqual(orchestrate(src).deadBranchLiteral);
	});

	it("populates endpoint-security buckets without throwing", () => {
		const c = ctx('export const value = 1;\n');
		expect(() => runEndpointAndLazinessChecks(c)).not.toThrow();
		expect(Array.isArray(c.r.endpointAuthMissing)).toBe(true);
		expect(Array.isArray(c.r.endpointMassAssignment)).toBe(true);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runEndpointAndLazinessChecks(c);
		expect(c.r.stubNotImplementedThrow).toHaveLength(0);
		expect(c.r.deadBranchLiteral).toHaveLength(0);
	});
});
