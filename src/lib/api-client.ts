// ===========================================
// API Client — HTTP client for /api/ui/call
// ===========================================
// Uses Bearer token auth with the Interlinked MCP Server UI proxy endpoint.
// Returns parsed tool results (already unwrapped from JSON-RPC).

import { resolveAuthToken, resolveAuthTokenWithRefresh } from "./auth.js";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import type { JsonObject } from "./json-types.js";

/** Timeout for the /health reachability ping, in milliseconds. */
const HEALTH_PING_TIMEOUT_MS = 5000;

export class InterlinkedClient {
	private serverUrl: string;
	private workspaceId?: string;
	private token: string | null;
	private readonly usesExplicitToken: boolean;

	constructor(options?: { serverUrl?: string; workspaceId?: string; token?: string }) {
		const config = resolveConfig();
		this.serverUrl = options?.serverUrl || config.server_url;
		this.workspaceId = options?.workspaceId || config.workspace_id;
		this.usesExplicitToken = Boolean(options?.token);
		this.token = options?.token || resolveAuthToken() || null;
	}

	private async ensureToken(): Promise<void> {
		if (this.usesExplicitToken) {
			return;
		}
		this.token = await resolveAuthTokenWithRefresh(this.serverUrl);
	}

	/**
	 * Get the resolved config for display purposes.
	 */
	getConfig(): ResolvedConfig {
		return resolveConfig();
	}

	/**
	 * Check if the client has authentication credentials.
	 */
	isAuthenticated(): boolean {
		return this.token !== null;
	}

	/**
	 * Local dev servers bypass OAuth and accept unauthenticated requests.
	 */
	isLocalDevServer(): boolean {
		return this.serverUrl.includes("localhost") || this.serverUrl.includes("127.0.0.1");
	}

	/**
	 * Call an MCP tool via the /api/ui/call proxy.
	 * Returns the parsed tool result (already unwrapped from JSON-RPC).
	 * Throws on errors.
	 */
	async callTool<T = unknown>(name: string, args: JsonObject = {}): Promise<T> {
		await this.ensureToken();
		const isLocalDev = this.isLocalDevServer();

		if (!this.token && !isLocalDev) {
			throw new Error(
				"Not authenticated. Run 'interlinked login' to authenticate, or ensure Claude Code has a valid Interlinked MCP Server connection.",
			);
		}

		// Keep CLI wrappers resilient across server versions by always supplying
		// the default MCP workspace/project context unless explicitly overridden.
		const resolvedConfig = this.getConfig();
		const defaultWorkspaceKey = resolvedConfig.default_workspace_key || "main";
		const defaultProject = resolvedConfig.default_project || "main";
		const normalizedArgs: JsonObject = {
			workspace_key: defaultWorkspaceKey,
			project_key: defaultProject,
			...args,
		};

		const body: JsonObject = { tool: name, args: normalizedArgs };
		if (this.workspaceId) {
			body.workspace = this.workspaceId;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		// Only send Bearer auth for real tokens (not dev-mode placeholders)
		// In dev mode (localhost), the server provides a session fallback
		if (this.token && !isLocalDev) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		const res = await fetch(`${this.serverUrl}/api/ui/call`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (res.status === 401) {
			throw new Error(
				"Authentication failed. Your token may have expired. Run 'interlinked login' to re-authenticate.",
			);
		}

		const result = await res.json();

		if (!res.ok) {
			const errMsg =
				typeof result === "object" && result !== null
					? (result as { error?: { message?: string }; message?: string }).error
							?.message ||
						(result as { message?: string }).message ||
						JSON.stringify(result)
					: String(result);
			throw new Error(`API error (${res.status}): ${errMsg}`);
		}

		return result as T;
	}

	/**
	 * Fetch workspaces directly from the registry endpoint.
	 * Unlike callTool, this doesn't require a workspace to be selected.
	 */
	async fetchWorkspaces(): Promise<
		Array<{ id: string; name: string; role?: string; display_name?: string }>
	> {
		await this.ensureToken();
		const isLocalDev = this.isLocalDevServer();

		if (!this.token && !isLocalDev) {
			throw new Error("Not authenticated. Run 'interlinked login' to authenticate.");
		}

		const headers: Record<string, string> = {};
		if (this.token && !isLocalDev) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		const res = await fetch(`${this.serverUrl}/api/workspaces`, {
			method: "GET",
			headers,
		});

		if (res.status === 401) {
			throw new Error("Authentication failed. Run 'interlinked login' to re-authenticate.");
		}

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`API error (${res.status}): ${text}`);
		}

		const data = (await res.json()) as {
			workspaces?: Array<{ id: string; name: string; role?: string; display_name?: string }>;
		};
		return data.workspaces || [];
	}

	/**
	 * Call multiple tools in sequence, collecting results.
	 */
	async callTools(calls: Array<{ name: string; args?: JsonObject }>): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const call of calls) {
			results.push(await this.callTool(call.name, call.args || {}));
		}
		return results;
	}

	/**
	 * Post a hook event (activity or lifecycle).
	 */
	async postHookEvent(
		event: {
			agent_name: string;
			event_type: string;
			tool_name?: string;
			tool_input_summary?: string;
		},
		type: "activity" | "lifecycle" = "activity",
	): Promise<void> {
		await this.ensureToken();
		const isLocalDev = this.isLocalDevServer();
		if (!this.token && !isLocalDev) return;
		const resolvedConfig = this.getConfig();
		const payload: JsonObject = {
			workspace_key: resolvedConfig.default_workspace_key || "main",
			project_key: resolvedConfig.default_project || "main",
			...event,
		};

		const endpoint = type === "lifecycle" ? "/api/hooks/lifecycle" : "/api/hooks/activity";

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.token && !isLocalDev) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		await fetch(`${this.serverUrl}${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		}).catch(() => {
			// Swallow — hook events are fire-and-forget
		});
	}

	/**
	 * Health check: verify Interlinked MCP Server reachability and auth validity.
	 */
	async healthCheck(): Promise<{
		serverReachable: boolean;
		authenticated: boolean;
		serverVersion?: string;
		error?: string;
	}> {
		try {
			await this.ensureToken();
			const isLocalDev = this.isLocalDevServer();

			// First check server reachability
			const pingRes = await fetch(`${this.serverUrl}/health`, {
				signal: AbortSignal.timeout(HEALTH_PING_TIMEOUT_MS),
			}).catch(() => null);

			if (!pingRes?.ok) {
				return {
					serverReachable: false,
					authenticated: false,
					error: "Interlinked MCP Server unreachable",
				};
			}

			// In localhost dev mode, auth may be intentionally omitted.
			// Validate MCP availability directly instead of requiring a token.
			if (!this.token && isLocalDev) {
				const result = await this.callTool("health_check");
				return {
					serverReachable: true,
					authenticated: true,
					serverVersion:
						typeof result === "object" && result !== null
							? (result as { version?: string }).version
							: undefined,
				};
			}

			// Then check auth (remote mode)
			if (!this.token) {
				return { serverReachable: true, authenticated: false, error: "No auth token" };
			}

			const result = await this.callTool("health_check");
			return {
				serverReachable: true,
				authenticated: true,
				serverVersion:
					typeof result === "object" && result !== null
						? (result as { version?: string }).version
						: undefined,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("Authentication failed")) {
				return {
					serverReachable: true,
					authenticated: false,
					error: "Token invalid or expired",
				};
			}
			return { serverReachable: false, authenticated: false, error: msg };
		}
	}
}

/**
 * Create a shared client instance for use across commands.
 */
let _sharedClient: InterlinkedClient | null = null;

export function getClient(options?: {
	serverUrl?: string;
	workspaceId?: string;
	token?: string;
}): InterlinkedClient {
	if (options) {
		return new InterlinkedClient(options);
	}
	if (!_sharedClient) {
		_sharedClient = new InterlinkedClient();
	}
	return _sharedClient;
}
