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

	// Regression pin for the 2026-08-27 daemon melt: the old implementation
	// (`buffer += chunk` + full-buffer indexOf) flattened the whole buffer on
	// every chunk, so a single large line arriving in socket-sized chunks cost
	// O(n²) memmove — ~90MB took minutes and stalled the event loop into the
	// "zombie" liveness state. The array-of-parts framer is O(n): this bound
	// passes in well under a second; the old code cannot meet it.
	it(
		"frames a 32MB single-line payload delivered in 64KB chunks in linear time",
		{ timeout: 10_000 },
		() => {
			const f = new LineFramer();
			const chunk = "x".repeat(64 * 1024);
			const chunks = 512; // 32MB total
			const started = performance.now();
			for (let i = 0; i < chunks; i++) {
				expect(f.push(chunk)).toEqual([]);
			}
			const [line] = f.push("\n");
			const elapsedMs = performance.now() - started;
			expect(line?.length).toBe(chunks * chunk.length);
			expect(f.pending).toBe("");
			// Generous bound: linear framing measures ~50-150ms here; the old
			// quadratic framer takes minutes. Headroom covers slow CI machines.
			expect(elapsedMs).toBeLessThan(5_000);
		},
	);
});
