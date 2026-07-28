import { describe, expect, it } from "vitest";
import { MutationRunPendingError } from "./cloud-runner.js";
import { pendingHandlesFrom } from "./gate.js";
import { ShardedRunFailure } from "./sharded-runner.js";

const HANDLE = { jobId: "j1", runnerUrl: "http://runner/" };

describe("pendingHandlesFrom — recovering claimable work from a thrown runner", () => {
	it("returns the handle a single runner rejected with", () => {
		const err = new MutationRunPendingError("j1", "http://runner/");
		expect(pendingHandlesFrom(err)).toEqual([expect.objectContaining(HANDLE)]);
	});

	it("returns every shard's handle from a sharded failure", () => {
		const err = new ShardedRunFailure("all failed", [
			new MutationRunPendingError("a", "http://one/"),
			new MutationRunPendingError("b", "http://two/"),
		]);
		expect(pendingHandlesFrom(err).map((h) => h.jobId)).toEqual(["a", "b"]);
	});

	it("returns nothing for a real failure — there is nothing to come back for", () => {
		expect(pendingHandlesFrom(new Error("connection refused"))).toEqual([]);
	});

	it("returns nothing when every shard failed for a real reason", () => {
		expect(pendingHandlesFrom(new ShardedRunFailure("all failed", []))).toEqual([]);
	});

	it("ignores non-handle entries mixed into a pending list", () => {
		const err = Object.assign(new Error("x"), { pending: [HANDLE, { jobId: 7 }, null, "nope"] });
		expect(pendingHandlesFrom(err)).toEqual([HANDLE]);
	});

	it("survives values that are not errors at all", () => {
		// A runner can reject with anything; this runs inside a catch that must not throw.
		for (const v of [null, undefined, "boom", 42, {}, []]) {
			expect(pendingHandlesFrom(v)).toEqual([]);
		}
	});

	it("requires BOTH fields — a half-formed handle is not claimable", () => {
		expect(pendingHandlesFrom({ jobId: "j1" })).toEqual([]);
		expect(pendingHandlesFrom({ runnerUrl: "http://runner/" })).toEqual([]);
	});
});
