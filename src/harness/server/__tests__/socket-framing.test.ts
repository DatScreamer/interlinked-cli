import { describe, expect, it } from "vitest";
import { LineFramer } from "../socket-framing.js";

describe("LineFramer", () => {
	it("yields a single complete line", () => {
		const f = new LineFramer();
		expect(f.push('{"a":1}\n')).toEqual(['{"a":1}']);
		expect(f.pending).toBe("");
	});

	it("yields multiple lines from one chunk in arrival order", () => {
		const f = new LineFramer();
		expect(f.push("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
		expect(f.pending).toBe("");
	});

	it("retains a trailing partial line across chunks", () => {
		const f = new LineFramer();
		expect(f.push('{"a":')).toEqual([]);
		expect(f.pending).toBe('{"a":');
		expect(f.push('1}\n')).toEqual(['{"a":1}']);
		expect(f.pending).toBe("");
	});

	it("reassembles a line split across three chunks", () => {
		const f = new LineFramer();
		expect(f.push("he")).toEqual([]);
		expect(f.push("ll")).toEqual([]);
		expect(f.push("o\n")).toEqual(["hello"]);
	});

	it("drops blank and whitespace-only lines (prior `if (!line.trim())`)", () => {
		const f = new LineFramer();
		// Leading blank line, a real line, then a whitespace-only line.
		expect(f.push("\nreal\n   \n")).toEqual(["real"]);
	});

	it("handles a chunk carrying a complete line plus a partial remainder", () => {
		const f = new LineFramer();
		expect(f.push("first\nsec")).toEqual(["first"]);
		expect(f.pending).toBe("sec");
		expect(f.push("ond\n")).toEqual(["second"]);
	});

	it("returns nothing for a chunk with no newline", () => {
		const f = new LineFramer();
		expect(f.push("no newline here")).toEqual([]);
		expect(f.pending).toBe("no newline here");
	});

	it("preserves interior whitespace and JSON content verbatim", () => {
		const f = new LineFramer();
		expect(f.push('{"cmd":"echo  hi"}\n')).toEqual(['{"cmd":"echo  hi"}']);
	});

	it("treats consecutive newlines as empty lines and drops them", () => {
		const f = new LineFramer();
		expect(f.push("a\n\n\nb\n")).toEqual(["a", "b"]);
	});
});
