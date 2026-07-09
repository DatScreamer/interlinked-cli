// ===========================================
// file-checks UBS group unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { runUbsChecks } from "./file-checks-ubs.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";
import { nonNull } from "../../lib/non-null.js";

function ctx(content: string, file = "/tmp/sample.ts", relPath = "sample.ts"): FileCheckContext {
	return { file, content, relPath, cwd: "/tmp", r: emptyResults(), piiOpts: {} };
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

describe("runUbsChecks", () => {
	it("flags JS loose equality (ubs_js_loose_equality)", () => {
		const c = ctx('if (x == 5) { doThing(); }\n');
		runUbsChecks(c);
		expect(c.r.jsLooseEquality.length).toBeGreaterThan(0);
		expect(nonNull(c.r.jsLooseEquality[0]).check).toBe("ubs_js_loose_equality");
	});

	it("flags Python None equality (ubs_py_none_equality)", () => {
		const c = ctx("if x == None:\n    pass\n", "/tmp/sample.py", "sample.py");
		runUbsChecks(c);
		expect(c.r.pyNoneEquality.length).toBeGreaterThan(0);
		expect(nonNull(c.r.pyNoneEquality[0]).check).toBe("ubs_py_none_equality");
	});

	it("flags Rust debug_assert side effects (ubs_rust_debug_assert_side_effect)", () => {
		const c = ctx(
			"fn f(queue: &mut Vec<u8>) { debug_assert_eq!(queue.pop(), Some(1)); }\n",
			"/tmp/sample.rs",
			"sample.rs",
		);
		runUbsChecks(c);
		expect(c.r.rustDebugAssertSideEffect.length).toBeGreaterThan(0);
		expect(nonNull(c.r.rustDebugAssertSideEffect[0]).check).toBe(
			"ubs_rust_debug_assert_side_effect",
		);
	});

	it("flags document.write (ubs_document_write)", () => {
		const c = ctx('document.write("<p>hi</p>");\n');
		runUbsChecks(c);
		expect(c.r.documentWrite.length).toBeGreaterThan(0);
		expect(nonNull(c.r.documentWrite[0]).check).toBe("ubs_document_write");
	});

	it("produces the same ubs_js_loose_equality findings as the orchestrator (delegation)", () => {
		const src = 'if (x == 5) { doThing(); }\n';
		const c = ctx(src);
		runUbsChecks(c);
		expect(c.r.jsLooseEquality).toEqual(orchestrate(src).jsLooseEquality);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value: number = 1;\n');
		runUbsChecks(c);
		expect(c.r.jsLooseEquality).toHaveLength(0);
		expect(c.r.documentWrite).toHaveLength(0);
		expect(c.r.weakHash).toHaveLength(0);
	});
});
