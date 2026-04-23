// ===========================================
// Two-Tier Config Management
// ===========================================
// config.json — committed, team-shared settings
// config.local.json — gitignored, personal (tokens, agent handles)
// Legacy migration from .claude/interlinked-session.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ===========================================
// Types
// ===========================================

interface SharedConfig {
	version: 1;
	server_url: string;
	default_workspace_key?: string;
	default_project?: string;
	/** Custom PII patterns for verify detection. */
	pii_patterns?: Array<{ name: string; pattern: string; severity?: string }>;
	/** Opt-in built-in PII patterns (e.g., "email", "phone_us", "ip_address"). */
	pii_opt_in?: string[];
}

export interface ServerEntry {
	server_url: string;
	mcp_prefix?: string;
	workspace_id?: string;
}

export interface LocalConfig {
	agent_name?: string;
	mcp_prefix?: string;
	workspace_id?: string;
	access_token?: string;
	refresh_token?: string;
	token_expires_at?: string;
	oauth_client_id?: string;
	agent_handle?: string;
	/** Key into `servers` map. Defaults to "production". */
	active_server?: string;
	servers?: Record<string, ServerEntry>;
	/** Sync mode: "realtime" (default), "local", or "manual". */
	sync_mode?: "realtime" | "local" | "manual";
	/** Override data directory (activity.jsonl, sessions/, sync-state.json). */
	data_dir?: string;
	/** Checkpoint configuration. */
	checkpoints?: {
		auto_archive_count?: number;
		auto_archive_days?: number;
		auto_checkpoint_on?: string[];
	};
	/** Guard mode for file reservation enforcement: "warn" (default), "block", or "off". */
	guard_mode?: "warn" | "block" | "off";
}

export interface ResolvedConfig {
	server_url: string;
	workspace_id?: string;
	default_workspace_key?: string;
	agent_name?: string;
	mcp_prefix?: string;
	access_token?: string;
	refresh_token?: string;
	token_expires_at?: string;
	oauth_client_id?: string;
	agent_handle?: string;
	default_project?: string;
	sync_mode: string;
}

// Legacy format from .claude/interlinked-session.json
interface LegacySession {
	server_url: string;
	workspace_uuid?: string;
	agent_name?: string;
	agent_handle?: string;
	mcp_prefix?: string;
	installed_at?: string;
	clients?: string[];
	default_server?: string;
	servers?: Record<
		string,
		{
			server_url: string;
			agent_name?: string;
			mcp_prefix?: string;
			workspace_uuid?: string;
		}
	>;
}

// Default to localhost — public distribution has no production server to
// point at. Users configure their own remote via `interlinked enable
// --server <url>` or the `INTERLINKED_SERVER_URL` env var.
const DEFAULT_SERVER = "http://localhost:8787";
const CONFIG_DIR = ".interlinked";
const SHARED_CONFIG = "config.json";
const LOCAL_CONFIG = "config.local.json";
const LEGACY_CONFIG_PATH = ".claude/interlinked-session.json";

// ===========================================
// Path Helpers
// ===========================================

/**
 * Get the config directory (.interlinked/).
 * Resolution: INTERLINKED_HOME env > {cwd}/.interlinked/
 */
export function getConfigDir(cwd: string = process.cwd()): string {
	const envHome = process.env.INTERLINKED_HOME?.trim();
	if (envHome) return envHome;
	return join(cwd, CONFIG_DIR);
}

/**
 * Get the data directory for activity logs, sessions, and sync state.
 * Resolution: INTERLINKED_DATA_DIR env > LocalConfig.data_dir > INTERLINKED_HOME env > {cwd}/.interlinked/
 */
export function getDataDir(cwd: string = process.cwd()): string {
	const envDataDir = process.env.INTERLINKED_DATA_DIR?.trim();
	if (envDataDir) return envDataDir;

	// Check local config for data_dir (read directly to avoid circular dependency with resolveConfig)
	const localConfigPath = getLocalConfigPath(cwd);
	if (existsSync(localConfigPath)) {
		try {
			const local = JSON.parse(readFileSync(localConfigPath, "utf-8")) as LocalConfig;
			if (local.data_dir) return local.data_dir;
		} catch (_err) {
			/* intentional: corrupt local config — fall through to default data dir */
		}
	}

	return getConfigDir(cwd);
}

/**
 * Get the hooks directory for generated hook scripts.
 */
export function getHooksDir(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "hooks");
}

export function getSharedConfigPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), SHARED_CONFIG);
}

export function getLocalConfigPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), LOCAL_CONFIG);
}

function getLegacyConfigPath(cwd: string = process.cwd()): string {
	return join(cwd, LEGACY_CONFIG_PATH);
}

// ===========================================
// Read/Write Helpers
// ===========================================

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch (_err) {
		/* intentional: malformed JSON config — treat as "no config" so callers can fall back */
		return null;
	}
}

function writeJson(path: string, data: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(data, null, 4)}\n`);
}

// ===========================================
// Config Operations
// ===========================================

export function readSharedConfig(cwd?: string): SharedConfig | null {
	return readJson<SharedConfig>(getSharedConfigPath(cwd));
}

export function readLocalConfig(cwd?: string): LocalConfig | null {
	return readJson<LocalConfig>(getLocalConfigPath(cwd));
}

export function writeSharedConfig(config: SharedConfig, cwd?: string): void {
	writeJson(getSharedConfigPath(cwd), config);
}

function writeLocalConfig(config: LocalConfig, cwd?: string): void {
	writeJson(getLocalConfigPath(cwd), config);
}

function readLegacyConfig(cwd?: string): LegacySession | null {
	return readJson<LegacySession>(getLegacyConfigPath(cwd));
}

/**
 * Check if config directory exists and has been initialized.
 */
export function isConfigured(cwd?: string): boolean {
	return existsSync(getSharedConfigPath(cwd));
}

/**
 * Check if a legacy .claude/interlinked-session.json exists.
 */
export function hasLegacyConfig(cwd?: string): boolean {
	return existsSync(getLegacyConfigPath(cwd));
}

/**
 * Resolve full config by merging shared + local, with defaults.
 * Uses `active_server` (default "production") to pick the right server entry,
 * ensuring server_url, workspace_id, and mcp_prefix are always paired.
 */
export function resolveConfig(cwd?: string): ResolvedConfig {
	const shared = readSharedConfig(cwd);
	const local = readLocalConfig(cwd);

	const envServerUrl = process.env.INTERLINKED_SERVER_URL?.trim();
	const envWorkspaceId = process.env.INTERLINKED_WORKSPACE_ID?.trim();
	const envMcpPrefix = process.env.INTERLINKED_MCP_PREFIX?.trim();
	const envAgentName =
		process.env.INTERLINKED_AGENT_NAME?.trim() || process.env.INTERLINKED_AGENT?.trim();
	const envAccessToken =
		process.env.INTERLINKED_ACCESS_TOKEN?.trim() || process.env.INTERLINKED_TOKEN?.trim();
	const envSyncMode = process.env.INTERLINKED_SYNC_MODE?.trim().toLowerCase();

	// Resolve active server entry — all URL/workspace/prefix come from the same source
	const activeKey = local?.active_server || "production";
	const configuredActiveServer = local?.servers?.[activeKey];
	const envMatchedServer = envServerUrl
		? Object.values(local?.servers || {}).find((s) => s.server_url === envServerUrl)
		: undefined;
	const activeServer = envServerUrl ? envMatchedServer : configuredActiveServer;

	let resolvedSyncMode = local?.sync_mode || "realtime";
	if (envSyncMode === "local" || envSyncMode === "manual" || envSyncMode === "realtime") {
		resolvedSyncMode = envSyncMode;
	}

	return {
		server_url:
			envServerUrl || activeServer?.server_url || shared?.server_url || DEFAULT_SERVER,
		workspace_id: envWorkspaceId || activeServer?.workspace_id || local?.workspace_id,
		mcp_prefix: envMcpPrefix || activeServer?.mcp_prefix || local?.mcp_prefix,
		agent_name: envAgentName || local?.agent_name,
		access_token: envAccessToken || local?.access_token,
		refresh_token: local?.refresh_token,
		token_expires_at: local?.token_expires_at,
		oauth_client_id: local?.oauth_client_id,
		agent_handle: local?.agent_handle,
		default_workspace_key: shared?.default_workspace_key,
		default_project: shared?.default_project,
		sync_mode: resolvedSyncMode,
	};
}

/**
 * Get the active server key from local config.
 * Returns "production" if not explicitly set.
 */
export function getActiveServerKey(cwd?: string): string {
	const local = readLocalConfig(cwd);
	return local?.active_server || "production";
}

/**
 * Update a subset of the local config (merge, not replace).
 */
export function updateLocalConfig(updates: Partial<LocalConfig>, cwd?: string): void {
	const existing = readLocalConfig(cwd) || {};
	let mergedServers = existing.servers;
	if (updates.servers) {
		mergedServers = { ...(existing.servers || {}) };
		for (const [serverKey, serverEntry] of Object.entries(updates.servers)) {
			mergedServers[serverKey] = {
				...(mergedServers[serverKey] || {}),
				...serverEntry,
			};
		}
	}
	writeLocalConfig(
		{
			...existing,
			...updates,
			...(mergedServers ? { servers: mergedServers } : {}),
		},
		cwd,
	);
}

/**
 * Migrate legacy .claude/interlinked-session.json to .interlinked/ format.
 * Returns true if migration was performed.
 */
export function migrateLegacyConfig(cwd?: string): boolean {
	const legacy = readLegacyConfig(cwd);
	if (!legacy) return false;

	// Create shared config
	const shared: SharedConfig = {
		version: 1,
		server_url: legacy.server_url || DEFAULT_SERVER,
	};

	// Merge into existing local config (preserve active_server and other fields)
	const existing = readLocalConfig(cwd) || {};
	const local: LocalConfig = {
		...existing,
		agent_name: legacy.agent_name || existing.agent_name,
		mcp_prefix: legacy.mcp_prefix || existing.mcp_prefix,
		workspace_id: legacy.workspace_uuid || existing.workspace_id,
		agent_handle: legacy.agent_handle || existing.agent_handle,
	};

	// Migrate multi-server config if present
	if (legacy.servers) {
		local.servers = { ...existing.servers };
		for (const [name, entry] of Object.entries(legacy.servers)) {
			local.servers[name] = {
				...local.servers[name],
				server_url: entry.server_url,
				mcp_prefix: entry.mcp_prefix,
				workspace_id: entry.workspace_uuid,
			};
		}
	}

	writeSharedConfig(shared, cwd);
	writeLocalConfig(local, cwd);
	return true;
}

/**
 * Initialize a fresh config with sensible defaults.
 */
export function initConfig(
	options: { serverUrl?: string; agentName?: string; mcpPrefix?: string },
	cwd?: string,
): void {
	const existingShared = readSharedConfig(cwd);
	const existingLocal = readLocalConfig(cwd) || {};

	const shared: SharedConfig = {
		version: 1,
		server_url: options.serverUrl || existingShared?.server_url || DEFAULT_SERVER,
		...(existingShared?.default_workspace_key
			? { default_workspace_key: existingShared.default_workspace_key }
			: {}),
		...(existingShared?.default_project
			? { default_project: existingShared.default_project }
			: {}),
	};
	writeSharedConfig(shared, cwd);

	if (options.agentName || options.mcpPrefix) {
		const local: LocalConfig = { ...existingLocal };
		if (options.agentName) local.agent_name = options.agentName;
		if (options.mcpPrefix) local.mcp_prefix = options.mcpPrefix;
		writeLocalConfig(local, cwd);
	}
}
