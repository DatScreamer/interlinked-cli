// ===========================================
// Reservation Manager — Auto file reservation via harness
// ===========================================
// On PreToolUse file writes: check local cache, optimistically reserve, confirm with remote server async.
// On PostToolUse: start 30s auto-release timer. On session end: release all agent reservations.

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

export class ReservationManager {
	private cache: Map<string, ReservationEntry> = new Map();
	private releaseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private apiClient: ServerApiClient | null;
	private refreshInterval: ReturnType<typeof setInterval> | null = null;

	constructor(apiClient?: ServerApiClient, refreshMs = 30_000) {
		this.apiClient = apiClient || null;

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
	 * If no conflict, optimistically reserves it.
	 * Returns null if allowed, or a conflict descriptor if blocked.
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
				// Check if expired
				if (entry.expires_at && new Date(entry.expires_at).getTime() < Date.now()) {
					this.cache.delete(pattern);
					continue;
				}
				const isLocal = cohort.hasAgent(entry.agent_name);
				return {
					agent_name: entry.agent_name,
					cohort: isLocal ? "local" : "remote",
					expires_at: entry.expires_at,
				};
			}
		}

		// No conflict — optimistically reserve locally
		const now = new Date();
		const expires = new Date(now.getTime() + RESERVATION_TTL_S * 1000);

		this.cache.set(filePath, {
			file_pattern: filePath,
			agent_name: agentName,
			cohort: "local",
			reserved_at: now.toISOString(),
			expires_at: expires.toISOString(),
		});

		// Track in cohort
		cohort.addFileReservation(agentName, filePath);

		// Confirm with server asynchronously (don't block)
		if (this.apiClient) {
			this.apiClient.reserveFile(filePath, agentName, RESERVATION_TTL_S).catch(() => {
				// Server unreachable — local reservation still holds
			});
		}

		return null;
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

		this.cache.delete(filePath);
		cohort.removeFileReservation(agentName, filePath);

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
	}

	/** Get all active reservations */
	getAll(): ReservationEntry[] {
		// Prune expired entries
		const now = Date.now();
		for (const [path, entry] of this.cache) {
			if (entry.expires_at && new Date(entry.expires_at).getTime() < now) {
				this.cache.delete(path);
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
			// (e.g., another agent released a file before TTL expired)
			for (const [path, entry] of this.cache) {
				if (entry.cohort === "remote" && !serverPaths.has(path)) {
					this.cache.delete(path);
				}
			}

			// Upsert server reservations (server is authoritative for remote agents)
			for (const sr of serverReservations) {
				const existing = this.cache.get(sr.path_pattern);
				// Only update if this is a remote reservation or we don't have it locally
				if (!existing || existing.cohort === "remote") {
					this.cache.set(sr.path_pattern, {
						file_pattern: sr.path_pattern,
						agent_name: sr.agent_name,
						cohort: "remote", // Assume remote until proven local
						reserved_at: new Date().toISOString(),
						expires_at:
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
