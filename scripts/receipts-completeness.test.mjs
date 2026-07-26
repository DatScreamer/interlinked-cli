import { describe, expect, it } from "vitest";
import { incompleteHistoryError, missingSources } from "./receipts-completeness.mjs";

/** An audit result shaped like `audit()` returns. */
function result(sources, over = {}) {
	return {
		sources,
		total_verified: 327,
		total_logged: 549,
		window_start: "2026-05-13T16:55:56.232Z",
		...over,
	};
}

describe("missingSources", () => {
	it("returns only the segments flagged missing", () => {
		const r = result([
			{ file: "activity.jsonl", blocks: 100 },
			{ file: "archive-0001.jsonl.gz", blocks: 0, missing: true },
		]);
		expect(missingSources(r).map((s) => s.file)).toEqual(["archive-0001.jsonl.gz"]);
	});

	it("is empty when every segment was readable", () => {
		expect(missingSources(result([{ file: "activity.jsonl", blocks: 10 }]))).toEqual([]);
	});

	it("tolerates a result with no sources field", () => {
		expect(missingSources({})).toEqual([]);
		expect(missingSources(undefined)).toEqual([]);
	});
});

describe("incompleteHistoryError", () => {
	it("returns null when history is complete, so the write proceeds", () => {
		expect(incompleteHistoryError(result([{ file: "activity.jsonl", blocks: 10 }]))).toBeNull();
	});

	it("refuses and names every missing segment", () => {
		const r = result([
			{ file: "a.archive", missing: true },
			{ file: "b.jsonl.gz", missing: true },
			{ file: "activity.jsonl", blocks: 5 },
		]);
		const msg = incompleteHistoryError(r);
		expect(msg).toContain("REFUSING");
		expect(msg).toContain("2 history segment(s) missing");
		expect(msg).toContain("a.archive");
		expect(msg).toContain("b.jsonl.gz");
	});

	// The numbers are the whole argument for refusing — an operator who cannot
	// see how far the totals dropped has no basis to judge the override.
	it("quotes the understated totals and the shifted window", () => {
		const msg = incompleteHistoryError(result([{ file: "x", missing: true }]));
		expect(msg).toContain("327 verified / 549 logged");
		expect(msg).toContain("2026-05-13");
	});

	it("names the deliberate override", () => {
		expect(incompleteHistoryError(result([{ file: "x", missing: true }]))).toContain(
			"--allow-partial",
		);
	});

	it("degrades to placeholders rather than printing undefined", () => {
		const msg = incompleteHistoryError({ sources: [{ file: "x", missing: true }] });
		expect(msg).not.toContain("undefined");
		expect(msg).toContain("? verified / ? logged");
	});
});
