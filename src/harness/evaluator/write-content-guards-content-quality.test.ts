// Co-located tests for the content-quality guard's A5 JSON.parse heuristic.
// Regression coverage for the false positive where a JSON.parse guarded by an
// ENCLOSING try block (with the catch many lines below) was flagged, and where a
// JSON.parse mentioned only in a string/comment fired. The detector now delegates
// to the brace-tracked checkJsonParseUnsafe (stripped content + try-depth scan)
// instead of the old "is there a `try {` in the 5 lines directly above" window.

import { describe, expect, it } from "vitest";
import { collectContentQualityWarnings } from "./write-content-guards-content-quality.js";

const JP = "JSON.parse() without try-catch";

/** Content-quality warnings for a proposed TS file, filtered to the A5 line. */
function jsonParseWarnings(fileName: string, content: string): string[] {
	return collectContentQualityWarnings(`/repo/src/${fileName}`, content, "/repo").filter((w) =>
		w.includes(JP),
	);
}

describe("collectContentQualityWarnings — A5 JSON.parse enclosing-try", () => {
	it("does NOT flag a JSON.parse guarded by an enclosing try whose opener is >5 lines above", () => {
		const content = [
			"export function load(raw: string): unknown {",
			"  try {",
			"    step1();",
			"    step2();",
			"    step3();",
			"    step4();",
			"    step5();",
			"    step6();",
			"    const parsed = JSON.parse(raw);",
			"    return parsed;",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(jsonParseWarnings("load.ts", content)).toEqual([]);
	});

	it("does NOT flag a JSON.parse still inside the outer try after an inline try/catch (the hooks-template shape)", () => {
		const content = [
			"export function flush(raw: string): unknown {",
			"  try {",
			"    if (cond) {",
			"      try { cleanup(); } catch (_e) { /* ignore */ }",
			"    }",
			"    const parsed = JSON.parse(raw);",
			"    return parsed;",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(jsonParseWarnings("flush.ts", content)).toEqual([]);
	});

	it("does NOT flag JSON.parse mentioned only in a string or comment", () => {
		const content = [
			"// remember to wrap JSON.parse(x) in a try",
			'const help = "call JSON.parse(raw) carefully";',
			"export const x = 1;",
		].join("\n");
		expect(jsonParseWarnings("doc.ts", content)).toEqual([]);
	});

	it("still flags a bare unguarded JSON.parse", () => {
		const content = ["export function p(raw: string): unknown {", "  return JSON.parse(raw);", "}"].join("\n");
		expect(jsonParseWarnings("bare.ts", content).length).toBe(1);
	});

	it("still flags an unguarded JSON.parse AFTER an enclosing try has closed", () => {
		const content = [
			"export function f(a: string, b: string): unknown {",
			"  try {",
			"    return JSON.parse(a);",
			"  } catch {",
			"    /* fall through */",
			"  }",
			"  return JSON.parse(b);",
			"}",
		].join("\n");
		expect(jsonParseWarnings("after.ts", content).length).toBe(1);
	});
});
