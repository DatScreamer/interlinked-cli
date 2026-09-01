import { describe, expect, it } from "vitest";
import { MutationRunPendingError } from "./cloud-runner.js";
import { pendingHandlesFrom } from "./gate.js";

const HANDLE = { jobId: "j1", runnerUrl: "http://runner/" };

/** The structural aggregate shape `pendingHandlesFrom` recovers from: an error
 *  carrying a `pending` array (formerly the sharded runner's ShardedRunFailure;
 *  the sharded runner is retired but the shape stays supported). */
function aggregateFailure(message: string, pending: unknown[]): Error {
	return Object.assign(new Error(message), { pending });
}

describe("pendingHandlesFrom — recovering claimable work from a thrown runner", () => {
	it("returns the handle a single runner rejected with", () => {
		const err = new MutationRunPendingError("j1", "http://runner/");
		expect(pendingHandlesFrom(err)).toEqual([expect.objectContaining(HANDLE)]);
	});

	it("returns every handle from an aggregate failure carrying a pending array", () => {
		const err = aggregateFailure("all failed", [
			new MutationRunPendingError("a", "http://one/"),
			new MutationRunPendingError("b", "http://two/"),
		]);
		expect(pendingHandlesFrom(err).map((h) => h.jobId)).toEqual(["a", "b"]);
	});

	it("returns nothing for a real failure — there is nothing to come back for", () => {
		expect(pendingHandlesFrom(new Error("connection refused"))).toEqual([]);
	});

	it("returns nothing when an aggregate failure has an empty pending list", () => {
		expect(pendingHandlesFrom(aggregateFailure("all failed", []))).toEqual([]);
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
