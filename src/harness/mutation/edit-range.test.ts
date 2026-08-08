import { describe, expect, it } from "vitest";
import { EDIT_RANGE_CONTEXT_LINES, type EditRange, type EditScope, describeEditScope, editScope } from "./edit-range.js";

/** Narrow to a span or fail the test outright. Keeps the assertions below free
 *  of `if (scope.kind !== "span") return`, which would let a wrong KIND pass as
 *  a silently skipped test. */
function spanOf(scope: EditScope): EditRange {
	expect(scope.kind).toBe("span");
	// SAFETY: the assertion above throws unless `kind` is "span".
	return (scope as Extract<EditScope, { kind: "span" }>).range;
}

/** A file long enough that a localized edit stays under the whole-file
 *  fraction, so these tests exercise the `span` branch rather than tripping the
 *  degrade-to-whole guard. */
function lines(n: number, marker?: { at: number; text: string }): string {
	return Array.from({ length: n }, (_, i) => (marker && i === marker.at ? marker.text : `line ${i}`)).join("\n");
}

describe("editScope — no change", () => {
	it("reports none for byte-identical content", () => {
		expect(editScope("a\nb\nc", "a\nb\nc")).toEqual({ kind: "none" });
	});

	it("reports none for two empty files", () => {
		expect(editScope("", "")).toEqual({ kind: "none" });
	});
});

describe("editScope — whole file", () => {
	it("reports whole for a newly created file", () => {
		expect(editScope("", "a\nb\nc")).toEqual({ kind: "whole" });
	});

	it("reports whole when the changed span covers most of the file", () => {
		expect(editScope("a\nb\nc\nd", "w\nx\ny\nz")).toEqual({ kind: "whole" });
	});

	it("reports whole for a short file where context padding swallows everything", () => {
		// A 5-line file with a 1-line change pads to 5 lines — scoping buys nothing.
		expect(editScope(lines(5), lines(5, { at: 2, text: "changed" }))).toEqual({ kind: "whole" });
	});
});

describe("editScope — localized span", () => {
	it("brackets a single changed line with context on both sides", () => {
		const scope = editScope(lines(100), lines(100, { at: 49, text: "changed" }));
		// Line index 49 is 1-based line 50; padded by the context constant.
		expect(scope).toEqual({
			kind: "span",
			range: { start: 50 - EDIT_RANGE_CONTEXT_LINES, end: 50 + EDIT_RANGE_CONTEXT_LINES },
		});
	});

	it("does not run off the top of the file", () => {
		const scope = editScope(lines(100), lines(100, { at: 0, text: "changed" }));
		expect(scope).toEqual({ kind: "span", range: { start: 1, end: 1 + EDIT_RANGE_CONTEXT_LINES } });
	});

	it("does not run off the bottom of the file", () => {
		const scope = editScope(lines(100), lines(100, { at: 99, text: "changed" }));
		expect(scope).toEqual({ kind: "span", range: { start: 100 - EDIT_RANGE_CONTEXT_LINES, end: 100 } });
	});

	it("spans from the first to the last changed line when two regions change", () => {
		const before = lines(100);
		const after = before
			.split("\n")
			.map((l, i) => (i === 20 || i === 30 ? "changed" : l))
			.join("\n");
		const scope = editScope(before, after);
		expect(scope).toEqual({
			kind: "span",
			range: { start: 21 - EDIT_RANGE_CONTEXT_LINES, end: 31 + EDIT_RANGE_CONTEXT_LINES },
		});
	});

	it("covers inserted lines", () => {
		const before = lines(100);
		const parts = before.split("\n");
		parts.splice(50, 0, "inserted a", "inserted b");
		const range = spanOf(editScope(before, parts.join("\n")));
		expect(range.start).toBeLessThanOrEqual(51);
		expect(range.end).toBeGreaterThanOrEqual(52);
	});

	it("anchors on the join point for a pure deletion, so surrounding code is still measured", () => {
		const before = lines(100);
		const parts = before.split("\n");
		parts.splice(50, 3);
		const range = spanOf(editScope(before, parts.join("\n")));
		// The deleted lines are gone; the span must still cover where they were.
		expect(range.start).toBeLessThanOrEqual(51);
		expect(range.end).toBeGreaterThanOrEqual(51);
	});

	it("never produces a range that starts after it ends", () => {
		const before = lines(100);
		const parts = before.split("\n");
		parts.splice(0, 4);
		const range = spanOf(editScope(before, parts.join("\n")));
		expect(range.start).toBeLessThanOrEqual(range.end);
	});

	it("keeps the span inside the file's real line count", () => {
		const after = lines(100, { at: 98, text: "changed" });
		const range = spanOf(editScope(lines(100), after));
		expect(range.end).toBeLessThanOrEqual(after.split("\n").length);
		expect(range.start).toBeGreaterThanOrEqual(1);
	});
});

describe("describeEditScope", () => {
	it("names the span so a reader does not assume the whole file was measured", () => {
		expect(describeEditScope({ kind: "span", range: { start: 10, end: 20 } }, "a.ts")).toBe(
			"a.ts: lines 10-20 (the edited span)",
		);
	});

	it("says whole file when the whole file was measured", () => {
		expect(describeEditScope({ kind: "whole" }, "a.ts")).toBe("a.ts: whole file");
	});

	it("says unchanged when nothing changed", () => {
		expect(describeEditScope({ kind: "none" }, "a.ts")).toBe("a.ts: unchanged");
	});
});
