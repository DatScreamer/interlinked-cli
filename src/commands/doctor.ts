// ===========================================
// interlinked doctor — Diagnose and fix issues
// ===========================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getClient } from "../lib/api-client.js";
import { resolveAuthToken } from "../lib/auth.js";
import {
	getConfigDir,
	getLocalConfigPath,
	getSharedConfigPath,
	hasLegacyConfig,
	migrateLegacyConfig,
	resolveConfig,
} from "../lib/config.js";
import { c, divider, header } from "../lib/formatter.js";
import { HOOK_SCRIPT_VERSION, writeHookScript } from "../lib/hooks.js";
import { getOutputMode, output } from "../lib/output.js";
import { runSystemChecks } from "./doctor-system.js";
import { isHarnessRunning } from "./harness.js";

type CheckStatus = "pass" | "fail" | "warn";

interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
	fixable?: boolean;
	fixAction?: string;
}

function statusIcon(status: CheckStatus): string {
	switch (status) {
		case "pass":
			return c.green("[pass]");
		case "fail":
			return c.red("[FAIL]");
		case "warn":
			return c.yellow("[warn]");
	}
}

export async function doctorCommand(opts: { fix?: boolean; json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const results: CheckResult[] = [];
	const resolvedConfig = resolveConfig(cwd);
	const isLocalDevServer =
		resolvedConfig.server_url.includes("localhost") ||
		resolvedConfig.server_url.includes("127.0.0.1");

	// ===========================================
	// System checks (CPU / memory / orphan daemons)
	// ===========================================
	// Phase E.1 — `interlinked doctor` surfaces system signals before
	// configuration ones. CPU/RAM/orphan-count problems matter even when
	// the rest of the install is fine, and they're the most common cause
	// of latency-budget overruns and runaway memory growth in the wild.
	for (const r of runSystemChecks()) {
		results.push({ name: r.name, status: r.status, message: r.message });
	}

	// ===========================================
	// Local Checks (no server needed)
	// ===========================================

	// 1. Config directory exists
	const configDir = getConfigDir(cwd);
	if (existsSync(configDir)) {
		results.push({ name: "Config directory", status: "pass", message: ".interlinked/ exists" });
	} else {
		results.push({
			name: "Config directory",
			status: "fail",
			message: ".interlinked/ not found -- run 'interlinked enable'",
			fixable: false,
		});
	}

	// 2. Shared config exists
	const sharedConfigPath = getSharedConfigPath(cwd);
	if (existsSync(sharedConfigPath)) {
		results.push({
			name: "Shared config",
			status: "pass",
			message: "config.json exists",
		});
	} else {
		results.push({
			name: "Shared config",
			status: "fail",
			message: "config.json not found -- run 'interlinked enable'",
		});
	}

	// 3. Local config exists
	const localConfigPath = getLocalConfigPath(cwd);
	if (existsSync(localConfigPath)) {
		results.push({
			name: "Local config",
			status: "pass",
			message: "config.local.json exists",
		});
		if (!resolvedConfig.agent_name) {
			results.push({
				name: "Agent identity",
				status: "warn",
				message:
					"agent_name is not set -- project-level capture uses session-scoped IDs. Set a stable identity with 'interlinked attach --agent <name>'",
			});
		}
	} else {
		results.push({
			name: "Local config",
			status: "warn",
			message:
				"config.local.json not found -- run 'interlinked login' or 'interlinked register'",
		});
	}

	// 4. Hook script exists
	const hookScriptPath = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	const legacyHookPath = join(cwd, ".claude", "hooks", "interlinked-activity.mjs");
	if (existsSync(hookScriptPath) || existsSync(legacyHookPath)) {
		results.push({
			name: "Hook script",
			status: "pass",
			message: "interlinked-activity.mjs present",
		});
	} else {
		results.push({
			name: "Hook script",
			status: "warn",
			message: "Hook script not found -- run 'interlinked enable' to install",
		});
	}

	// 4b. Hook script version check
	if (existsSync(hookScriptPath)) {
		try {
			const hookContent = readFileSync(hookScriptPath, "utf-8");
			const versionMatch = hookContent.match(/interlinked-hook-version:\s*([\d.]+)/);
			const installedVersion = versionMatch?.[1];
			if (!installedVersion) {
				results.push({
					name: "Hook version",
					status: "warn",
					message: `No version stamp found (expected ${HOOK_SCRIPT_VERSION}) -- run 'interlinked enable' to update`,
					fixable: true,
					fixAction: "regenerate",
				});
				if (opts.fix) {
					writeHookScript(cwd);
					results[results.length - 1] = {
						name: "Hook version",
						status: "pass",
						message: `Regenerated hook script (v${HOOK_SCRIPT_VERSION})`,
					};
				}
			} else if (installedVersion !== HOOK_SCRIPT_VERSION) {
				results.push({
					name: "Hook version",
					status: "warn",
					message: `Installed v${installedVersion}, expected v${HOOK_SCRIPT_VERSION} -- run 'interlinked enable' to update`,
					fixable: true,
					fixAction: "regenerate",
				});
				if (opts.fix) {
					writeHookScript(cwd);
					results[results.length - 1] = {
						name: "Hook version",
						status: "pass",
						message: `Updated hook script from v${installedVersion} to v${HOOK_SCRIPT_VERSION}`,
					};
				}
			} else {
				results.push({
					name: "Hook version",
					status: "pass",
					message: `v${installedVersion} (current)`,
				});
			}
		} catch {
			results.push({
				name: "Hook version",
				status: "warn",
				message: "Could not read hook script for version check",
			});
		}
	}

	// 5. Client hooks installed
	const clientChecks: Array<{ name: string; dir: string; settingsFile: string }> = [
		{ name: "Claude Code", dir: ".claude", settingsFile: "settings.json" },
		{ name: "Gemini CLI", dir: ".gemini", settingsFile: "settings.json" },
		{ name: "Codex CLI", dir: ".codex", settingsFile: "config.toml" },
	];

	for (const client of clientChecks) {
		const clientDir = join(cwd, client.dir);
		if (!existsSync(clientDir)) continue; // Skip clients that aren't present

		const settingsPath = join(clientDir, client.settingsFile);
		if (existsSync(settingsPath)) {
			try {
				const content = readFileSync(settingsPath, "utf-8");
				if (content.includes("interlinked-activity")) {
					results.push({
						name: `${client.name} hooks`,
						status: "pass",
						message: "Hooks installed",
					});
				} else {
					results.push({
						name: `${client.name} hooks`,
						status: "warn",
						message:
							"Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'",
					});
				}
			} catch {
				results.push({
					name: `${client.name} hooks`,
					status: "warn",
					message: "Could not read settings file",
				});
			}
		} else {
			results.push({
				name: `${client.name} hooks`,
				status: "warn",
				message: `${client.settingsFile} not found`,
			});
		}
	}

	// 6. Auth token present
	const token = resolveAuthToken(cwd);
	if (token) {
		results.push({
			name: "Auth token",
			status: "pass",
			message: "Token available",
		});
	} else {
		if (isLocalDevServer) {
			results.push({
				name: "Auth token",
				status: "warn",
				message: "No auth token (localhost dev mode allows unauthenticated access)",
			});
		} else {
			results.push({
				name: "Auth token",
				status: "fail",
				message: "No auth token -- run 'interlinked login'",
			});
		}
	}

	// 7. Legacy config detected
	if (hasLegacyConfig(cwd)) {
		results.push({
			name: "Legacy config",
			status: "warn",
			message: "Found .claude/interlinked-session.json -- should migrate to .interlinked/",
			fixable: true,
			fixAction: "migrate",
		});

		if (opts.fix) {
			const migrated = migrateLegacyConfig(cwd);
			if (migrated) {
				// Update the result
				results[results.length - 1] = {
					name: "Legacy config",
					status: "pass",
					message: "Migrated .claude/interlinked-session.json to .interlinked/",
				};
			}
		}
	}

	// 8. Stale session files
	const sessionsDir = existsSync(join(cwd, ".interlinked", "sessions"))
		? join(cwd, ".interlinked", "sessions")
		: join(cwd, ".interlinked", "hooks", "agent-sessions");
	if (existsSync(sessionsDir)) {
		try {
			const files = readdirSync(sessionsDir);
			const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24h
			const staleFiles = files.filter((f) => {
				try {
					const stat = statSync(join(sessionsDir, f));
					return stat.mtimeMs < staleThreshold;
				} catch {
					return false;
				}
			});

			if (staleFiles.length > 0) {
				results.push({
					name: "Session files",
					status: "warn",
					message: `${staleFiles.length} stale session file(s) in ${sessionsDir.replace(
						`${cwd}/`,
						"",
					)} -- run 'interlinked clean'`,
					fixable: true,
					fixAction: "clean",
				});
			} else {
				results.push({
					name: "Session files",
					status: "pass",
					message:
						files.length > 0
							? `${files.length} active session file(s)`
							: "No session files",
				});
			}
		} catch {
			results.push({
				name: "Session files",
				status: "warn",
				message: `Could not read ${sessionsDir.replace(`${cwd}/`, "")}`,
			});
		}
	}

	// ===========================================
	// Harness Checks
	// ===========================================

	// 9. Node.js runtime
	results.push({
		name: "Node.js runtime",
		status: "pass",
		message: `${process.version} (${process.execPath})`,
	});

	// 10. Harness server
	const harnessStatus = isHarnessRunning(cwd);
	const socketPath = join(configDir, "harness.sock");
	const socketExists = existsSync(socketPath);

	if (harnessStatus.running) {
		results.push({
			name: "Harness server",
			status: "pass",
			message: `Running (PID ${harnessStatus.pid})`,
		});
	} else if (socketExists) {
		results.push({
			name: "Harness server",
			status: "warn",
			message:
				"Stale socket found but process not running -- run 'interlinked harness start'",
		});
	} else {
		results.push({
			name: "Harness server",
			status: "warn",
			message:
				"Not running -- guard evaluation uses inline fallback (5 checks vs 20+). Start: 'interlinked harness start'",
		});
	}

	// 11. Guard rules
	const guardRulesPath = join(configDir, "guard-rules.json");
	if (existsSync(guardRulesPath)) {
		results.push({
			name: "Guard rules",
			status: "pass",
			message: "guard-rules.json present (team-shared rules)",
		});
	} else {
		results.push({
			name: "Guard rules",
			status: "warn",
			message: "guard-rules.json not found -- harness uses built-in rules only",
		});
	}

	// ===========================================
	// Server Checks (need auth)
	// ===========================================

	const serverResults: CheckResult[] = [];

	if (token) {
		try {
			const client = getClient();
			const health = await client.healthCheck();

			if (health.serverReachable) {
				serverResults.push({
					name: "Server reachable",
					status: "pass",
					message: `Connected to ${resolvedConfig.server_url}`,
				});
			} else {
				serverResults.push({
					name: "Server reachable",
					status: "fail",
					message: health.error || "Server unreachable",
				});
			}

			if (health.authenticated) {
				serverResults.push({
					name: "Auth valid",
					status: "pass",
					message: health.serverVersion
						? `Server v${health.serverVersion}`
						: "Authenticated",
				});
			} else if (health.serverReachable) {
				serverResults.push({
					name: "Auth valid",
					status: "fail",
					message: `${health.error || "Authentication failed"} -- run 'interlinked login'`,
				});
			}

			// Check registry workspaces (same source as `interlinked workspace list`)
			if (health.authenticated) {
				try {
					const registryWorkspaces = await client.fetchWorkspaces();
					const wsCount = registryWorkspaces.length;
					serverResults.push({
						name: "Registry workspace access",
						status: wsCount > 0 ? "pass" : "warn",
						message:
							wsCount > 0
								? `${wsCount} workspace(s) accessible`
								: "No registry workspaces found",
					});
				} catch (e) {
					serverResults.push({
						name: "Registry workspace access",
						status: "fail",
						message:
							e instanceof Error ? e.message : "Could not list registry workspaces",
					});
				}

				// Also check internal codebases in the active workspace DO context.
				// This is a different scope than registry workspaces and can be >1
				// inside a single ws_ membership.
				try {
					const wsResult = await client.callTool<{
						workspaces?: Array<{ name?: string }>;
					}>("list_workspaces", {});
					const codebaseCount = wsResult?.workspaces?.length || 0;
					serverResults.push({
						name: "Codebase access (active workspace)",
						status: codebaseCount > 0 ? "pass" : "warn",
						message:
							codebaseCount > 0
								? `${codebaseCount} codebase(s) in active workspace`
								: "No codebases found in active workspace",
					});
				} catch (e) {
					serverResults.push({
						name: "Codebase access (active workspace)",
						status: "warn",
						message:
							e instanceof Error
								? e.message
								: "Could not list codebases in active workspace",
					});
				}
			}
		} catch (e) {
			serverResults.push({
				name: "Server reachable",
				status: "fail",
				message: e instanceof Error ? e.message : "Connection failed",
			});
		}
	} else {
		serverResults.push({
			name: "Server checks",
			status: "warn",
			message: "Skipped -- no auth token available",
		});
	}

	// ===========================================
	// Output
	// ===========================================

	const allResults = [...results, ...serverResults];

	output(mode, allResults, {
		json: () => ({
			local: results,
			server: serverResults,
			summary: {
				pass: allResults.filter((r) => r.status === "pass").length,
				fail: allResults.filter((r) => r.status === "fail").length,
				warn: allResults.filter((r) => r.status === "warn").length,
			},
		}),
		normal: () => {
			const lines: string[] = [];

			lines.push(header("Local Checks"));
			for (const r of results) {
				lines.push(`  ${statusIcon(r.status)} ${r.name} -- ${r.message}`);
			}

			lines.push("");
			lines.push(header("Server Checks"));
			for (const r of serverResults) {
				lines.push(`  ${statusIcon(r.status)} ${r.name} -- ${r.message}`);
			}

			// Summary line
			const passCount = allResults.filter((r) => r.status === "pass").length;
			const failCount = allResults.filter((r) => r.status === "fail").length;
			const warnCount = allResults.filter((r) => r.status === "warn").length;

			lines.push("");
			lines.push(divider());
			const summaryParts: string[] = [];
			summaryParts.push(c.green(`${passCount} passed`));
			if (failCount > 0) summaryParts.push(c.red(`${failCount} failed`));
			if (warnCount > 0) summaryParts.push(c.yellow(`${warnCount} warnings`));
			lines.push(`  ${summaryParts.join(", ")}`);

			if (failCount > 0 && !opts.fix) {
				lines.push(c.dim("\n  Run 'interlinked doctor --fix' to attempt auto-fixes."));
			}

			return lines.join("\n");
		},
	});

	if (allResults.some((r) => r.status === "fail")) {
		process.exitCode = 1;
	}
}
