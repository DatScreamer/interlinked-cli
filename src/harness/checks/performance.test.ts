// Co-located tests for performance.ts direct exports (loop-body extraction
// helpers + the Tier 1/2 checks defined in this file). Basic positive/
// negative cases for most Tier 1/2 checks already live in
// src/harness/__tests__/perf-checks.test.ts (imported via the generic-checks
// barrel) — this file targets branches that suite doesn't reach: the
// extension-mismatch early-returns, the reduce-scan cap/depth breaks, and
// the loop-body-extraction edge cases (no brace found, empty body, single-
// line Python body, unsupported extension).

import { describe, expect, it } from "vitest";
import {
	checkArrayFromMap,
	checkFilterLength,
	checkJsonClonePattern,
	checkMathSpread,
	checkSpreadInReduce,
	extractBraceLoopBodies,
	extractIndentLoopBodies,
	getLoopBodies,
} from "./performance.js";

describe("extractBraceLoopBodies", () => {
	it("finds the opening brace when it wraps onto a later line", () => {
		const code = "for (let i = 0; i < 10; i++)\n{\n    doWork();\n}\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    doWork();"]);
	});

	it("skips a loop head with no brace within the 5-line lookahead", () => {
		const code = "for (let i = 0; i < 10; i++)\n\n\n\n\nsomething();\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("skips a single-line loop whose braces are balanced on the head line", () => {
		const code = "for (let i = 0; i < 10; i++) {}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("skips a loop whose body closes immediately (zero body lines)", () => {
		const code = "for (let i = 0; i < 10; i++) {\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});
});

describe("extractIndentLoopBodies", () => {
	it("skips a single-line `for x: pass` body", () => {
		expect(extractIndentLoopBodies("for x in range(10): pass\n")).toEqual([]);
	});

	it("captures a multi-line indented body and stops at dedent", () => {
		const code = "for x in range(10):\n    a = 1\n    b = 2\nafter = 3\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    a = 1", "    b = 2"]);
	});

	it("produces an empty body when the next line dedents immediately", () => {
		const code = "for x in range(10):\nresult = 1\n";
		expect(extractIndentLoopBodies(code)).toEqual([]);
	});
});

describe("getLoopBodies", () => {
	it("dispatches to extractIndentLoopBodies for .py", () => {
		const code = "for x in range(10):\n    a = 1\n";
		expect(getLoopBodies(code, "loop.py")).toEqual(extractIndentLoopBodies(code));
	});

	it("dispatches to extractBraceLoopBodies for a brace language (.ts)", () => {
		const code = "for (let i = 0; i < 10; i++) {\n    a = 1;\n}\n";
		expect(getLoopBodies(code, "loop.ts")).toEqual(extractBraceLoopBodies(code));
	});

	it("returns [] for an unsupported extension", () => {
		const code = "for (let i = 0; i < 10; i++) {\n    a = 1;\n}\n";
		expect(getLoopBodies(code, "loop.txt")).toEqual([]);
	});
});

describe("checkSpreadInReduce — extension gate and scan-loop exits", () => {
	it("skips a non-JS/TS extension", () => {
		const code = "arr.reduce((acc, item) => { return [...acc, item]; }, []);";
		expect(checkSpreadInReduce(code, "util.py")).toEqual([]);
	});

	it("stops scanning a reduce callback once bracket depth returns to 0 without a spread", () => {
		const code = [
			"const sum = arr.reduce((acc, n) => {",
			"    return acc + n;",
			"}, 0);",
		].join("\n");
		expect(checkSpreadInReduce(code, "util.ts")).toEqual([]);
	});

	it("caps at 10 matches when 11+ reduce-spread blocks are present", () => {
		const blocks: string[] = [];
		for (let i = 0; i < 11; i++) {
			blocks.push(
				[
					`const r${i} = arr.reduce((acc, item) => {`,
					"    return [...acc, item];",
					"}, []);",
				].join("\n"),
			);
		}
		const out = checkSpreadInReduce(blocks.join("\n\n"), "util.ts");
		expect(out.length).toBe(10);
	});
});

describe("Tier 1/2 checks — extension-mismatch early return", () => {
	it("checkJsonClonePattern skips a non-JS/TS extension", () => {
		expect(
			checkJsonClonePattern("copy = JSON.parse(JSON.stringify(x))", "clone.py"),
		).toEqual([]);
	});

	it("checkFilterLength skips a non-JS/TS extension", () => {
		expect(checkFilterLength("items.filter(x => x).length", "stats.py")).toEqual([]);
	});

	it("checkMathSpread skips a non-JS/TS extension", () => {
		expect(checkMathSpread("Math.max(...values)", "stats.py")).toEqual([]);
	});

	it("checkArrayFromMap skips a non-JS/TS extension", () => {
		expect(checkArrayFromMap("Array.from(set).map(x => x)", "util.py")).toEqual([]);
	});
});
