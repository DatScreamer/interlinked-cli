import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commitPendingRegistry,
	initPendingRegistryStore,
	overlayHash,
	pendingRegistry,
	resetPendingRegistry,
} from "./pending-registry.js";
import { PENDING_TTL_MS, recordPending, takePending } from "./pending-runs.js";

const NOW = 1_800_000_000_000;

beforeEach(() => {
	resetPendingRegistry();
});

describe("durable pending registry — survives a daemon restart (assume instability)", () => {
	const run = {
		file: "src/f.ts",
		overlayHash: "a".repeat(16),
		jobId: "job-1",
		runnerUrl: "https://runner.example",
		startedAt: NOW,
	};

	it("P1: a committed handle is claimable after a simulated daemon restart", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			// Daemon dies: all in-memory state gone; a fresh daemon re-inits.
			resetPendingRegistry();
			initPendingRegistryStore(root);
			const claimed = takePending(pendingRegistry(NOW + 1000), "src/f.ts", "a".repeat(16), NOW + 1000);
			expect(claimed.map((r) => r.jobId)).toEqual(["job-1"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N1: an EXPIRED handle does not resurrect across the restart", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			resetPendingRegistry();
			initPendingRegistryStore(root);
			const later = NOW + PENDING_TTL_MS + 1;
			const claimed = takePending(pendingRegistry(later), "src/f.ts", "a".repeat(16), later);
			expect(claimed).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N2: without a store root, restart loses the handle (old in-memory semantics)", () => {
		recordPending(pendingRegistry(NOW), run);
		commitPendingRegistry();
		resetPendingRegistry();
		const claimed = takePending(pendingRegistry(NOW + 1000), "src/f.ts", "a".repeat(16), NOW + 1000);
		expect(claimed).toEqual([]);
	});

	it("P2: a corrupt store file degrades to empty, never throws", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			// Corrupt the file, then restart.
			writeFileSync(join(root, ".interlinked", "pending-mutation-runs.json"), "{nope", "utf-8");
			resetPendingRegistry();
			initPendingRegistryStore(root);
			expect(pendingRegistry(NOW + 1).runs).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P3: publishes private state atomically with mode 0600", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			const directory = join(root, ".interlinked");
			const file = join(directory, "pending-mutation-runs.json");
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N3: refuses a symlinked registry without overwriting its target", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		const outside = mkdtempSync(join(tmpdir(), "pending-store-target-"));
		const external = join(outside, "external.json");
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(external, "outside stays unchanged");
			symlinkSync(external, join(root, ".interlinked", "pending-mutation-runs.json"));
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			expect(readFileSync(external, "utf8")).toBe("outside stays unchanged");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("N4: rehydrates only exact bounded HTTP(S) rows", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(
				join(root, ".interlinked", "pending-mutation-runs.json"),
				JSON.stringify([
					run,
					{ ...run, runnerUrl: "file:///etc/passwd" },
					{ ...run, overlayHash: "short" },
					{ ...run, startedAt: 1.5 },
					{ ...run, unexpected: true },
				]),
			);
			initPendingRegistryStore(root);
			expect(pendingRegistry(NOW).runs).toEqual([run]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
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
