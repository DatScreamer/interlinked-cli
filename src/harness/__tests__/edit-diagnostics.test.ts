import { describe, expect, it } from "vitest";
import { findClosestSpans, formatNearMisses } from "../edit-diagnostics.js";

describe("findClosestSpans", () => {
	it("returns no matches when target is empty", () => {
		expect(findClosestSpans("foo\nbar", "")).toEqual([]);
	});

	it("returns no matches when content is empty", () => {
		expect(findClosestSpans("", "foo")).toEqual([]);
	});

	it("returns no matches when target longer than file", () => {
		expect(findClosestSpans("a\nb", "a\nb\nc\nd")).toEqual([]);
	});

	it("finds whitespace-variant single-line near miss", () => {
		const content = ["function foo() {", "  return 1;", "}"].join("\n");
		const target = "function foo () {";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBeGreaterThan(0);
		expect(misses[0].line).toBe(1);
		expect(misses[0].similarity).toBeGreaterThan(0.7);
	});

	it("finds multi-line near miss with one differing line", () => {
		const content = [
			"export function bar() {",
			"  const x = 1;",
			"  return x + 1;",
			"}",
			"",
			"export function baz() {",
			"  return 2;",
			"}",
		].join("\n");
		const target = ["export function bar() {", "  const x = 2;", "  return x + 1;", "}"].join(
			"\n",
		);
		const misses = findClosestSpans(content, target, 3);
		expect(misses[0].line).toBe(1);
		expect(misses[0].similarity).toBeGreaterThan(0.6);
	});

	it("returns up to N matches when several spans qualify", () => {
		const content = [
			"function alpha() {}",
			"function beta() {}",
			"function gamma() {}",
			"function delta() {}",
		].join("\n");
		const target = "function omega() {}";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBeLessThanOrEqual(3);
		expect(misses.every((m) => m.similarity >= 0.4)).toBe(true);
	});

	it("returns empty when nothing similar enough", () => {
		const content = "completely\nunrelated\ncontent\nhere";
		const target = "xQzZyY!@#$%^&*";
		expect(findClosestSpans(content, target)).toEqual([]);
	});

	it("dedupes overlapping windows by keeping the highest score", () => {
		const content = [
			"const x = 1;",
			"const x = 1;",
			"const x = 1;",
			"const y = 2;",
			"const z = 3;",
		].join("\n");
		const target = ["const x = 1;", "const x = 1;"].join("\n");
		const misses = findClosestSpans(content, target, 3);
		// Three overlapping windows would all match; dedup should collapse them
		// such that consecutive results don't overlap.
		for (let i = 1; i < misses.length; i++) {
			expect(Math.abs(misses[i].line - misses[i - 1].line)).toBeGreaterThanOrEqual(2);
		}
	});

	it("ranks higher-similarity spans first", () => {
		const content = [
			"function foo(x: number): number { return x; }",
			"function fooo(x: string): string { return x; }",
		].join("\n");
		const target = "function foo(x: number): number { return x; }";
		const misses = findClosestSpans(content, target, 2);
		expect(misses[0].line).toBe(1);
		expect(misses[0].similarity).toBe(1);
		if (misses.length > 1) {
			expect(misses[0].similarity).toBeGreaterThan(misses[1].similarity);
		}
	});
});

describe("formatNearMisses", () => {
	it("returns empty string for no misses", () => {
		expect(formatNearMisses([])).toBe("");
	});

	it("formats with line, percent, and snippet", () => {
		const formatted = formatNearMisses([
			{ line: 42, snippet: "function foo()", similarity: 0.875 },
		]);
		expect(formatted).toContain("L42");
		expect(formatted).toContain("88%");
		expect(formatted).toContain("function foo()");
	});

	it("joins multiple misses with newlines", () => {
		const formatted = formatNearMisses([
			{ line: 1, snippet: "a", similarity: 1 },
			{ line: 5, snippet: "b", similarity: 0.6 },
		]);
		expect(formatted.split("\n").length).toBe(2);
	});
});
