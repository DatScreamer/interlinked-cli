// ===========================================
// interlinked context — Show effective configuration
// ===========================================
// Displays the merged config from all sources (shared, local, env vars)
// so users can see exactly what the CLI will use.

import { existsSync, readFileSync } from "node:fs";
import { resolveAuthToken } from "../lib/auth.js";
import {
	getActiveServerKey,
	getConfigDir,
	getDataDir,
	isConfigured,
	readLocalConfig,
	readSharedConfig,
	resolveConfig,
} from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getHookScriptPath, HOOK_SCRIPT_VERSION } from "../lib/hooks.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { detectClients } from "../lib/settings.js";

interface ContextOptions {
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function detectInstalledHookVersion(cwd: string): string | null {
	const hookPath = getHookScriptPath(cwd);
	if (!existsSync(hookPath)) return null;
	try {
		const content = readFileSync(hookPath, "utf-8");
		// Capture the FULL sentinel including any `+mode-<name>` suffix
		// baked by `writeHookScript`. The previous `[\d.]+` form silently
		// dropped the mode qualifier, making `0.1.0+mode-budget` look the
		// same as `0.1.0+mode-ci`.
		const match = content.match(/interlinked-hook-version:\s*(\S+)/);
		return match ? nonNull(match[1]) : "unknown";
	} catch {
		return null;
	}
}

export async function contextCommand(options: ContextOptions): Promise<void> {
	const cwd = process.cwd();
	const mode = getOutputMode(options);

	if (!isConfigured(cwd)) {
		outputError(mode, "Not configured. Run: interlinked enable");
		return;
	}

	const config = resolveConfig(cwd);
	const _shared = readSharedConfig(cwd);
	const _local = readLocalConfig(cwd);
	const activeServer = getActiveServerKey(cwd);
	const clients = detectClients(cwd);
	const installedClients = clients.filter((c) => c.exists);
	const hookVersion = detectInstalledHookVersion(cwd);
	const isLocalServer =
		config.server_url.includes("localhost") || config.server_url.includes("127.0.0.1");

	// Auth status
	const token = resolveAuthToken();
	const hasToken = !!token;
	const tokenSource = config.access_token
		? "config.local.json"
		: hasToken
			? "Claude Code credentials"
			: "none";

	// Env var overrides
	const envOverrides: string[] = [];
	if (process.env.INTERLINKED_SERVER_URL) envOverrides.push("INTERLINKED_SERVER_URL");
	if (process.env.INTERLINKED_ACCESS_TOKEN || process.env.INTERLINKED_TOKEN)
		envOverrides.push("INTERLINKED_ACCESS_TOKEN");
	if (process.env.INTERLINKED_AGENT_NAME || process.env.INTERLINKED_AGENT)
		envOverrides.push("INTERLINKED_AGENT_NAME");
	if (process.env.INTERLINKED_WORKSPACE_ID) envOverrides.push("INTERLINKED_WORKSPACE_ID");
	if (process.env.INTERLINKED_SYNC_MODE) envOverrides.push("INTERLINKED_SYNC_MODE");
	if (process.env.INTERLINKED_DATA_DIR) envOverrides.push("INTERLINKED_DATA_DIR");
	if (process.env.INTERLINKED_HOME) envOverrides.push("INTERLINKED_HOME");

	const data = {
		server_url: config.server_url,
		is_local: isLocalServer,
		workspace_id: config.workspace_id || null,
		workspace_key: config.default_workspace_key || "main",
		project_key: config.default_project || "main",
		agent_name: config.agent_name || null,
		agent_handle: config.agent_handle ? `${config.agent_handle.substring(0, 12)}...` : null,
		sync_mode: config.sync_mode,
		active_server: activeServer,
		auth: {
			has_token: hasToken,
			token_source: tokenSource,
			expires_at: config.token_expires_at || null,
		},
		hooks: {
			installed_version: hookVersion,
			current_version: HOOK_SCRIPT_VERSION,
			stale: hookVersion !== null && hookVersion !== HOOK_SCRIPT_VERSION,
		},
		clients: {
			detected: installedClients.map((c) => c.name),
			all: clients.map((c) => ({ name: c.name, installed: c.exists })),
		},
		paths: {
			config_dir: getConfigDir(cwd),
			data_dir: getDataDir(cwd),
		},
		env_overrides: envOverrides,
	};

	output(mode, data, {
		json: () => data,
		short: () => {
			const parts = [
				config.server_url,
				config.agent_name || "no-agent",
				hasToken ? "auth:ok" : "auth:none",
				`sync:${config.sync_mode}`,
			];
			if (data.hooks.stale) parts.push("hooks:STALE");
			return parts.join(" | ");
		},
		normal: () => {
			const lines: string[] = [];

			lines.push(c.bold("Interlinked CLI — Effective Context"));
			lines.push(c.dim("─".repeat(40)));

			lines.push(header("Server"));
			lines.push(kvLine("URL", config.server_url));
			lines.push(kvLine("Type", isLocalServer ? c.cyan("local") : c.green("production")));
			lines.push(kvLine("Active server key", activeServer));

			lines.push(header("Identity"));
			lines.push(
				kvLine(
					"Agent name",
					config.agent_name ||
						c.yellow("not set (run: interlinked attach --agent <name>)"),
				),
			);
			if (config.agent_handle) {
				lines.push(kvLine("Agent handle", `${config.agent_handle.substring(0, 20)}...`));
			}
			lines.push(kvLine("Workspace ID", config.workspace_id || c.dim("not set")));
			lines.push(kvLine("Workspace key", config.default_workspace_key || "main"));
			lines.push(kvLine("Project key", config.default_project || "main"));

			lines.push(header("Authentication"));
			lines.push(
				kvLine(
					"Status",
					hasToken ? c.green("authenticated") : c.yellow("not authenticated"),
				),
			);
			lines.push(kvLine("Token source", tokenSource));
			if (config.token_expires_at) {
				const expires = new Date(config.token_expires_at);
				const isExpired = expires < new Date();
				lines.push(
					kvLine(
						"Expires",
						isExpired
							? c.red(`${config.token_expires_at} (EXPIRED)`)
							: config.token_expires_at,
					),
				);
			}

			lines.push(header("Hooks"));
			if (hookVersion) {
				const staleLabel = data.hooks.stale
					? c.yellow(` → ${HOOK_SCRIPT_VERSION} available (run: interlinked enable)`)
					: c.green(" (current)");
				lines.push(kvLine("Installed version", `${hookVersion}${staleLabel}`));
			} else {
				lines.push(kvLine("Status", c.yellow("not installed (run: interlinked enable)")));
			}

			lines.push(header("Clients"));
			for (const client of clients) {
				const status = client.exists ? c.green("detected") : c.dim("not found");
				lines.push(kvLine(`  ${client.name}`, status));
			}

			lines.push(header("Sync"));
			lines.push(kvLine("Mode", config.sync_mode));
			lines.push(kvLine("Config dir", getConfigDir(cwd)));
			lines.push(kvLine("Data dir", getDataDir(cwd)));

			if (envOverrides.length > 0) {
				lines.push(header("Environment Overrides"));
				for (const env of envOverrides) {
					lines.push(`  ${c.cyan(env)}`);
				}
			}

			return lines.join("\n");
		},
	});
}
