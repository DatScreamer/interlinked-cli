import { beforeEach, describe, expect, it } from "vitest";
import { overlayHash, pendingRegistry, resetPendingRegistry } from "./pending-registry.js";
import { PENDING_TTL_MS, recordPending, takePending } from "./pending-runs.js";

const NOW = 1_800_000_000_000;

beforeEach(() => {
	resetPendingRegistry();
});

describe("overlayHash — correlating the two windows by content", () => {
	it("is stable for the same content", () => {
		expect(overlayHash("const a = 1;")).toBe(overlayHash("const a = 1;"));
	});

	it("differs for content that differs by one byte", () => {
		// This is the whole safety property: a later window must not claim results
		// measured against different bytes than the ones that landed.
		expect(overlayHash("const a = 1;")).not.toBe(overlayHash("const a = 2;"));
	});

	it("handles empty content without throwing", () => {
		expect(overlayHash("")).toMatch(/^[0-9a-f]+$/);
	});
});

describe("pendingRegistry — the daemon-scoped store", () => {
	it("returns the same store across calls, so the second window finds the first's work", () => {
		const a = pendingRegistry(NOW);
		recordPending(a, {
			file: "src/a.ts",
			overlayHash: "h",
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		expect(takePending(pendingRegistry(NOW), "src/a.ts", "h", NOW)).toHaveLength(1);
	});

	it("reaps runs older than the TTL rather than growing forever", () => {
		const store = pendingRegistry(NOW);
		recordPending(store, {
			file: "src/a.ts",
			overlayHash: "h",
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		// A daemon runs for days; an abandoned handle must not outlive its usefulness.
		const later = pendingRegistry(NOW + PENDING_TTL_MS + 1);
		expect(takePending(later, "src/a.ts", "h", NOW + PENDING_TTL_MS + 1)).toHaveLength(0);
	});

	it("is emptied by reset, so tests cannot leak state into each other", () => {
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: "h",
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		resetPendingRegistry();
		expect(takePending(pendingRegistry(NOW), "src/a.ts", "h", NOW)).toHaveLength(0);
	});
});
