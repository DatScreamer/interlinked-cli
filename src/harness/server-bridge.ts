// ===========================================
// Server Bridge — Sync harness state with Interlinked MCP Server
// ===========================================
// Manages:
// - Reservation cache refresh from server
// - Guard event reporting to server
// - Server presence detection
// - Team rule sync

import type { JsonObject } from "../lib/json-types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinationResponse } from "./auto-coordinate.js";
import type { ServerApiClient, ServerReservation } from "./reservations.js";
import type { SessionTrajectory } from "./types.js";

// ===========================================
// Types
// ===========================================

interface ServerBridgeConfig {
	serverUrl: string;
	authToken?: string;
	workspaceId?: string;
	workspaceKey?: string;
	projectKey?: string;
	/** How often to refresh reservation cache (ms, default: 30s) */
	refreshIntervalMs?: number;
}

interface GuardEventReport {
	agent_name: string;
	event_type: "guard_block" | "guard_warn" | "guard_alert";
	rule_id?: string;
	tool_name?: string;
	tool_input_summary?: string;
	decision: "block" | "warn";
	reason: string;
	occurred_at: string;
}

// ===========================================
// Server Bridge
// ===========================================

export class ServerBridge implements ServerApiClient {
	private config: ServerBridgeConfig;
	private connected = false;
	private guardEventQueue: GuardEventReport[] = [];
	private flushInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: ServerBridgeConfig) {
		this.config = config;

		// Flush guard events every 10 seconds
		this.flushInterval = setInterval(() => {
			this.flushGuardEvents().catch(() => {});
		}, 10_000);

		// Initial health check
		this.healthCheck().catch(() => {});
	}

	// ===========================================
	// Health Check
	// ===========================================

	async healthCheck(): Promise<boolean> {
		try {
			const res = await fetchWithTimeout(`${this.config.serverUrl}/health`, {
				timeout: 3000,
			});
			this.connected = res.ok;
			return this.connected;
		} catch {
			this.connected = false;
			return false;
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	// ===========================================
	// File Reservations (implements ServerApiClient)
	// ===========================================

	async reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void> {
		try {
			await this.callTool("file_reservation_paths", {
				agent_name: agentName,
				paths: [filePath],
				ttl_seconds: ttlSeconds,
				workspace_key: this.config.workspaceKey || "main",
				project_key: this.config.projectKey || "main",
			});
		} catch (e) {
			void e;
		}
	}

	async releaseFile(filePath: string, agentName: string): Promise<void> {
		try {
			await this.callTool("release_file_reservations", {
				agent_name: agentName,
				paths: [filePath],
				workspace_key: this.config.workspaceKey || "main",
				project_key: this.config.projectKey || "main",
			});
		} catch (e) {
			void e;
		}
	}

	async listReservations(): Promise<ServerReservation[]> {
		try {
			const result = await this.callTool("list_file_reservations", {
				brief: true,
				workspace_key: this.config.workspaceKey || "main",
				project_key: this.config.projectKey || "main",
			});
			const reservations = result?.reservations;
			if (!Array.isArray(reservations)) return [];
			return reservations.map((r: JsonObject) => ({
				agent_name: r.agent_name as string,
				path_pattern: r.path_pattern as string,
				expires_at: r.expires_at as string | undefined,
			}));
		} catch {
			return [];
		}
	}

	// ===========================================
	// Guard Event Reporting
	// ===========================================

	/** Queue a guard event for batch reporting to the server */
	reportGuardEvent(event: GuardEventReport): void {
		this.guardEventQueue.push(event);

		// If queue is large, flush immediately
		if (this.guardEventQueue.length >= 10) {
			this.flushGuardEvents().catch(() => {});
		}
	}

	/** Flush queued guard events to the server */
	private async flushGuardEvents(): Promise<void> {
		if (this.guardEventQueue.length === 0 || !this.connected) return;

		const events = [...this.guardEventQueue];
		this.guardEventQueue = [];

		// Report as activity events with guard-specific fields
		try {
			const batchPayload = {
				events: events.map((e) => ({
					agent_name: e.agent_name,
					event_type: e.event_type,
					tool_name: e.tool_name,
					tool_input_summary: e.tool_input_summary,
					occurred_at: e.occurred_at,
					workspace_key: this.config.workspaceKey || "main",
					project_key: this.config.projectKey || "main",
					// Store guard decision details in error_message field
					error_message: `[${e.decision}] ${e.reason}`.slice(0, 500),
					hook_event: e.event_type,
					source: "harness",
				})),
			};

			await fetchWithTimeout(`${this.config.serverUrl}/api/hooks/activity/batch`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.config.authToken
						? { Authorization: `Bearer ${this.config.authToken}` }
						: {}),
					"X-Interlinked-Harness-Version": "1.0.0",
				},
				body: JSON.stringify(batchPayload),
				timeout: 5000,
			});
		} catch {
			// Re-queue events on failure (up to a limit)
			if (events.length <= 50) {
				this.guardEventQueue.unshift(...events);
			}
		}
	}

	// ===========================================
	// MCP Tool Proxy (via /api/ui/call)
	// ===========================================

	private async callTool(toolName: string, args: JsonObject): Promise<JsonObject> {
		const res = await fetchWithTimeout(`${this.config.serverUrl}/api/ui/call`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.config.authToken
					? { Authorization: `Bearer ${this.config.authToken}` }
					: {}),
			},
			body: JSON.stringify({
				tool: toolName,
				args,
				// Route to the correct workspace DO
				...(this.config.workspaceId ? { workspace_id: this.config.workspaceId } : {}),
			}),
			timeout: 5000,
		});

		if (!res.ok) {
			throw new Error(`Server API error: ${res.status}`);
		}

		const data = (await res.json()) as JsonObject;
		// Handle JSON-RPC response format
		if (data.result) return data.result as JsonObject;
		if (data.error) throw new Error(String((data.error as JsonObject).message || data.error));
		return data;
	}

	// ===========================================
	// Auto-Coordination
	// ===========================================

	/**
	 * Fetch coordination state from the MCP server.
	 * Returns null on any failure (fail-open — always).
	 */
	async fetchCoordinationState(
		agentName: string,
		session: SessionTrajectory,
		timeoutMs?: number,
	): Promise<CoordinationResponse | null> {
		if (!this.connected) return null;

		try {
			const response = await fetchWithTimeout(
				`${this.config.serverUrl}/api/auto-coordinate`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(this.config.authToken
							? { Authorization: `Bearer ${this.config.authToken}` }
							: {}),
					},
					body: JSON.stringify({
						agent_name: agentName,
						workspace_key: this.config.workspaceKey,
						project_key: this.config.projectKey,
						tool_call_count: session.tool_call_count,
						session_started_at: session.started_at,
					}),
					timeout: timeoutMs ?? 2000,
				},
			);

			if (!response.ok) return null;
			return (await response.json()) as CoordinationResponse;
		} catch {
			return null; // Fail open — always
		}
	}

	// ===========================================
	// Cleanup
	// ===========================================

	shutdown(): void {
		if (this.flushInterval) {
			clearInterval(this.flushInterval);
			this.flushInterval = null;
		}
		// Final flush attempt
		this.flushGuardEvents().catch(() => {});
	}
}

// ===========================================
// Fetch with Timeout Helper
// ===========================================

async function fetchWithTimeout(
	url: string,
	options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
	const { timeout = 5000, ...fetchOptions } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const res = await fetch(url, {
			...fetchOptions,
			signal: controller.signal,
		});
		return res;
	} finally {
		clearTimeout(timer);
	}
}

// ===========================================
// Factory
// ===========================================

/**
 * Create a ServerBridge from CLI config.
 * Returns null if no server URL is configured.
 */
export function createServerBridge(cwd: string = process.cwd()): ServerBridge | null {
	try {
		const configDir = join(cwd, ".interlinked");
		const sharedPath = join(configDir, "config.json");
		const localPath = join(configDir, "config.local.json");

		let serverUrl: string | undefined;
		let authToken: string | undefined;
		let workspaceId: string | undefined;
		let workspaceKey: string | undefined;
		let projectKey: string | undefined;

		if (existsSync(sharedPath)) {
			try {
				const shared = JSON.parse(readFileSync(sharedPath, "utf-8"));
				serverUrl = shared.server_url;
				workspaceKey = shared.default_workspace_key;
				projectKey = shared.default_project;
			} catch (e) {
				void e;
			}
		}

		if (existsSync(localPath)) {
			try {
				const local = JSON.parse(readFileSync(localPath, "utf-8"));
				authToken = local.access_token;
				workspaceId = local.workspace_id;

				// Multi-server support
				const activeKey = local.active_server || "production";
				const activeServer = local.servers?.[activeKey];
				if (activeServer?.server_url) {
					serverUrl = activeServer.server_url;
					workspaceId = activeServer.workspace_id || workspaceId;
				}
			} catch (e) {
				void e;
			}
		}

		if (!serverUrl) return null;

		return new ServerBridge({
			serverUrl,
			authToken,
			workspaceId,
			workspaceKey: workspaceKey || "main",
			projectKey: projectKey || "main",
		});
	} catch {
		return null;
	}
}
