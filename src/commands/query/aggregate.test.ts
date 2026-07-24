import { describe, expect, it } from "vitest";
import { createAggregateState, finalizeAggregate, foldRecord } from "./aggregate.js";

describe("aggregate", () => {
	it("counts records per value of the by-path", () => {
		const state = createAggregateState();
		foldRecord(state, { check_id: "a" }, "check_id");
		foldRecord(state, { check_id: "b" }, "check_id");
		foldRecord(state, { check_id: "a" }, "check_id");
		const rows = finalizeAggregate(state, 10);
		expect(rows).toEqual([
			{ key: "a", count: 2 },
			{ key: "b", count: 1 },
		]);
	});

	it("fans out array values so each element counts", () => {
		const state = createAggregateState();
		foldRecord(state, { checks: [{ id: "x" }, { id: "y" }] }, "checks.id");
		foldRecord(state, { checks: [{ id: "x" }] }, "checks.id");
		const rows = finalizeAggregate(state, 10);
		expect(rows).toEqual([
			{ key: "x", count: 2 },
			{ key: "y", count: 1 },
		]);
	});

	it("buckets records missing the by-path under (none)", () => {
		const state = createAggregateState();
		foldRecord(state, { other: 1 }, "check_id");
		foldRecord(state, { check_id: "a" }, "check_id");
		const rows = finalizeAggregate(state, 10);
		expect(rows).toContainEqual({ key: "(none)", count: 1 });
		expect(rows).toContainEqual({ key: "a", count: 1 });
	});

	it("sums a numeric field per group and sorts by the sum", () => {
		const state = createAggregateState();
		foldRecord(state, { session_id: "s1", output_tokens: 100 }, "session_id", "output_tokens");
		foldRecord(state, { session_id: "s2", output_tokens: 900 }, "session_id", "output_tokens");
		foldRecord(state, { session_id: "s1", output_tokens: 50 }, "session_id", "output_tokens");
		const rows = finalizeAggregate(state, 10);
		expect(rows).toEqual([
			{ key: "s2", count: 1, sum: 900 },
			{ key: "s1", count: 2, sum: 150 },
		]);
	});

	it("ignores non-numeric sum values but still counts the record", () => {
		const state = createAggregateState();
		foldRecord(state, { session_id: "s1", output_tokens: "n/a" }, "session_id", "output_tokens");
		foldRecord(state, { session_id: "s1", output_tokens: 10 }, "session_id", "output_tokens");
		const rows = finalizeAggregate(state, 10);
		expect(rows).toEqual([{ key: "s1", count: 2, sum: 10 }]);
	});

	it("applies the row limit after sorting and breaks ties by key", () => {
		const state = createAggregateState();
		for (const key of ["b", "a", "c", "a", "b", "d"]) {
			foldRecord(state, { k: key }, "k");
		}
		const rows = finalizeAggregate(state, 3);
		expect(rows).toEqual([
			{ key: "a", count: 2 },
			{ key: "b", count: 2 },
			{ key: "c", count: 1 },
		]);
	});
});
