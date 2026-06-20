// ===========================================
// file-checks React / test-smell / taste group unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { runReactAndTasteChecks } from "./file-checks-react-test.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";
import { nonNull } from "../../lib/non-null.js";

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

describe("runReactAndTasteChecks", () => {
	it("flags nested ternaries (nested_ternaries)", () => {
		const c = ctx('const x = a ? (b ? 1 : 2) : (c ? 3 : 4);\n');
		runReactAndTasteChecks(c);
		expect(c.r.nestedTernaries.length).toBeGreaterThan(0);
		expect(nonNull(c.r.nestedTernaries[0]).check).toBe("nested_ternaries");
	});

	it("flags an else-if chain (else_if_chain)", () => {
		// ELSE_IF_CHAIN requires `if (...){...}` + 2+ braced `else if` blocks.
		const c = ctx(
			"if (n === 1) { a(); } else if (n === 2) { b(); }" +
				" else if (n === 3) { c(); } else if (n === 4) { d(); }\n",
		);
		runReactAndTasteChecks(c);
		expect(c.r.elseIfChain.length).toBeGreaterThan(0);
		expect(nonNull(c.r.elseIfChain[0]).check).toBe("else_if_chain");
	});

	it("produces the same nested_ternaries findings as the orchestrator (delegation)", () => {
		const src = 'const x = a ? (b ? 1 : 2) : (c ? 3 : 4);\n';
		const c = ctx(src);
		runReactAndTasteChecks(c);
		expect(c.r.nestedTernaries).toEqual(orchestrate(src).nestedTernaries);
	});

	it("runs PII detection into piiDetection bucket without throwing", () => {
		const c = ctx('export const value = 1;\n');
		expect(() => runReactAndTasteChecks(c)).not.toThrow();
		expect(Array.isArray(c.r.piiDetection)).toBe(true);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runReactAndTasteChecks(c);
		expect(c.r.nestedTernaries).toHaveLength(0);
		expect(c.r.elseIfChain).toHaveLength(0);
	});
});
