// Companion tests for the shared offset→line helpers in shared-text-utils.ts.
//
// These helpers replace seven byte-for-byte copies of
//   `stripped.slice(0, offset).split("\n").length`
// that lived in unit-mismatch / assert-side-effects / correctness-misc /
// reinterpret-alignment / error-context / portability / nan-coercion, plus the
// binary-search variant in unsafe-span. The copies' semantics are the SPEC, so
// the parity block below pins the shared implementations against a literal
// re-statement of the old body across a corpus of edge-case offsets.

import { describe, expect, it } from "vitest";
import { buildLineIndex, buildLineStarts, offsetToLine } from "./shared-text-utils.js";

/** The exact body every one of the seven deleted copies had. The spec. */
function legacyOffsetToLine(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

const CORPUS: readonly string[] = [
	"",
	"a",
	"\n",
	"\n\n\n",
	"one\ntwo\nthree",
	"one\ntwo\nthree\n",
	"\nleading",
	"trailing\n",
	"a\r\nb\r\nc",
	"x".repeat(50),
	`${"line\n".repeat(40)}tail`,
];

describe("offsetToLine — parity with the seven deleted copies", () => {
	it("matches slice+split for every offset in every corpus string", () => {
		for (const text of CORPUS) {
			for (let offset = 0; offset <= text.length; offset++) {
				expect(offsetToLine(text, offset)).toBe(legacyOffsetToLine(text, offset));
			}
		}
	});

	it("matches slice+split for out-of-range and negative offsets", () => {
		for (const text of CORPUS) {
			for (const offset of [-1, -3, -1000, text.length + 1, text.length + 500]) {
				expect(offsetToLine(text, offset)).toBe(legacyOffsetToLine(text, offset));
			}
		}
	});

	it("is 1-indexed at offset 0", () => {
		expect(offsetToLine("a\nb", 0)).toBe(1);
	});

	it("counts the newline itself as belonging to the line it terminates", () => {
		// "a\nb": offset 1 is the \n → still line 1; offset 2 is 'b' → line 2.
		expect(offsetToLine("a\nb", 1)).toBe(1);
		expect(offsetToLine("a\nb", 2)).toBe(2);
	});
});

describe("buildLineStarts", () => {
	it("returns [0] for an empty string", () => {
		expect(buildLineStarts("")).toEqual([0]);
	});

	it("records the offset just past each newline", () => {
		expect(buildLineStarts("one\ntwo\nthree")).toEqual([0, 4, 8]);
	});

	it("records a final empty line after a trailing newline", () => {
		expect(buildLineStarts("a\n")).toEqual([0, 2]);
	});
});

describe("buildLineIndex.lineAt — parity with the one-shot form", () => {
	it("agrees with offsetToLine for every offset in every corpus string", () => {
		for (const text of CORPUS) {
			const index = buildLineIndex(text);
			for (let offset = 0; offset <= text.length; offset++) {
				expect(index.lineAt(offset)).toBe(legacyOffsetToLine(text, offset));
			}
		}
	});

	it("agrees for out-of-range and negative offsets", () => {
		for (const text of CORPUS) {
			const index = buildLineIndex(text);
			for (const offset of [-1, -3, -1000, text.length + 1, text.length + 500]) {
				expect(index.lineAt(offset)).toBe(legacyOffsetToLine(text, offset));
			}
		}
	});

	it("exposes the same lineStarts array buildLineStarts produces", () => {
		const text = "one\ntwo\nthree\n";
		expect(buildLineIndex(text).lineStarts).toEqual(buildLineStarts(text));
	});

	it("stays correct on a large input where a linear scan would be quadratic", () => {
		const text = `${"abcdefghij\n".repeat(5000)}end`;
		const index = buildLineIndex(text);
		expect(index.lineAt(0)).toBe(1);
		expect(index.lineAt(11)).toBe(2);
		expect(index.lineAt(text.length)).toBe(5001);
	});
});
