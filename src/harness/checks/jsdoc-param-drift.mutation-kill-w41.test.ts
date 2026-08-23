import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetJsdocParamTsCacheForTesting, detectJsdocParamDrift } from "./jsdoc-param-drift.js";

// Spy on node:module's createRequire so the two cache-lifecycle tests below can
// count how many times `loadTs()` actually re-resolves the `typescript` module.
vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: vi.fn((...args: Parameters<typeof actual.createRequire>) => actual.createRequire(...args)),
	};
});

const TS_FILE = "src/lib/util.ts";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("detectJsdocParamDrift — mutation-kill w41", () => {
	// test-contract: invariant — loadTs caches the resolved `typescript` module;
	// a `false` cache-check condition would re-require on every call.
	it("caches the resolved typescript module across calls (single require per cache lifetime)", () => {
		__resetJsdocParamTsCacheForTesting();
		const code = "/**\n * @param stale x\n */\nfunction fn(fresh) { return fresh; }\n";
		const first = detectJsdocParamDrift(code, TS_FILE);
		const second = detectJsdocParamDrift(code, TS_FILE);
		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
		expect(createRequire).toHaveBeenCalledTimes(1);
	});

	// test-contract: invariant — __resetJsdocParamTsCacheForTesting must actually
	// clear tsCache, not be a no-op, so a reset forces the next call to re-require.
	it("actually clears the cached module — reset then reload triggers a fresh require", () => {
		__resetJsdocParamTsCacheForTesting();
		const code = "/**\n * @param stale x\n */\nfunction fn(fresh) { return fresh; }\n";
		const first = detectJsdocParamDrift(code, TS_FILE);
		__resetJsdocParamTsCacheForTesting();
		const second = detectJsdocParamDrift(code, TS_FILE);
		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
		expect(createRequire).toHaveBeenCalledTimes(2);
	});

	// test-contract: public-api — isCheckableFunction deliberately excludes
	// get/set accessors; forcing it (or its call site) to `true` would flag them.
	it("does not flag get/set accessors even with a stale @param tag (excluded by isCheckableFunction)", () => {
		const code = `
class Store {
	/**
	 * @param stale mismatched
	 */
	get value() { return this._v; }
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	// test-contract: public-api — functionNameOf must special-case constructors
	// to the literal "constructor" label, not fall through to "(anonymous)".
	it("labels a stale constructor @param finding with 'constructor', not '(anonymous)'", () => {
		const code = `
class A {
	/** @param stale mismatched */
	constructor(fresh: number) {}
}
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain("matches no parameter of constructor");
	});

	// test-contract: public-api — functionNameOf's no-name fallback is "" so the
	// caller's `|| "(anonymous)"` kicks in; a non-empty fallback would leak through.
	it("labels an anonymous function expression's stale @param finding as '(anonymous)'", () => {
		const code = `
/** @param stale mismatched */
const cb = function (fresh) { return fresh; };
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain("matches no parameter of (anonymous)");
	});

	// test-contract: public-api — acceptedNameSet's regex strips only LEADING
	// underscore runs; a mid-name underscore must not be collapsed.
	it("does not strip a mid-name underscore — a tag naming the collapsed form still drifts", () => {
		const code = `
/**
 * @param myvar mismatched (only the underscored form is accepted)
 */
function fn(my_var: number): number { return my_var; }
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('@param "myvar"');
	});

	// test-contract: public-api — the leading-underscore strip is `+` (all
	// consecutive underscores), not just one.
	it("strips ALL leading underscores, not just one, from an accepted param name", () => {
		const code = `
/**
 * @param rawLines documents the double-underscored unused param by its logical name
 */
function fn(__rawLines: string[]): number { return __rawLines.length; }
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	// test-contract: public-api — an overload implementation's OWN JSDoc must
	// still be skipped when overloadKeys correctly marks it as overloaded; this
	// exercises collectOverloadKeys' visit body/conditions AND checkFunctionNode's
	// own overloadKeys.has() lookup (the earlier fixture's implementation carried
	// no JSDoc of its own, so it couldn't distinguish these mutants).
	it("skips an overload implementation's OWN mismatched @param via correct overload-key tracking", () => {
		const code = `
export function parse(value: string): number;
export function parse(raw: Buffer): number;
/**
 * @param mismatched not any real parameter name
 */
export function parse(input: string | Buffer): number {
	return Number(input.toString());
}
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	// test-contract: public-api — checkFunctionNode filters getJSDocTags down to
	// isJSDocParameterTag; dropping the filter lets non-@param tags (e.g. @returns)
	// reach the name-comparison logic.
	it("only compares @param tags, not other JSDoc tags like @returns", () => {
		const code = `
/**
 * @param a a real param
 * @returns something
 */
function fn(a: number): number { return a; }
`;
		expect(detectJsdocParamDrift(code, TS_FILE)).toEqual([]);
	});

	// test-contract: public-api — the (params: ...) label joins real parameter
	// names with ", " when there are any.
	it("includes the real parameter names, comma-joined, in the (params: ...) label", () => {
		const code = `
/**
 * @param stale mismatched
 */
function fn(a: number, b: number): number { return a + b; }
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain("(params: a, b)");
	});

	// test-contract: boundary — the raw report line is truncated to
	// REPORT_LINE_TRUNC (150) characters.
	it("truncates the raw report line to REPORT_LINE_TRUNC (150) characters", () => {
		const padding = "x".repeat(200);
		const code = `
/**
 * @param stale ${padding}
 */
function fn(fresh: number): number { return fresh; }
`;
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		const text = results[0]?.text ?? "";
		const rawPart = text.split(" — ").pop() ?? "";
		expect(rawPart.length).toBeLessThanOrEqual(150);
	});

	// test-contract: public-api — the raw report line is trimmed before use, so
	// no leading/trailing whitespace from the source line survives.
	it("trims leading/trailing whitespace from the raw report line", () => {
		const code = "/**\n * @param stale   mismatched line   \n */\nfunction fn(fresh) { return fresh; }\n";
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		const text = results[0]?.text ?? "";
		const rawPart = text.split(" — ").pop() ?? "";
		expect(rawPart.startsWith(" ")).toBe(false);
		expect(rawPart).toBe(rawPart.trim());
	});

	// test-contract: public-api — the raw-text lookup uses (lineNo - 1), the
	// tag's own line, never a neighboring line.
	it("looks up the raw line at (lineNo - 1), not a neighboring line", () => {
		const code = [
			"/**",
			" * @param stale MARKER_ON_TAG_LINE",
			" * more description below MARKER_BELOW",
			" */",
			"function fn(fresh) { return fresh; }",
		].join("\n");
		const results = detectJsdocParamDrift(code, TS_FILE);
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain("MARKER_ON_TAG_LINE");
		expect(results[0]?.text).not.toContain("MARKER_BELOW");
	});

	// test-contract: public-api — non-JS/TS extensions are skipped outright, even
	// when the content would parse cleanly as TS if given the chance.
	it("does not fire on a file whose extension is not JS/TS, even with parseable-looking content", () => {
		const code = `
/**
 * @param stale mismatched
 */
function fn(fresh) { return fresh; }
`;
		expect(detectJsdocParamDrift(code, "src/lib/notes.txt")).toEqual([]);
	});
});
