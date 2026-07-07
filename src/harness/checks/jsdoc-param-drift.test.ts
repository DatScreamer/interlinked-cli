import { describe, expect, it } from "vitest";
import { detectJsdocParamDrift } from "./jsdoc-param-drift.js";

// ─── helpers ───────────────────────────────────────────────────────────────

const TS_FILE = "src/lib/util.ts";

// ─── Positive cases — MUST fire ────────────────────────────────────────────

describe("detectJsdocParamDrift — positive cases (must fire)", () => {
	it("flags a @param naming a renamed function parameter", () => {
		const code = `
/**
 * Format a duration.
 * @param oldName the raw milliseconds
 */
export function formatDuration(ms: number): string {
	return \`\${ms}ms\`;
}
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "oldName"');
		expect(results[0]?.text).toContain("formatDuration");
	});

	it("flags a stale @param on a class method", () => {
		const code = `
class Store {
	/**
	 * @param key the lookup key
	 * @param staleValue no longer a parameter
	 */
	get(key: string): string | undefined {
		return this.map.get(key);
	}
}
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "staleValue"');
	});

	it("flags a stale @param on an arrow function documented on its const", () => {
		const code = `
/**
 * @param wrongName mismatched
 */
export const double = (n: number): number => n * 2;
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "wrongName"');
	});

	it("flags a @param surviving after the parameter was removed entirely", () => {
		const code = `
/**
 * @param opts removed in a refactor
 */
function reset(): void {
	state.clear();
}
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "opts"');
	});

	it("reports the 1-based line number of the stale tag", () => {
		const code = [
			"/**",
			" * Adds two numbers.",
			" * @param wrong stale tag on line 3",
			" */",
			"function add(a: number, b: number): number { return a + b; }",
		].join("\n");
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.line).toBe(3);
	});

	it("caps findings at 10 per file", () => {
		const fns: string[] = [];
		for (let i = 0; i < 15; i++) {
			fns.push(`
/** @param stale${i} gone */
function fn${i}(x: number): number { return x; }
`);
		}
		const results = detectJsdocParamDrift(fns.join("\n"), TS_FILE);
		expect(results.length).toBeLessThanOrEqual(10);
	});
});

// ─── Negative cases — MUST NOT fire ────────────────────────────────────────

describe("detectJsdocParamDrift — negative cases (must NOT fire)", () => {
	it("does not flag @param tags that match the parameters", () => {
		const code = `
/**
 * @param a first addend
 * @param b second addend
 */
function add(a: number, b: number): number {
	return a + b;
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("skips functions with destructured parameters entirely", () => {
		const code = `
/**
 * @param options config bag (documents the destructured object by convention)
 * @param anything even a wild name is skipped here
 */
function configure({ retries, timeout }: { retries: number; timeout: number }): void {
	run(retries, timeout);
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("skips dotted @param forms like options.x (property documentation)", () => {
		const code = `
/**
 * @param options config bag
 * @param options.retries how many times to retry
 * @param options.timeout per-attempt budget
 */
function configure(options: { retries: number; timeout: number }): void {
	run(options);
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("skips implementations that have sibling overload signatures", () => {
		const code = `
/**
 * @param value the string form
 */
export function parse(value: string): number;
/**
 * @param raw the buffer form
 */
export function parse(raw: Buffer): number;
export function parse(input: string | Buffer): number {
	return Number(input.toString());
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("accepts a @param naming a rest parameter", () => {
		const code = `
/**
 * @param args values to join
 */
function joinAll(...args: string[]): string {
	return args.join(",");
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("skips functions with a rest parameter entirely (variadic doc conventions vary)", () => {
		// Some conventions document logical variadic args by name — a mismatched
		// tag here is not provably drift, so the whole function is skipped.
		const code = `
/**
 * @param first the first value
 * @param second the second value
 */
function pick(...values: string[]): string {
	return values[0] ?? "";
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("accepts a @param documenting an underscore-prefixed (unused) parameter", () => {
		// Convention: the doc keeps the logical name while the param is
		// underscore-prefixed to mark it unused — not drift.
		const code = `
/**
 * @param rawLines original source lines (unused in this variant)
 * @param stripped comment-stripped lines
 */
function scan(_rawLines: string[], stripped: string[]): number {
	return stripped.length;
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("does not treat '@param' mentioned mid-prose in a description as a tag", () => {
		// Dogfood-observed FP: a doc sentence that MENTIONS @param is parsed as
		// a tag by TS but is not documenting a parameter of this function.
		const code = `
/**
 * Detect @param names in JSDoc that don't match function parameter names.
 */
function checkMismatch(filePath: string, relPath: string): number {
	return filePath.length + relPath.length;
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("skips bodiless ambient declarations", () => {
		const code = `
/**
 * @param anything ambient decl — no body to check against
 */
declare function ambient(other: string): void;
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	it("does not fire on a non-JS/TS file", () => {
		const code = `
/**
 * @param stale not even parsed
 */
def helper(fresh):
    pass
`;
		expect(detectJsdocParamDrift(code, "scripts/helper.py")).toEqual([]);
	});

	it("does not fire on files with no @param tags at all", () => {
		const code = `
/** Plain description, no tags. */
function noop(x: number): number { return x; }
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("detectJsdocParamDrift — edge cases", () => {
	it("handles constructors: stale ctor @param fires, matching one does not", () => {
		const code = `
class A {
	/** @param seed initial value */
	constructor(seed: number) { this.v = seed; }
}
class B {
	/** @param stale renamed away */
	constructor(fresh: number) { this.v = fresh; }
}
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "stale"');
	});

	it("only the mismatched tag fires when good and stale tags coexist", () => {
		const code = `
/**
 * @param a still real
 * @param gone renamed away
 */
function f(a: number, b: number): number { return a + b; }
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "gone"');
	});

	it("nested functions are checked independently of the outer JSDoc", () => {
		const code = `
/**
 * @param outer real outer param
 */
function wrapper(outer: number): () => number {
	return function inner(): number {
		return outer;
	};
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});
});
