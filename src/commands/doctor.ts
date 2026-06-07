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
import { type CollectionLiveness, getCollectionLiveness } from "../lib/collection/liveness.js";
import { c, divider, header } from "../lib/formatter.js";
import { HOOK_SCRIPT_VERSION, writeHookScript } from "../lib/hooks.js";
import { getOutputMode, output } from "../lib/output.js";
import {
	defaultSettingsPaths,
	stripMalformedRules,
	validateSettingsFile,
} from "../lib/settings-validator.js";
import {
	type HarnessMode,
	DEFAULT_HARNESS_MODE,
	migrateLegacyMode,
} from "../harness/rules/modes.js";
import { runSystemChecks } from "./doctor-system.js";
import { isHarnessRunning } from "./harness.js";

/**
 * Build the full version sentinel the hook script SHOULD carry, given the
 * configured mode. Mirror of `writeHookScript`'s `${version}+mode-${name}`
 * shape in `src/lib/hooks.ts`. Used to detect drift when the user changes
 * `mode` outside the `interlinked harness mode` path (e.g. by editing
 * `.interlinked/config.json` directly) — without the mode suffix in the
 * compare, doctor would read `0.1.0+mode-budget` as `0.1.0` and skip the
 * regenerate even though the baked timeout is for the wrong mode.
 */
function expectedHookVersion(cwd: string): string {
	const sharedConfigPath = getSharedConfigPath(cwd);
	let modeName: HarnessMode = DEFAULT_HARNESS_MODE;
	if (existsSync(sharedConfigPath)) {
		try {
			const parsed = JSON.parse(readFileSync(sharedConfigPath, "utf-8")) as { mode?: unknown };
			const raw = typeof parsed.mode === "string" ? parsed.mode : undefined;
			modeName = migrateLegacyMode(raw, undefined);
		} catch (err) {
			// Malformed config.json — fall back to the default mode and let
			// the broader doctor flow surface a separate "config invalid"
			// finding. Better than crashing the version-check entirely.
			void err;
		}
	}
	return `${HOOK_SCRIPT_VERSION}+mode-${modeName}`;
}

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

/** Build the data-collection check row from a liveness reading. Kept out of
 *  `doctorCommand` so it adds no branches to that (already large) function. */
function collectionLivenessCheck(live: CollectionLiveness): {
	status: CheckStatus;
	message: string;
} {
	const status: CheckStatus = live.status === "live" || live.status === "idle" ? "pass" : "warn";
	switch (live.status) {
		case "live":
			return { status, message: `collection.jsonl flowing -- ${live.reason}` };
		case "idle":
			return { status, message: `collection.jsonl -- ${live.reason}` };
		case "stale":
			return {
				status,
				message: `collection.jsonl STALE -- ${live.reason}. Check 'interlinked harness status' + hook wiring ('interlinked enable').`,
			};
		case "missing":
			return {
				status,
				message:
					"No collection.jsonl yet -- start the daemon and run 'interlinked enable' to begin recording.",
			};
		case "empty":
			return { status, message: "collection.jsonl is empty -- no tool events recorded yet." };
		default:
			return { status, message: `collection.jsonl unreadable -- ${live.reason}` };
	}
}

/** System checks (CPU / memory / orphan daemons), normalized to CheckResult. */
function systemChecks(): CheckResult[] {
	return runSystemChecks().map((r) => ({ name: r.name, status: r.status, message: r.message }));
}

/** Config-directory / shared-config / local-config / agent-identity / hook-presence
 *  checks — the cluster of local existence checks that gate the rest of doctor. */
function localFileChecks(
	cwd: string,
	resolvedConfig: { agent_name?: string | undefined },
): CheckResult[] {
	const out: CheckResult[] = [];

	// 1. Config directory exists
	if (existsSync(getConfigDir(cwd))) {
		out.push({ name: "Config directory", status: "pass", message: ".interlinked/ exists" });
	} else {
		out.push({
			name: "Config directory",
			status: "fail",
			message: ".interlinked/ not found -- run 'interlinked enable'",
			fixable: false,
		});
	}

	// 2. Shared config exists
	if (existsSync(getSharedConfigPath(cwd))) {
		out.push({ name: "Shared config", status: "pass", message: "config.json exists" });
	} else {
		out.push({
			name: "Shared config",
			status: "fail",
			message: "config.json not found -- run 'interlinked enable'",
		});
	}

	// 3. Local config exists (+ agent identity nudge when present but unnamed)
	if (existsSync(getLocalConfigPath(cwd))) {
		out.push({ name: "Local config", status: "pass", message: "config.local.json exists" });
		if (!resolvedConfig.agent_name) {
			out.push({
				name: "Agent identity",
				status: "warn",
				message:
					"agent_name is not set -- project-level capture uses session-scoped IDs. Set a stable identity with 'interlinked attach --agent <name>'",
			});
		}
	} else {
		out.push({
			name: "Local config",
			status: "warn",
			message: "config.local.json not found -- run 'interlinked login' or 'interlinked register'",
		});
	}

	// 4. Hook script exists (current path or legacy .claude path)
	const hookScriptPath = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	const legacyHookPath = join(cwd, ".claude", "hooks", "interlinked-activity.mjs");
	if (existsSync(hookScriptPath) || existsSync(legacyHookPath)) {
		out.push({ name: "Hook script", status: "pass", message: "interlinked-activity.mjs present" });
	} else {
		out.push({
			name: "Hook script",
			status: "warn",
			message: "Hook script not found -- run 'interlinked enable' to install",
		});
	}

	return out;
}

/** Build the single Hook-version CheckResult for a stamp-bearing or stamp-less
 *  hook (no I/O side effects). `--fix` regeneration is applied by the caller. */
function hookVersionResult(installedVersion: string | undefined, expectedVersion: string): CheckResult {
	if (!installedVersion) {
		return {
			name: "Hook version",
			status: "warn",
			message: `No version stamp found (expected ${expectedVersion}) -- run 'interlinked enable' to update`,
			fixable: true,
			fixAction: "regenerate",
		};
	}
	if (installedVersion !== expectedVersion) {
		return {
			name: "Hook version",
			status: "warn",
			message: `Installed v${installedVersion}, expected v${expectedVersion} -- run 'interlinked enable' to update`,
			fixable: true,
			fixAction: "regenerate",
		};
	}
	return { name: "Hook version", status: "pass", message: `v${installedVersion} (current)` };
}

/** Hook-version drift check (4b). Only meaningful when the `.interlinked` hook
 *  exists; returns [] otherwise. Applies the `--fix` regenerate in-place. */
function hookVersionChecks(cwd: string, fix: boolean): CheckResult[] {
	const hookScriptPath = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	if (!existsSync(hookScriptPath)) return [];
	try {
		const hookContent = readFileSync(hookScriptPath, "utf-8");
		// Capture the FULL version sentinel including any `+mode-<name>` suffix
		// baked in by `writeHookScript` (see `src/lib/hooks.ts`). The previous
		// `[\d.]+` form stopped at the first `+`, reading `0.1.0+mode-budget` as
		// just `0.1.0` so a `mode budget → ci` switch outside `harness mode`
		// (manual config edit) appeared "current" and `--fix` skipped regenerate.
		const versionMatch = hookContent.match(/interlinked-hook-version:\s*(\S+)/);
		const installedVersion = versionMatch?.[1];
		const expectedVersion = expectedHookVersion(cwd);
		const result = hookVersionResult(installedVersion, expectedVersion);
		if (result.status === "pass" || !fix) return [result];
		// --fix path: regenerate and report the transition.
		writeHookScript(cwd);
		const fixedMessage = installedVersion
			? `Updated hook script from v${installedVersion} to v${expectedVersion}`
			: `Regenerated hook script (v${expectedVersion})`;
		return [{ name: "Hook version", status: "pass", message: fixedMessage }];
	} catch {
		return [
			{
				name: "Hook version",
				status: "warn",
				message: "Could not read hook script for version check",
			},
		];
	}
}

/** Build the per-client hooks CheckResult from a settings file's content. */
function clientHookResult(clientName: string, content: string): CheckResult {
	if (content.includes("interlinked-activity")) {
		return { name: `${clientName} hooks`, status: "pass", message: "Hooks installed" };
	}
	return {
		name: `${clientName} hooks`,
		status: "warn",
		message: "Settings file exists but no Interlinked CLI hooks -- run 'interlinked enable'",
	};
}

/** Client hooks installed (5) — Claude Code / Gemini CLI / Codex CLI. Clients
 *  whose dir is absent are skipped entirely. */
function clientHookChecks(cwd: string): CheckResult[] {
	const clientChecks: Array<{ name: string; dir: string; settingsFile: string }> = [
		{ name: "Claude Code", dir: ".claude", settingsFile: "settings.json" },
		{ name: "Gemini CLI", dir: ".gemini", settingsFile: "settings.json" },
		{ name: "Codex CLI", dir: ".codex", settingsFile: "config.toml" },
	];
	const out: CheckResult[] = [];
	for (const client of clientChecks) {
		const clientDir = join(cwd, client.dir);
		if (!existsSync(clientDir)) continue; // Skip clients that aren't present

		const settingsPath = join(clientDir, client.settingsFile);
		if (!existsSync(settingsPath)) {
			out.push({
				name: `${client.name} hooks`,
				status: "warn",
				message: `${client.settingsFile} not found`,
			});
			continue;
		}
		try {
			out.push(clientHookResult(client.name, readFileSync(settingsPath, "utf-8")));
		} catch {
			out.push({
				name: `${client.name} hooks`,
				status: "warn",
				message: "Could not read settings file",
			});
		}
	}
	return out;
}

/** Permission-rule hygiene across Claude Code settings files (5b). Claude
 *  Code's "Always allow" extractor occasionally writes rules with mismatched
 *  parentheses; we scan all known settings files and (with --fix) strip them. */
function permissionRuleChecks(cwd: string, fix: boolean): CheckResult[] {
	const out: CheckResult[] = [];
	for (const settingsPath of defaultSettingsPaths(cwd)) {
		const v = validateSettingsFile(settingsPath);
		if (!v.exists || v.parseError) continue;
		if (v.malformed.length === 0) continue;
		const display = settingsPath.replace(`${cwd}/`, "").replace(process.env.HOME ?? "~", "~");
		const checkName = `Permission rules (${display})`;
		if (fix) {
			const stripped = stripMalformedRules(settingsPath);
			out.push({
				name: checkName,
				status: "pass",
				message: `Stripped ${stripped} malformed rule(s) from ${display}`,
			});
			continue;
		}
		const sample = v.malformed[0]?.rule.slice(0, 60) ?? "";
		out.push({
			name: checkName,
			status: "warn",
			message: `${v.malformed.length} malformed rule(s) -- e.g. ${JSON.stringify(sample)}${
				sample.length === 60 ? "..." : ""
			}. Run 'interlinked doctor --fix' to strip.`,
			fixable: true,
			fixAction: "strip-permission-rules",
		});
	}
	return out;
}

/** Auth token presence (6). Localhost dev servers downgrade an absent token
 *  from fail to warn (unauthenticated access is allowed there). */
function authTokenCheck(token: string | null, isLocalDevServer: boolean): CheckResult {
	if (token) {
		return { name: "Auth token", status: "pass", message: "Token available" };
	}
	if (isLocalDevServer) {
		return {
			name: "Auth token",
			status: "warn",
			message: "No auth token (localhost dev mode allows unauthenticated access)",
		};
	}
	return { name: "Auth token", status: "fail", message: "No auth token -- run 'interlinked login'" };
}

/** Legacy `.claude/interlinked-session.json` detection + migration (7). */
function legacyConfigCheck(cwd: string, fix: boolean): CheckResult[] {
	if (!hasLegacyConfig(cwd)) return [];
	if (fix && migrateLegacyConfig(cwd)) {
		return [
			{
				name: "Legacy config",
				status: "pass",
				message: "Migrated .claude/interlinked-session.json to .interlinked/",
			},
		];
	}
	return [
		{
			name: "Legacy config",
			status: "warn",
			message: "Found .claude/interlinked-session.json -- should migrate to .interlinked/",
			fixable: true,
			fixAction: "migrate",
		},
	];
}

/** Build the Session-files CheckResult from a directory's file listing (8). */
function sessionFilesResult(sessionsDir: string, cwd: string, files: string[]): CheckResult {
	const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24h
	const staleFiles = files.filter((f) => {
		try {
			return statSync(join(sessionsDir, f)).mtimeMs < staleThreshold;
		} catch {
			return false;
		}
	});
	const display = sessionsDir.replace(`${cwd}/`, "");
	if (staleFiles.length > 0) {
		return {
			name: "Session files",
			status: "warn",
			message: `${staleFiles.length} stale session file(s) in ${display} -- run 'interlinked clean'`,
			fixable: true,
			fixAction: "clean",
		};
	}
	return {
		name: "Session files",
		status: "pass",
		message: files.length > 0 ? `${files.length} active session file(s)` : "No session files",
	};
}

/** Stale session-file scan (8). Returns [] when no sessions dir exists. */
function sessionFileChecks(cwd: string): CheckResult[] {
	const sessionsDir = existsSync(join(cwd, ".interlinked", "sessions"))
		? join(cwd, ".interlinked", "sessions")
		: join(cwd, ".interlinked", "hooks", "agent-sessions");
	if (!existsSync(sessionsDir)) return [];
	try {
		return [sessionFilesResult(sessionsDir, cwd, readdirSync(sessionsDir))];
	} catch {
		return [
			{
				name: "Session files",
				status: "warn",
				message: `Could not read ${sessionsDir.replace(`${cwd}/`, "")}`,
			},
		];
	}
}

/** Node runtime + harness server + guard rules (9–11). */
function harnessChecks(cwd: string, configDir: string): CheckResult[] {
	const out: CheckResult[] = [];

	// 9. Node.js runtime
	out.push({
		name: "Node.js runtime",
		status: "pass",
		message: `${process.version} (${process.execPath})`,
	});

	// 10. Harness server
	const harnessStatus = isHarnessRunning(cwd);
	const socketExists = existsSync(join(configDir, "harness.sock"));
	if (harnessStatus.running) {
		out.push({
			name: "Harness server",
			status: "pass",
			message: `Running (PID ${harnessStatus.pid})`,
		});
	} else if (socketExists) {
		out.push({
			name: "Harness server",
			status: "warn",
			message: "Stale socket found but process not running -- run 'interlinked harness start'",
		});
	} else {
		out.push({
			name: "Harness server",
			status: "warn",
			message:
				"Not running -- guard evaluation uses inline fallback (5 checks vs 20+). Start: 'interlinked harness start'",
		});
	}

	// 11. Guard rules
	if (existsSync(join(configDir, "guard-rules.json"))) {
		out.push({
			name: "Guard rules",
			status: "pass",
			message: "guard-rules.json present (team-shared rules)",
		});
	} else {
		out.push({
			name: "Guard rules",
			status: "warn",
			message: "guard-rules.json not found -- harness uses built-in rules only",
		});
	}

	return out;
}

/** Minimal structural view of the health-check result fields doctor reads. */
interface ServerHealth {
	serverReachable: boolean;
	authenticated: boolean;
	serverVersion?: string | undefined;
	error?: string | undefined;
}
type DoctorClient = ReturnType<typeof getClient>;

/** Server-reachable + auth-valid rows derived from a health-check result. */
function serverIdentityChecks(health: ServerHealth, serverUrl: string): CheckResult[] {
	const out: CheckResult[] = [];
	if (health.serverReachable) {
		out.push({ name: "Server reachable", status: "pass", message: `Connected to ${serverUrl}` });
	} else {
		out.push({
			name: "Server reachable",
			status: "fail",
			message: health.error || "Server unreachable",
		});
	}
	if (health.authenticated) {
		out.push({
			name: "Auth valid",
			status: "pass",
			message: health.serverVersion ? `Server v${health.serverVersion}` : "Authenticated",
		});
	} else if (health.serverReachable) {
		out.push({
			name: "Auth valid",
			status: "fail",
			message: `${health.error || "Authentication failed"} -- run 'interlinked login'`,
		});
	}
	return out;
}

/** Registry-workspace + active-workspace-codebase access rows (both require an
 *  authenticated client). Each network call is independently fault-isolated. */
async function workspaceAccessChecks(client: DoctorClient): Promise<CheckResult[]> {
	const out: CheckResult[] = [];
	// Registry workspaces (same source as `interlinked workspace list`).
	try {
		const wsCount = (await client.fetchWorkspaces()).length;
		out.push({
			name: "Registry workspace access",
			status: wsCount > 0 ? "pass" : "warn",
			message: wsCount > 0 ? `${wsCount} workspace(s) accessible` : "No registry workspaces found",
		});
	} catch (e) {
		out.push({
			name: "Registry workspace access",
			status: "fail",
			message: e instanceof Error ? e.message : "Could not list registry workspaces",
		});
	}
	// Internal codebases in the active workspace DO context — a different scope
	// than registry workspaces; can be >1 inside a single ws_ membership.
	try {
		const wsResult = await client.callTool<{ workspaces?: Array<{ name?: string }> }>(
			"list_workspaces",
			{},
		);
		const codebaseCount = wsResult?.workspaces?.length || 0;
		out.push({
			name: "Codebase access (active workspace)",
			status: codebaseCount > 0 ? "pass" : "warn",
			message:
				codebaseCount > 0
					? `${codebaseCount} codebase(s) in active workspace`
					: "No codebases found in active workspace",
		});
	} catch (e) {
		out.push({
			name: "Codebase access (active workspace)",
			status: "warn",
			message: e instanceof Error ? e.message : "Could not list codebases in active workspace",
		});
	}
	return out;
}

/** Server checks (need auth). Returns a skipped-warning when no token is
 *  available; otherwise probes health, identity, and workspace access. */
async function serverChecks(
	token: string | null,
	resolvedConfig: { server_url: string },
): Promise<CheckResult[]> {
	if (!token) {
		return [
			{ name: "Server checks", status: "warn", message: "Skipped -- no auth token available" },
		];
	}
	try {
		const client = getClient();
		const health = await client.healthCheck();
		const out = serverIdentityChecks(health, resolvedConfig.server_url);
		if (health.authenticated) {
			out.push(...(await workspaceAccessChecks(client)));
		}
		return out;
	} catch (e) {
		return [
			{
				name: "Server reachable",
				status: "fail",
				message: e instanceof Error ? e.message : "Connection failed",
			},
		];
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
	results.push(...systemChecks());

	// ===========================================
	// Local Checks (no server needed)
	// ===========================================

	// 1–4. Config dir / shared / local config / agent identity / hook presence
	const configDir = getConfigDir(cwd);
	results.push(...localFileChecks(cwd, resolvedConfig));

	// 4c. Data collection liveness — is the canonical collection.jsonl stream
	// advancing? This is the guard the legacy activity.jsonl never had: a stream
	// that silently stops recording (unwired hook, dead daemon, full disk) shows
	// up here instead of being discovered days later.
	const liveness = getCollectionLiveness(cwd);
	results.push({ name: "Data collection", ...collectionLivenessCheck(liveness) });

	// 4b. Hook script version check (only when the .interlinked hook exists)
	results.push(...hookVersionChecks(cwd, opts.fix === true));

	// 5. Client hooks installed
	results.push(...clientHookChecks(cwd));

	// 5b. Permission-rule hygiene across Claude Code settings files.
	// Claude Code's "Always allow" extractor occasionally writes rules with
	// mismatched parentheses (e.g. `Bash(-d) && cd && echo ... *)`) which
	// Claude Code's own /doctor flags as "Invalid permission rule ... was
	// skipped". We can't prevent the upstream write, but we can scan all known
	// settings files and (with --fix) strip them.
	results.push(...permissionRuleChecks(cwd, opts.fix === true));

	// 6. Auth token present
	const token = resolveAuthToken(cwd);
	results.push(authTokenCheck(token, isLocalDevServer));

	// 7. Legacy config detected (+ --fix migration)
	results.push(...legacyConfigCheck(cwd, opts.fix === true));

	// 8. Stale session files
	results.push(...sessionFileChecks(cwd));

	// ===========================================
	// Harness Checks (9–11): Node runtime + harness server + guard rules
	// ===========================================
	results.push(...harnessChecks(cwd, configDir));

	// ===========================================
	// Server Checks (need auth)
	// ===========================================

	const serverResults = await serverChecks(token, resolvedConfig);

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
