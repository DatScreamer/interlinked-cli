// ===========================================
// file-checks agent-safety group unit tests
// ===========================================
// Direct tests for the extracted agent-safety helpers. The orchestrator
// `runPerFileChecks` is asserted to delegate to these helpers (same findings,
// same order) via an equivalence check.

import { describe, expect, it } from "vitest";
import { runAgentSafetyChecks, runCrapCheck } from "./file-checks-agent-safety.js";
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

describe("runAgentSafetyChecks", () => {
	it("flags a thrown string literal (throw_literal)", () => {
		const c = ctx('throw "boom";\n');
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral.length).toBeGreaterThan(0);
		expect(c.r.throwLiteral[0].check).toBe("throw_literal");
	});

	it("flags eval usage (eval_usage)", () => {
		const c = ctx('const out = eval(userInput);\n');
		runAgentSafetyChecks(c);
		expect(c.r.evalUsage.length).toBeGreaterThan(0);
		expect(c.r.evalUsage[0].check).toBe("eval_usage");
	});

	it("flags a silently-swallowed promise rejection (silent_promise_catch)", () => {
		const c = ctx('fetch("/api").catch(() => {});\n');
		runAgentSafetyChecks(c);
		expect(c.r.silentPromiseSwallow.length).toBeGreaterThan(0);
		expect(c.r.silentPromiseSwallow[0].check).toBe("silent_promise_catch");
	});

	it("produces the same throw_literal findings as the orchestrator (delegation)", () => {
		const src = 'throw "boom";\n';
		const c = ctx(src);
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral).toEqual(orchestrate(src).throwLiteral);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral).toHaveLength(0);
		expect(c.r.evalUsage).toHaveLength(0);
		expect(c.r.silentPromiseSwallow).toHaveLength(0);
	});
});

describe("runCrapCheck", () => {
	it("is fail-open (no findings) when no coverage-final.json is present", () => {
		// cwd points at a dir with no coverage/coverage-final.json — the check
		// must emit nothing rather than throw.
		const c = ctx('function f() { return 1; }\n');
		expect(() => runCrapCheck(c)).not.toThrow();
		expect(c.r.crap).toHaveLength(0);
	});
});
