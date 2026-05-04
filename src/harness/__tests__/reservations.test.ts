// Property-based tests for the reservation state machine + integration
// tests for the optimistic-grant rollback.
//
// Pure-machine tests exercise `applyTransition` / `replayTransitions`
// directly (no I/O, no cohort, no timers) to assert invariants Bitar's
// SSoT framing buys us:
//   - replay(events) == applyEvent loop on the same events (no drift)
//   - release is idempotent and ownership-respecting
//   - no two distinct agents ever appear as holders of the same file
//   - evict_remote leaves local entries alone
//   - release_all targets exactly the named agent
//
// Integration tests exercise the rollback gap that previously had a
// silent `.catch(() => {})`: a server-rejected optimistic grant must
// remove the local entry and emit a conflict with reason "server-rejected".

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import {
	applyTransition,
	type ReservationCache,
	type ReservationEventSink,
	type ReservationLogEvent,
	ReservationManager,
	type ReservationTxn,
	replayTransitions,
	type ServerApiClient,
	type ServerReservation,
} from "../reservations.js";
import { ServerBridge } from "../server-bridge.js";
import type { HarnessEvent } from "../types.js";

// ===========================================
// Generators
// ===========================================

const fileArb = fc.constantFrom("a.ts", "b.ts", "c.ts", "d.ts");
const agentArb = fc.constantFrom("alice", "bob", "carol");

const grantLocalArb = fc.record({
	kind: fc.constant("grant_local" as const),
	file: fileArb,
	agent: agentArb,
	reservedAt: fc.constant("2026-05-01T00:00:00.000Z"),
	expiresAt: fc.constant("2026-05-01T01:00:00.000Z"),
});

const grantRemoteArb = fc.record({
	kind: fc.constant("grant_remote" as const),
	file: fileArb,
	agent: agentArb,
	reservedAt: fc.constant("2026-05-01T00:00:00.000Z"),
	expiresAt: fc.constant("2026-05-01T01:00:00.000Z"),
});

const releaseArb = fc.record({
	kind: fc.constant("release" as const),
	file: fileArb,
	agent: agentArb,
});

const releaseAllArb = fc.record({
	kind: fc.constant("release_all" as const),
	agent: agentArb,
});

const expireArb = fc.record({
	kind: fc.constant("expire" as const),
	file: fileArb,
});

const evictRemoteArb = fc.record({
	kind: fc.constant("evict_remote" as const),
	file: fileArb,
});

const txnArb: fc.Arbitrary<ReservationTxn> = fc.oneof(
	grantLocalArb,
	grantRemoteArb,
	releaseArb,
	releaseAllArb,
	expireArb,
	evictRemoteArb,
);

const txnSeqArb = fc.array(txnArb, { minLength: 0, maxLength: 50 });

function serialize(state: ReservationCache): Array<[string, unknown]> {
	return [...state.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => [k, { ...v }]);
}

// ===========================================
// Pure machine — Bitar SSoT invariants
// ===========================================

describe("ReservationTxn — pure state machine", () => {
	it("replay produces identical state to incremental application (Bitar invariant)", () => {
		fc.assert(
			fc.property(txnSeqArb, (events) => {
				const live: ReservationCache = new Map();
				for (const e of events) applyTransition(live, e);
				const replayed = replayTransitions(events);
				expect(serialize(live)).toEqual(serialize(replayed));
			}),
			{ numRuns: 200 },
		);
	});

	it("no two distinct agents ever appear as holders of the same file", () => {
		fc.assert(
			fc.property(txnSeqArb, (events) => {
				const state = replayTransitions(events);
				const seen = new Map<string, string>();
				for (const [file, entry] of state) {
					const prior = seen.get(file);
					expect(prior === undefined || prior === entry.agent_name).toBe(true);
					seen.set(file, entry.agent_name);
				}
			}),
			{ numRuns: 100 },
		);
	});

	it("release is idempotent: release(x,a) twice yields the same state as once", () => {
		const seed: ReservationTxn[] = [
			{ kind: "grant_local", file: "a.ts", agent: "alice", reservedAt: "t0", expiresAt: "t1" },
		];
		const once = replayTransitions([...seed, { kind: "release", file: "a.ts", agent: "alice" }]);
		const twice = replayTransitions([
			...seed,
			{ kind: "release", file: "a.ts", agent: "alice" },
			{ kind: "release", file: "a.ts", agent: "alice" },
		]);
		expect(serialize(once)).toEqual(serialize(twice));
	});

	it("release does NOT remove an entry held by a different agent", () => {
		const state = replayTransitions([
			{ kind: "grant_local", file: "a.ts", agent: "alice", reservedAt: "t0", expiresAt: "t1" },
			{ kind: "release", file: "a.ts", agent: "bob" }, // wrong owner
		]);
		expect(state.get("a.ts")?.agent_name).toBe("alice");
	});

	it("evict_remote leaves local entries untouched", () => {
		const state = replayTransitions([
			{ kind: "grant_local", file: "a.ts", agent: "alice", reservedAt: "t0", expiresAt: "t1" },
			{ kind: "grant_remote", file: "b.ts", agent: "bob", reservedAt: "t0", expiresAt: "t1" },
			{ kind: "evict_remote", file: "a.ts" },
			{ kind: "evict_remote", file: "b.ts" },
		]);
		expect(state.get("a.ts")?.cohort).toBe("local");
		expect(state.has("b.ts")).toBe(false);
	});

	it("release_all removes every entry held by the agent and only those", () => {
		fc.assert(
			fc.property(txnSeqArb, agentArb, (events, victim) => {
				const finalState = replayTransitions([
					...events,
					{ kind: "release_all", agent: victim },
				]);
				for (const [, entry] of finalState) {
					expect(entry.agent_name).not.toBe(victim);
				}
			}),
			{ numRuns: 100 },
		);
	});

	it("expire(file) is a no-op when the file is not in the cache", () => {
		const empty = replayTransitions([{ kind: "expire", file: "phantom.ts" }]);
		expect(empty.size).toBe(0);
	});
});

// ===========================================
// ReservationManager — optimistic-grant rollback (the load-bearing fix)
// ===========================================

class StubApi implements ServerApiClient {
	public reserveCalls: Array<[string, string, number]> = [];
	public releaseCalls: Array<[string, string]> = [];

	constructor(
		private behavior: "accept" | "reject" = "accept",
		private listing: ServerReservation[] = [],
	) {}

	async reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void> {
		this.reserveCalls.push([filePath, agentName, ttlSeconds]);
		if (this.behavior === "reject") throw new Error("server rejected");
	}
	async releaseFile(filePath: string, agentName: string): Promise<void> {
		this.releaseCalls.push([filePath, agentName]);
	}
	async listReservations(): Promise<ServerReservation[]> {
		return this.listing;
	}
}

function joinEvent(name: string): HarnessEvent {
	return {
		hook_event: "SessionStart",
		session_id: `${name}-session`,
		agent_source: "claude",
		agent_name: name,
		timestamp: "2026-05-01T00:00:00.000Z",
	};
}

function flushMicrotasks(): Promise<void> {
	return new Promise((r) => setImmediate(r));
}

describe("ReservationManager — optimistic-grant rollback", () => {
	let events: ReservationLogEvent[];
	let cohort: CohortManager;
	let mgr: ReservationManager;
	let api: StubApi;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		events = [];
		cohort = new CohortManager();
	});

	afterEach(() => {
		mgr?.shutdown();
	});

	it("server-accept: local grant persists and no conflict event fires", async () => {
		api = new StubApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		const conflict = mgr.checkAndReserve("a.ts", "alice", cohort);
		expect(conflict).toBeNull();
		await flushMicrotasks();
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
	});

	it("server-reject rolls back the local grant + emits a server-rejected conflict event", async () => {
		api = new StubApi("reject");
		mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		const conflict = mgr.checkAndReserve("a.ts", "alice", cohort);
		// Optimistic grant returns null synchronously — caller can proceed.
		expect(conflict).toBeNull();
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);
		// Async server-confirm fails → rollback happens on the microtask queue.
		await flushMicrotasks();
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		const rejectEvt = events.find(
			(e) => e.action === "conflict" && e.conflict_reason === "server-rejected",
		);
		expect(rejectEvt).toBeDefined();
		expect(rejectEvt?.file).toBe("a.ts");
		expect(rejectEvt?.agent_name).toBe("alice");
		// Cohort tracking is rolled back too.
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);
	});

	it("server-reject after explicit release: cache stays empty + conflict still emits", async () => {
		api = new StubApi("reject");
		mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		mgr.release("a.ts", "alice", cohort); // released before server replies
		await flushMicrotasks();
		expect(mgr.getAll()).toEqual([]);
		expect(events.some((e) => e.action === "release")).toBe(true);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
	});

	it("preexisting conflict is tagged differently than server-rejected", async () => {
		api = new StubApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		cohort.agentJoined(joinEvent("bob"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		await flushMicrotasks();
		events.length = 0;
		const conflict = mgr.checkAndReserve("a.ts", "bob", cohort);
		expect(conflict?.agent_name).toBe("alice");
		const conflictEvt = events.find((ev) => ev.action === "conflict");
		expect(conflictEvt?.conflict_reason).toBe("preexisting");
	});
});

// ===========================================
// ServerBridge — real reserveFile() path (the regression of record)
// ===========================================
//
// The pre-fix `ServerBridge.reserveFile()` swallowed *all* callTool errors,
// so the rollback path in reservations.ts:266-269 only fired against the
// in-test StubApi. These tests exercise the real ServerBridge by mocking
// global fetch, so a regression that re-introduces a bare catch-all
// `void e` will fail here — not just in the stub.

describe("ServerBridge.reserveFile — real path (fetch-mocked)", () => {
	let cohort: CohortManager;
	let events: ReservationLogEvent[];
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		cohort = new CohortManager();
		events = [];
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		mgr?.shutdown();
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function makeBridge(): ServerBridge {
		return new ServerBridge({
			serverUrl: "http://localhost:9999",
			workspaceKey: "main",
			projectKey: "main",
		});
	}

	function mockFetch(impl: (url: string) => Response | Promise<Response>): void {
		globalThis.fetch = vi.fn(((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			return Promise.resolve(impl(url));
		}) as typeof globalThis.fetch);
	}

	it("server-rejected (conflicts[] non-empty): rolls back local grant + emits server-rejected conflict", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			// /api/ui/call → file_reservation_paths returns explicit conflict
			return new Response(
				JSON.stringify({
					result: {
						granted: [],
						conflicts: [
							{ file: "a.ts", reserved_by: "other-agent", reservation_pattern: "a.ts" },
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		const conflict = mgr.checkAndReserve("a.ts", "alice", cohort);
		expect(conflict).toBeNull(); // optimistic local grant
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);

		// async server-confirm fails → rollback on microtask queue
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		const rejectEvt = events.find(
			(e) => e.action === "conflict" && e.conflict_reason === "server-rejected",
		);
		expect(rejectEvt).toBeDefined();
		expect(rejectEvt?.file).toBe("a.ts");
		expect(rejectEvt?.agent_name).toBe("alice");
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);
		bridge.shutdown();
	});

	it("server-rejected (ok:false): rolls back local grant + emits server-rejected conflict", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(JSON.stringify({ result: { ok: false, reason: "denied" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("b.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "b.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});

	it("network error: optimistic grant is preserved (no rollback, no conflict event)", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			throw new TypeError("simulated network error");
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("c.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "c.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		expect(cohort.getAgent("alice")?.files_reserved).toContain("c.ts");
		bridge.shutdown();
	});

	it("HTTP 5xx (transient/timeout class): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("internal error", { status: 503 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("d.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		// callTool throws on !res.ok → swallowed → no rollback
		expect(mgr.getAll().some((e) => e.file_pattern === "d.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("server-accept (granted, empty conflicts): grant persists, no conflict", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(
				JSON.stringify({ result: { granted: ["e.ts"], conflicts: [] } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("e.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "e.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 409 (callTool throws explicit denial): rolls back local grant", async () => {
		// Pre-fix: callTool's `throw new Error("Server API error: 409")` was
		// caught and swallowed unconditionally, so 4xx denials never reached
		// the rollback path. Post-fix: isExplicitDenialError re-throws on 4xx.
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("conflict", { status: 409 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("f.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "f.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});

	it("HTTP 408 (request timeout class): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("timeout", { status: 408 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("g.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "g.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 429 (rate limited): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("too many", { status: 429 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("h.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "h.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 401 (auth/expired-token): optimistic grant is preserved (NOT a reservation conflict)", async () => {
		// Regression: pre-fix, ANY 4xx (except 408/429) was treated as a
		// reservation denial and rolled back the local grant. 401/403/404 say
		// nothing about whether another agent holds the file — they're
		// auth/config errors. They must fail open.
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("expired token", { status: 401 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("auth.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "auth.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 403 (forbidden): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("forbidden", { status: 403 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("forbidden.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "forbidden.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 404 (wrong server URL / endpoint missing): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("not found", { status: 404 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("nf.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "nf.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 423 (Locked): rolls back — explicit reservation denial", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("locked", { status: 423 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("locked.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "locked.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});

	it("server-rejected with normalized path (`./a.ts` vs `a.ts`): rolls back", async () => {
		// Pre-fix: the classifier compared conflicts[].file === filePath with
		// raw equality. A server that normalized paths (./a.ts vs a.ts, abs
		// vs rel) would slip past the rejection check, leaving the optimistic
		// grant in place — recreating the double-allocation bug.
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(
				JSON.stringify({
					result: {
						granted: [],
						conflicts: [
							{ file: "./a.ts", reserved_by: "other-agent" }, // note the leading ./
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("a.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});
});
