// ===========================================
// interlinked enable — Install hooks + create .interlinked/ config
// ===========================================
// Sets up the .interlinked/ directory, writes the hook script,
// installs hooks into detected AI coding clients, and manages
// .gitignore entries. Supports --dry-run for preview.

import {
	getConfigDir,
	hasLegacyConfig,
	initConfig,
	isConfigured,
	migrateLegacyConfig,
	resolveConfig,
	updateLocalConfig,
} from "../lib/config.js";
import { c } from "../lib/formatter.js";
import {
	detectHookManagers,
	ensureGitignore,
	getHookScriptPath,
	installAllHooks,
	installStatusLine,
	writeHookScript,
} from "../lib/hooks.js";
import { type ClientName, detectClients } from "../lib/settings.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";

interface EnableOptions {
	server?: string;
	agent?: string;
	clients?: string;
	syncMode?: string;
	dataDir?: string;
	dryRun?: boolean;
	structure?: string;
}

const VALID_SYNC_MODES = ["realtime", "local", "manual"] as const;
type SyncMode = (typeof VALID_SYNC_MODES)[number];

export async function enableCommand(options: EnableOptions): Promise<void> {
	const cwd = process.cwd();

	// Parse client list
	const requestedClients = options.clients
		? options.clients.split(",").map((s) => s.trim().toLowerCase() as ClientName)
		: null;

	// --dry-run: show what would happen without modifying anything
	if (options.dryRun) {
		printDryRun(cwd, options, requestedClients);
		return;
	}

	console.log(c.bold("Interlinked CLI — Enable Hook Management"));
	console.log(c.dim("─".repeat(40)));

	// Step 1: Check if already configured
	if (isConfigured(cwd)) {
		console.log(
			`\n${c.yellow("Already enabled.")} Config exists at ${c.dim(getConfigDir(cwd))}`,
		);
		console.log(c.dim("Updating hooks and config..."));
	}

	// Step 2: Handle legacy config migration
	if (hasLegacyConfig(cwd)) {
		console.log(`\n${c.yellow("Legacy config detected:")} .claude/interlinked-session.json`);
		const migrated = migrateLegacyConfig(cwd);
		if (migrated) {
			console.log(`  ${c.green("Migrated")} to .interlinked/config.json + config.local.json`);
		} else {
			console.log(`  ${c.dim("Migration skipped (could not read legacy config)")}`);
		}
	}

	// Step 3: Initialize config if not present
	if (!isConfigured(cwd)) {
		initConfig({ serverUrl: options.server }, cwd);
		console.log(`\n${c.green("Created")} .interlinked/config.json`);
	} else if (options.server) {
		// Update server URL if provided
		const config = resolveConfig(cwd);
		if (config.server_url !== options.server) {
			initConfig({ serverUrl: options.server }, cwd);
			console.log(
				`\n${c.green("Updated")} Interlinked MCP Server URL to ${c.cyan(options.server)}`,
			);
		}
	}

	// Step 4: Update local config with agent name and sync mode if provided
	if (options.agent) {
		updateLocalConfig({ agent_name: options.agent }, cwd);
		console.log(`  ${c.green("Set")} agent name: ${c.cyan(options.agent)}`);
	}

	if (options.syncMode) {
		if (!VALID_SYNC_MODES.includes(options.syncMode as SyncMode)) {
			console.log(
				`\n${c.red("Error:")} Invalid sync mode "${options.syncMode}". Must be one of: ${VALID_SYNC_MODES.join(", ")}`,
			);
			process.exit(1);
		}
		updateLocalConfig({ sync_mode: options.syncMode as SyncMode }, cwd);
		console.log(`  ${c.green("Set")} sync mode: ${c.cyan(options.syncMode)}`);
	}

	if (options.dataDir) {
		updateLocalConfig({ data_dir: options.dataDir }, cwd);
		console.log(`  ${c.green("Set")} data dir: ${c.cyan(options.dataDir)}`);
	}

	// Step 5: Detect hook managers
	const hookManagers = detectHookManagers(cwd);
	if (hookManagers.length > 0) {
		for (const mgr of hookManagers) {
			console.log(
				`\n${c.yellow("Detected")} ${c.bold(mgr.name)} at ${c.dim(mgr.detected_at)}. Interlinked CLI hooks will coexist but check for conflicts.`,
			);
		}
	}

	// Step 6: Write the hook script (renumbered)
	const hookScriptPath = writeHookScript(cwd);
	const relativeHookPath = hookScriptPath.replace(`${cwd}/`, "");
	console.log(`\n${c.green("Wrote")} hook script: ${c.dim(relativeHookPath)}`);

	// Step 6: Detect clients and install hooks
	const detected = detectClients(cwd);
	const detectedNames = detected.filter((d) => d.exists).map((d) => d.name);

	// Use requested clients if specified, otherwise use detected + always include claude
	let targetClients: ClientName[];
	if (requestedClients) {
		targetClients = requestedClients;
	} else if (detectedNames.length > 0) {
		targetClients = detectedNames;
	} else {
		// Default to claude if nothing detected
		targetClients = ["claude"];
	}

	console.log(`\n${c.bold("Installing hooks:")}`);

	// Use relative path since client settings files (.claude/settings.json) may be committed.
	// The hook script resolves its own paths relative to CWD at runtime.
	const results = installAllHooks(cwd, relativeHookPath, targetClients);

	for (const result of results) {
		if (result.installed) {
			console.log(
				`  ${c.green("+")} ${c.bold(result.client)} — ${result.events.length} event(s): ${c.dim(result.events.join(", "))}`,
			);
		} else if (result.error) {
			console.log(`  ${c.red("x")} ${c.bold(result.client)} — ${c.red(result.error)}`);
		} else {
			console.log(`  ${c.dim("-")} ${c.bold(result.client)} — no changes needed`);
		}
	}

	const installedCount = results.filter((r) => r.installed).length;
	if (installedCount === 0) {
		console.log(`\n${c.yellow("Warning:")} No hooks were installed.`);
		if (detectedNames.length === 0) {
			console.log(c.dim("  No client directories (.claude/, .github/hooks/) found."));
			console.log(c.dim("  Use --clients claude,copilot to force installation."));
		}
	}

	// Step 7: Update .gitignore
	const gitignoreUpdated = ensureGitignore(cwd);
	if (gitignoreUpdated) {
		console.log(`\n${c.green("Updated")} .gitignore with Interlinked CLI local paths`);
	}

	// Step 8: Install status line for clients that support it
	const statusLineClients = targetClients.filter((c) => c === "claude" || c === "copilot");
	if (statusLineClients.length > 0) {
		const statusLinePath = installStatusLine(statusLineClients);
		if (statusLinePath) {
			console.log(
				`\n${c.green("Configured")} status line for ${statusLineClients.join(", ")}: ${c.dim(statusLinePath)}`,
			);
		}
	}

	// Step 9: Start harness daemon
	const harnessStatus = isHarnessRunning(cwd);
	if (!harnessStatus.running) {
		try {
			const harnessOpts = { daemon: true };
			await harnessStartCommand(harnessOpts);
		} catch {
			console.log(
				`\n${c.yellow("!")} Failed to start harness. Run: ${c.cyan("interlinked harness start --verbose")}`,
			);
		}
	}

	// Step 10: Show not-yet-detected clients
	const undetected = ["claude", "copilot"].filter(
		(n) => !detectedNames.includes(n as ClientName) && !targetClients.includes(n as ClientName),
	);
	if (undetected.length > 0 && !requestedClients) {
		console.log(
			`\n${c.dim("Not detected:")} ${undetected.join(", ")} ${c.dim("(add with --clients)")}`,
		);
	}

	// Step 11: Scaffold structure manifests if requested
	if (options.structure) {
		try {
			const { structureInitCommand } = await import("./structure.js");
			const structureOpts = { mode: options.structure, write: true };
			await structureInitCommand(structureOpts);
		} catch (err) {
			console.log(
				`\n${c.yellow("!")} Structure scaffolding failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Summary
	const config = resolveConfig(cwd);
	console.log(`\n${c.bold("Configuration:")}`);
	console.log(`  ${c.dim("Interlinked MCP Server:")} ${config.server_url}`);
	console.log(`  ${c.dim("Config:")}    ${getConfigDir(cwd)}/`);
	console.log(`  ${c.dim("Hook:")}      ${relativeHookPath}`);
	if (config.agent_name) {
		console.log(`  ${c.dim("Agent:")}     ${config.agent_name}`);
	}
	console.log(`  ${c.dim("Sync:")}      ${config.sync_mode}`);

	// Auth status
	if (config.access_token) {
		console.log(`  ${c.dim("Auth:")}      ${c.green("Authenticated")}`);
	} else {
		console.log(
			`  ${c.dim("Auth:")}      ${c.yellow("Not logged in")} — run ${c.cyan("interlinked login")}`,
		);
	}

	if (installedCount > 0) {
		console.log(
			`\n${c.green("Hooks are active.")} Agent activity will be reported to the Interlinked MCP Server.`,
		);
	} else {
		console.log(
			`\n${c.yellow("Hooks are not active.")} No hook entries were installed. Re-run with ${c.cyan("--clients claude,gemini,codex")} or check client settings paths.`,
		);
	}
}

// ===========================================
// Dry Run Output
// ===========================================

function printDryRun(
	cwd: string,
	options: EnableOptions,
	requestedClients: ClientName[] | null,
): void {
	console.log(c.bold("Interlinked CLI — Enable (dry run)"));
	console.log(c.dim("─".repeat(40)));
	console.log(c.dim("No files will be modified.\n"));

	// Config status
	if (isConfigured(cwd)) {
		console.log(`${c.dim("Config:")}     Already exists at ${getConfigDir(cwd)}/`);
	} else {
		console.log(`${c.green("Create:")}     ${getConfigDir(cwd)}/config.json`);
	}

	// Legacy migration
	if (hasLegacyConfig(cwd)) {
		console.log(`${c.yellow("Migrate:")}    .claude/interlinked-session.json -> .interlinked/`);
	}

	// Hook script
	const hookPath = getHookScriptPath(cwd).replace(`${cwd}/`, "");
	console.log(`${c.green("Write:")}      ${hookPath}`);

	// Client detection
	const detected = detectClients(cwd);
	const detectedNames = detected.filter((d) => d.exists).map((d) => d.name);

	let targetClients: ClientName[];
	if (requestedClients) {
		targetClients = requestedClients;
	} else if (detectedNames.length > 0) {
		targetClients = detectedNames;
	} else {
		targetClients = ["claude"];
	}

	console.log(`\n${c.bold("Would install hooks for:")}`);
	for (const client of targetClients) {
		const isDetected = detectedNames.includes(client);
		const suffix = isDetected ? c.dim(" (detected)") : c.dim(" (forced)");
		switch (client) {
			case "claude":
				console.log(`  ${c.bold("claude")} — 13 events (all Claude Code hooks)${suffix}`);
				break;
			case "copilot":
				console.log(`  ${c.bold("copilot")} — 6 events (Copilot CLI hooks)${suffix}`);
				break;
		}
	}

	// gitignore
	console.log(`\n${c.bold("Would update .gitignore with:")}`);
	console.log("  .interlinked/config.local.json");
	console.log("  .interlinked/sessions/");

	// Server. Default to localhost — the public distribution doesn't know
	// about any production server; users configure their own via `--server`.
	const serverUrl = options.server || "http://localhost:8787";
	console.log(`\n${c.dim("Interlinked MCP Server:")} ${serverUrl}`);
	if (options.agent) {
		console.log(`${c.dim("Agent:")}  ${options.agent}`);
	}

	console.log(`\n${c.dim("Run without --dry-run to apply.")}`);
}
