import { describe, expect, it } from "vitest";
import {
	createPendingStore,
	PENDING_TTL_MS,
	reapExpired,
	recordPending,
	takePending,
} from "./pending-runs.js";

const NOW = 1_800_000_000_000;

function run(over: Partial<Parameters<typeof recordPending>[1]> = {}) {
	return {
		file: "src/a.ts",
		overlayHash: "hash-a",
		jobId: "job-1",
		runnerUrl: "http://runner-1/",
		startedAt: NOW,
		...over,
	};
}

describe("pending runs — correlation across the two hook windows", () => {
	it("hands back a run recorded for the same file and content", () => {
		const store = createPendingStore();
		recordPending(store, run());
		const found = takePending(store, "src/a.ts", "hash-a", NOW);
		expect(found).toHaveLength(1);
		expect(found[0]?.jobId).toBe("job-1");
	});

	it("returns nothing for a different file", () => {
		const store = createPendingStore();
		recordPending(store, run());
		expect(takePending(store, "src/other.ts", "hash-a", NOW)).toHaveLength(0);
	});

	it("returns nothing when the content changed between the hooks", () => {
		// PostToolUse must not attribute a PreToolUse measurement to different
		// bytes — the edit that landed would not be the edit that was measured.
		const store = createPendingStore();
		recordPending(store, run());
		expect(takePending(store, "src/a.ts", "different-hash", NOW)).toHaveLength(0);
	});

	it("is single-use: taking a run removes it", () => {
		const store = createPendingStore();
		recordPending(store, run());
		expect(takePending(store, "src/a.ts", "hash-a", NOW)).toHaveLength(1);
		expect(takePending(store, "src/a.ts", "hash-a", NOW)).toHaveLength(0);
	});

	it("returns every shard recorded for one edit", () => {
		// A sharded edit has one pending job PER runner; all must be harvested.
		const store = createPendingStore();
		recordPending(store, run({ jobId: "job-1", runnerUrl: "http://r1/" }));
		recordPending(store, run({ jobId: "job-2", runnerUrl: "http://r2/" }));
		expect(takePending(store, "src/a.ts", "hash-a", NOW)).toHaveLength(2);
	});

	it("does not return a run older than the TTL", () => {
		// A hook pair that never closed must not leak into an unrelated later edit.
		const store = createPendingStore();
		recordPending(store, run({ startedAt: NOW - PENDING_TTL_MS - 1 }));
		expect(takePending(store, "src/a.ts", "hash-a", NOW)).toHaveLength(0);
	});
});

describe("reapExpired — the store must not grow without bound", () => {
	it("drops entries past the TTL and reports how many", () => {
		const store = createPendingStore();
		recordPending(store, run({ jobId: "old", startedAt: NOW - PENDING_TTL_MS - 1 }));
		recordPending(store, run({ jobId: "fresh", file: "src/b.ts", overlayHash: "h" }));
		expect(reapExpired(store, NOW)).toBe(1);
		expect(takePending(store, "src/b.ts", "h", NOW)).toHaveLength(1);
	});

	it("reports zero when nothing has expired", () => {
		const store = createPendingStore();
		recordPending(store, run());
		expect(reapExpired(store, NOW)).toBe(0);
	});

	it("is safe on an empty store", () => {
		expect(reapExpired(createPendingStore(), NOW)).toBe(0);
	});
});
