import { describe, expect, it } from "vitest";
import { cyclomaticForMetrics } from "./metrics.js";

// LANGUAGE-DISPATCH CONTRACT (finding: non-JS metrics reported zero). The old
// `computeCyclomaticAst(...) ?? computeCyclomaticComplexity(...)` returned ZERO
// functions for .py/.rs/.go: with `typescript` installed the AST pass returns an
// EMPTY array (not null) on a non-JS file, so the `??` language fallback never ran.
// The contract is DISPATCH (a valid file may have no functions), exercised here as
// the executable form: a branchy function in each language scores cyclomatic > 1.
//
// Deliberately NOT in metrics.test.ts — that suite module-mocks the analyzers to
// test the orchestrator; this needs the REAL language walkers.

describe("cyclomaticForMetrics — dispatches by language", () => {
	const PY = "def f(x):\n    if x > 0:\n        return 1\n    elif x < 0:\n        return -1\n    return 0\n";
	const RS = "fn f(x: i32) -> i32 {\n    if x > 0 { 1 } else if x < 0 { -1 } else { 0 }\n}\n";
	const GO =
		"func f(x int) int {\n    if x > 0 {\n        return 1\n    } else if x < 0 {\n        return -1\n    }\n    return 0\n}\n";
	const TS =
		"export function f(x: number): number {\n    if (x > 0) return 1;\n    if (x < 0) return -1;\n    return 0;\n}\n";

	it.each([
		["x.py", PY],
		["x.rs", RS],
		["x.go", GO],
		["x.ts", TS],
	])("%s yields a function scoring cyclomatic > 1 (not zero)", (path, content) => {
		const comps = cyclomaticForMetrics(content, path);
		expect(comps.length).toBeGreaterThanOrEqual(1);
		expect(Math.max(...comps.map((c) => c.cyclomatic))).toBeGreaterThan(1);
	});
});
