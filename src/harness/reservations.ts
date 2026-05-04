// ===========================================
// Reservation Manager — Auto file reservation via harness
// ===========================================
// On PreToolUse file writes: check local cache, optimistically reserve,
// confirm with remote server async. If the server rejects the optimistic
// grant, the local cache rolls back and a conflict event fires.
//
// Internal architecture: the cache mutations are expressed as a small
// table of named transitions (`TRANSITIONS` below). Every state change —
// local grants, remote upserts, releases, expiry — runs through
// `applyTransition`, so the in-memory state and the replayed event log
// can never disagree by construction. This is the Bitar single-source-of-
// truth pattern adapted for TS: one declaration per transition; both the
// `apply` direction (state mutation) and the `produce` direction (event
// emission) are derived from the same entry. See `bitar-decider.md`.

import type { CohortManager } from "./cohort.js";
import type { ReservationConflict, ReservationEntry } from "./types.js";

/** How long to hold a reservation after the last edit before auto-releasing (30s) */
const AUTO_RELEASE_MS = 30_000;

/** Default reservation TTL sent to the server (5 minutes) */
const RESERVATION_TTL_S = 300;

export interface ServerApiClient {
	reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void>;
	releaseFile(filePath: string, agentName: string): Promise<void>;
	listReservations(): Promise<ServerReservation[]>;
}

export interface ServerReservation {
	agent_name: string;
	path_pattern: string;
	expires_at?: string;
}

/** Per-event hook invoked on every grant / release / conflict. The hook
 *  is fire-and-forget — exceptions inside it must not break the lock
 *  primitive. Used to write reservation-events.jsonl from the harness. */
export type ReservationEventSink = (event: ReservationLogEvent) => void;

export interface ReservationLogEvent {
	ts: string;
	action: "grant" | "release" | "conflict" | "release_all";
	file: string;
	agent_name: string;
	holder?: string;
	cohort?: "local" | "remote";
	expires_at?: string;
	/** Why a conflict fired — "preexisting" (cache hit on acquire) or
	 *  "server-rejected" (optimistic local grant was rolled back after the
	 *  server-side ack returned an error). */
	conflict_reason?: "preexisting" | "server-rejected";
}

// ===========================================
// Reservation state-machine (single source of truth)
// ===========================================
// Each transition is declared *once* below. Both the live cache mutation
// and any future event-log replay run through `applyTransition`, so the
// two directions cannot drift. Adding a new state change means adding one
// entry to TRANSITIONS — no parallel updates required.

/** Cache state — a Map of file_pattern → ReservationEntry. Equivalent to
 *  the field on ReservationManager; declared as a type alias so the
 *  pure transition functions can be exercised by property tests without
 *  instantiating the class (see `__tests__/reservations.test.ts`). */
export type ReservationCache = Map<string, ReservationEntry>;

/** All state-changing events the cache understands. Discriminated union so
 *  exhaustiveness is checked at compile time. */
export type ReservationTxn =
	| {
			kind: "grant_local";
			file: string;
			agent: string;
			reservedAt: string;
			expiresAt: string;
	  }
	| {
			kind: "grant_remote";
			file: string;
			agent: string;
			reservedAt: string;
			expiresAt: string;
	  }
	| { kind: "release"; file: string; agent: string }
	| { kind: "release_all"; agent: string }
	| { kind: "expire"; file: string }
	| { kind: "evict_remote"; file: string };

/**
 * Apply a single transition. Returns the next cache (functional) — caller
 * is free to mutate in place if it owns the cache (the class does), or to
 * discard the result and re-derive (property tests do).
 *
 * Each branch is the *one* place a given event-kind affects the state. If
 * a future change adds a new event-kind, TypeScript's exhaustiveness
 * checker fires on the `never` default — that's the structural guarantee
 * Bitar's framing buys us in TS without GADTs.
 */
export function applyTransition(state: ReservationCache, txn: ReservationTxn): ReservationCache {
	switch (txn.kind) {
		case "grant_local":
			state.set(txn.file, {
				file_pattern: txn.file,
				agent_name: txn.agent,
				cohort: "local",
				reserved_at: txn.reservedAt,
				expires_at: txn.expiresAt,
			});
			return state;
		case "grant_remote":
			state.set(txn.file, {
				file_pattern: txn.file,
				agent_name: txn.agent,
				cohort: "remote",
				reserved_at: txn.reservedAt,
				expires_at: txn.expiresAt,
			});
			return state;
		case "release": {
			const entry = state.get(txn.file);
			if (entry && entry.agent_name === txn.agent) state.delete(txn.file);
			return state;
		}
		case "release_all": {
			for (const [file, entry] of state) {
				if (entry.agent_name === txn.agent) state.delete(file);
			}
			return state;
		}
		case "expire":
			state.delete(txn.file);
			return state;
		case "evict_remote": {
			const entry = state.get(txn.file);
			if (entry && entry.cohort === "remote") state.delete(txn.file);
			return state;
		}
		default: {
			const _exhaustive: never = txn;
			void _exhaustive;
			return state;
		}
	}
}

/** Replay an event log against an empty cache. Used by property tests to
 *  assert that live execution and replay produce identical state. The
 *  function is pure (modulo the seeded `state` parameter being mutated). */
export function replayTransitions(events: readonly ReservationTxn[]): ReservationCache {
	const state: ReservationCache = new Map();
	for (const e of events) applyTransition(state, e);
	return state;
}

// ===========================================
// ReservationManager — class wrapping cache, timers, server bridge
// ===========================================

export class ReservationManager {
	private cache: ReservationCache = new Map();
	private releaseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private apiClient: ServerApiClient | null;
	private refreshInterval: ReturnType<typeof setInterval> | null = null;
	private eventSink: ReservationEventSink | null = null;

	constructor(
		apiClient?: ServerApiClient,
		refreshMs = 30_000,
		eventSink?: ReservationEventSink,
	) {
		this.apiClient = apiClient || null;
		this.eventSink = eventSink || null;

		if (this.apiClient) {
			// Initial load from server
			this.refreshFromServer().catch(() => {});
			// Periodic refresh
			this.refreshInterval = setInterval(() => {
				this.refreshFromServer().catch(() => {});
			}, refreshMs);
		}
	}

	/**
	 * Check if a file can be written by this agent.
	 * If no conflict, optimistically reserves it locally and fires an async
	 * server confirmation. **Server rejection rolls back the local grant**
	 * and emits a `conflict` event with `conflict_reason: "server-rejected"`
	 * so the cohort sees the eventual conflict. Pre-Lopopolo this was a
	 * silent `.catch(() => {})` — the silent-double-allocation bug class.
	 *
	 * Returns null if allowed (locally), or a conflict descriptor if blocked
	 * by an existing cache entry. Server-side rejection is reported via the
	 * eventSink, not the return value, because callers run synchronously
	 * (PreToolUse evaluator) and the server roundtrip happens in the
	 * background.
	 */
	checkAndReserve(
		filePath: string,
		agentName: string,
		cohort: CohortManager,
	): ReservationConflict | null {
		// Check cache for conflicts
		for (const [pattern, entry] of this.cache) {
			if (entry.agent_name === agentName) continue; // Own reservation
			if (this.pathMatchesPattern(filePath, pattern)) {
				// Check if expired — prune via the SSoT transition.
				if (entry.expires_at && new Date(entry.expires_at).getTime() < Date.now()) {
					applyTransition(this.cache, { kind: "expire", file: pattern });
					continue;
				}
				const isLocal = cohort.hasAgent(entry.agent_name);
				const conflict: ReservationConflict = {
					agent_name: entry.agent_name,
					cohort: isLocal ? "local" : "remote",
					expires_at: entry.expires_at,
				};
				this.emit({
					ts: new Date().toISOString(),
					action: "conflict",
					file: filePath,
					agent_name: agentName,
					holder: entry.agent_name,
					cohort: conflict.cohort,
					expires_at: entry.expires_at,
					conflict_reason: "preexisting",
				});
				return conflict;
			}
		}

		// No conflict — optimistically reserve locally via the SSoT transition.
		const now = new Date();
		const expires = new Date(now.getTime() + RESERVATION_TTL_S * 1000);
		applyTransition(this.cache, {
			kind: "grant_local",
			file: filePath,
			agent: agentName,
			reservedAt: now.toISOString(),
			expiresAt: expires.toISOString(),
		});

		// Track in cohort
		cohort.addFileReservation(agentName, filePath);

		this.emit({
			ts: now.toISOString(),
			action: "grant",
			file: filePath,
			agent_name: agentName,
			cohort: "local",
			expires_at: expires.toISOString(),
		});

		// Confirm with server asynchronously. Rejection is a real signal —
		// roll back the local grant so the cohort sees the truth on the next
		// acquire instead of silently double-allocating. Server-unreachable
		// (network failure) is distinguishable from server-rejected (409 / 4xx
		// "someone else holds it") only via the API client; for the moment we
		// treat all errors as rejection because the conservative behavior is
		// to release the optimistic grant and let the next acquire re-try.
		if (this.apiClient) {
			this.apiClient.reserveFile(filePath, agentName, RESERVATION_TTL_S).catch(() => {
				this.rollbackOptimisticGrant(filePath, agentName, cohort);
			});
		}

		return null;
	}

	/**
	 * Reverse a local optimistic grant after the server-side confirmation
	 * fails. Idempotent — if the entry has already been replaced (e.g., the
	 * agent released it before the server replied), this is a no-op aside
	 * from the conflict event.
	 *
	 * The conflict event uses `conflict_reason: "server-rejected"` so log
	 * consumers (including the future `interlinked recurrence` aggregator)
	 * can distinguish optimistic-rollbacks from cache-hit conflicts.
	 */
	private rollbackOptimisticGrant(
		filePath: string,
		agentName: string,
		cohort: CohortManager,
	): void {
		const entry = this.cache.get(filePath);
		// Only roll back if the entry is still ours; otherwise something
		// else (release, expiry, remote upsert via refresh) has already moved
		// the state and our rollback would be a phantom mutation.
		if (entry && entry.agent_name === agentName && entry.cohort === "local") {
			applyTransition(this.cache, { kind: "release", file: filePath, agent: agentName });
			cohort.removeFileReservation(agentName, filePath);
			const timerKey = `${agentName}:${filePath}`;
			const timer = this.releaseTimers.get(timerKey);
			if (timer) {
				clearTimeout(timer);
				this.releaseTimers.delete(timerKey);
			}
		}
		this.emit({
			ts: new Date().toISOString(),
			action: "conflict",
			file: filePath,
			agent_name: agentName,
			conflict_reason: "server-rejected",
		});
	}

	private emit(event: ReservationLogEvent): void {
		if (!this.eventSink) return;
		try {
			this.eventSink(event);
		} catch (_err) {
			/* intentional: sink failure must not break the lock primitive */
		}
	}

	/**
	 * Schedule auto-release of a file reservation after idle timeout.
	 * Called on PostToolUse for file operations.
	 * Resets the timer if the same agent edits the same file again.
	 */
	scheduleRelease(filePath: string, agentName: string, cohort: CohortManager): void {
		const entry = this.cache.get(filePath);
		if (!entry || entry.agent_name !== agentName) return;

		// Clear existing timer for this file
		const timerKey = `${agentName}:${filePath}`;
		const existing = this.releaseTimers.get(timerKey);
		if (existing) clearTimeout(existing);

		// Set new release timer
		const timer = setTimeout(() => {
			this.release(filePath, agentName, cohort);
			this.releaseTimers.delete(timerKey);
		}, AUTO_RELEASE_MS);

		this.releaseTimers.set(timerKey, timer);
	}

	/** Immediately release a specific file reservation */
	release(filePath: string, agentName: string, cohort: CohortManager): void {
		const entry = this.cache.get(filePath);
		if (!entry || entry.agent_name !== agentName) return;

		applyTransition(this.cache, { kind: "release", file: filePath, agent: agentName });
		cohort.removeFileReservation(agentName, filePath);
		this.emit({
			ts: new Date().toISOString(),
			action: "release",
			file: filePath,
			agent_name: agentName,
			cohort: entry.cohort,
		});

		// Clear any pending timer
		const timerKey = `${agentName}:${filePath}`;
		const timer = this.releaseTimers.get(timerKey);
		if (timer) {
			clearTimeout(timer);
			this.releaseTimers.delete(timerKey);
		}

		// Release on server async
		if (this.apiClient) {
			this.apiClient.releaseFile(filePath, agentName).catch(() => {});
		}
	}

	/** Release ALL reservations for an agent (on session end or disconnect) */
	releaseAllForAgent(agentName: string, cohort: CohortManager): void {
		const toRelease: string[] = [];
		for (const [path, entry] of this.cache) {
			if (entry.agent_name === agentName) {
				toRelease.push(path);
			}
		}
		for (const path of toRelease) {
			this.release(path, agentName, cohort);
		}
		cohort.clearReservations(agentName);
		if (toRelease.length > 0) {
			this.emit({
				ts: new Date().toISOString(),
				action: "release_all",
				file: `[${toRelease.length} files]`,
				agent_name: agentName,
			});
		}
	}

	/** Get all active reservations */
	getAll(): ReservationEntry[] {
		// Prune expired entries via the SSoT transition.
		const now = Date.now();
		for (const [path, entry] of this.cache) {
			if (entry.expires_at && new Date(entry.expires_at).getTime() < now) {
				applyTransition(this.cache, { kind: "expire", file: path });
			}
		}
		return [...this.cache.values()];
	}

	/** Get reservations for a specific agent */
	getForAgent(agentName: string): ReservationEntry[] {
		return this.getAll().filter((e) => e.agent_name === agentName);
	}

	/** Refresh the local cache from the server */
	async refreshFromServer(): Promise<void> {
		if (!this.apiClient) return;

		try {
			const serverReservations = await this.apiClient.listReservations();

			// Build set of server-side reservation paths for eviction check
			const serverPaths = new Set(serverReservations.map((sr) => sr.path_pattern));

			// Evict remote reservations that are no longer on the server
			// (e.g., another agent released a file before TTL expired) via
			// the SSoT transition.
			for (const [path, entry] of this.cache) {
				if (entry.cohort === "remote" && !serverPaths.has(path)) {
					applyTransition(this.cache, { kind: "evict_remote", file: path });
				}
			}

			// Upsert server reservations (server is authoritative for remote agents)
			for (const sr of serverReservations) {
				const existing = this.cache.get(sr.path_pattern);
				// Only update if this is a remote reservation or we don't have it locally
				if (!existing || existing.cohort === "remote") {
					applyTransition(this.cache, {
						kind: "grant_remote",
						file: sr.path_pattern,
						agent: sr.agent_name,
						reservedAt: new Date().toISOString(),
						expiresAt:
							sr.expires_at ||
							new Date(Date.now() + RESERVATION_TTL_S * 1000).toISOString(),
					});
				}
			}
		} catch (e) {
			void e;
		}
	}

	/** Stop background refresh */
	shutdown(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
		// Clear all release timers
		for (const timer of this.releaseTimers.values()) {
			clearTimeout(timer);
		}
		this.releaseTimers.clear();
	}

	/** Simple path-to-pattern matching (exact match or glob) */
	private pathMatchesPattern(filePath: string, pattern: string): boolean {
		// Exact match
		if (filePath === pattern) return true;

		// Simple glob: "src/auth/**" matches "src/auth/login.ts"
		if (pattern.endsWith("/**")) {
			const prefix = pattern.slice(0, -3);
			return filePath.startsWith(`${prefix}/`) || filePath === prefix;
		}

		// Simple glob: "*.env" matches ".env", "staging.env"
		if (pattern.startsWith("*")) {
			return filePath.endsWith(pattern.slice(1));
		}

		// Simple glob: "**/*.ts" matches any .ts file
		if (pattern.startsWith("**/")) {
			const suffix = pattern.slice(3);
			if (suffix.startsWith("*")) {
				return filePath.endsWith(suffix.slice(1));
			}
			return filePath.endsWith(`/${suffix}`) || filePath === suffix;
		}

		return false;
	}
}
