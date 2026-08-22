import { describe, expect, it } from "vitest";
import { checkRegexFromInterpolation } from "./regex-interpolation.js";

const file = "src/lib/patterns.ts";
const run = (source: string, path = file) => checkRegexFromInterpolation(source, path);

describe("regex_from_interpolation mutation survivors", () => {
	// test-contract: boundary — only RegExp with at most twenty spaces after `new` is a call site.
	it("requires the complete bounded constructor spacing", () => {
		expect(run("const re = new RegExp(`${user}`);")).toHaveLength(1);
	});

	// test-contract: invariant — a plain assignment from an escape call exempts the identifier, but a later reassignment cancels it.
	it("uses the last escape assignment", () => {
		const source = [
			"let n = escapeForRegex(user);",
			"n = n + suffix;",
			"const re = new RegExp(`${n}`);",
		].join("\n");
		expect(run(source).map((finding) => finding.line)).toEqual([3]);
	});

	// test-contract: boundary — an empty template substitution body is dynamic, while a nonempty CONST_CASE substitution is exempt.
	it("distinguishes empty and constant substitutions", () => {
		expect(run("const re = new RegExp(`${}`);")).toHaveLength(1);
		expect(run("const re = new RegExp(`${CONST_PART}`);")).toHaveLength(0);
	});

	// test-contract: boundary — trailing whitespace after a bare template is harmless, but a chained expression is outside the template shape.
	it("requires a bare template after the closing backtick", () => {
		expect(run("const re = new RegExp(`${user}`   );")).toHaveLength(1);
		expect(run("const re = new RegExp(`${user}`.trim());")).toHaveLength(0);
	});

	// test-contract: boundary — empty operands and ordinary literal operands are classified distinctly from dynamic operands.
	it("classifies empty, literal, numeric, and dynamic operands", () => {
		expect(run("const re = new RegExp('' + user);")).toHaveLength(1);
		expect(run("const re = new RegExp('a' + 'b');")).toHaveLength(0);
		expect(run("const re = new RegExp(42 + 7);")).toHaveLength(0);
	});

	// test-contract: boundary — malformed template scans conservatively and do not produce a finding.
	it("bails on malformed templates", () => {
		expect(run("const re = new RegExp(`${user);")).toHaveLength(0);
	});

	// test-contract: boundary — malformed interpolation classification is conservative, while a valid dynamic interpolation reports.
	it("reports valid interpolation and preserves malformed verdict handling", () => {
		expect(run("const re = new RegExp(`${user}`);")).toHaveLength(1);
		expect(run("const re = new RegExp(`${escapeRegExp(user)}`);")).toHaveLength(0);
	});

	// test-contract: boundary — a regex literal's final slash and flags hide embedded RegExp text from call-site matching.
	it("lexes regex literals through their flags", () => {
		expect(run("const hidden = /RegExp(`${user}`)/giu;")).toHaveLength(0);
	});

	// test-contract: boundary — a call at the exact end of source is parsed without reading beyond the input.
	it("handles end-of-input call boundaries", () => {
		expect(run("new RegExp(`${user}`)")).toHaveLength(1);
	});

	// test-contract: boundary — a division slash after a value exposes the following real RegExp call, unlike a regex-literal slash.
	it("distinguishes division from regex literals", () => {
		expect(run("const x = value / RegExp(`${user}`);" )).toHaveLength(1);
		expect(run("const x = /RegExp(`${user}`)/;" )).toHaveLength(0);
	});

	// test-contract: boundary — plus signs inside strings, regexes, and nested expressions do not split the outer argument.
	it("splits concatenation only at top level", () => {
		expect(run("const re = new RegExp('a+b' + user);")).toHaveLength(1);
		expect(run("const re = new RegExp(/a+b/ + CONST_PART);")).toHaveLength(1);
		expect(run("const re = new RegExp(make(a + b));")).toHaveLength(0);
	});

	// test-contract: boundary — quoted strings containing comment markers remain string content, and comments containing calls remain inert.
	it("keeps strings and comments out of the lexer views", () => {
		const source = [
			"const text = '/* new RegExp(`${fake}`) */';",
			"// new RegExp(`${alsoFake}`)",
			"const re = new RegExp(`${real}`);",
		].join("\n");
		expect(run(source).map((finding) => finding.line)).toEqual([3]);
	});
});
