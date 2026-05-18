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
import { installEnforceSkill } from "../lib/skill-installers.js";
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

// Clients that ship a `statusLine.command` hook. Codex CLI does not document
// a statusLine equivalent (as of 2026-04); revisit when one lands.
const STATUS_LINE_CLIENTS: readonly ClientName[] = ["claude", "copilot"] as const;

// All known clients in canonical detection order. Driver for "not detected"
// hints + the dry-run printer; keep in sync with the registry in
// `src/lib/hooks.ts` and `CLIENT_CONFIGS` in `src/lib/settings.ts`.
const ALL_CLIENTS: readonly ClientName[] = [
	"claude",
	"copilot",
	"gemini",
	"codex",
	"cursor",
] as const;

interface ClientSummary {
	label: string;
	eventCountText: string;
}

const CLIENT_SUMMARIES: Record<ClientName, ClientSummary> = {
	claude: { label: "claude", eventCountText: "13 events (all Claude Code hooks)" },
	copilot: { label: "copilot", eventCountText: "6 events (Copilot CLI hooks)" },
	gemini: { label: "gemini", eventCountText: "8 events (Gemini CLI hooks)" },
	codex: {
		label: "codex",
		eventCountText: "6 events (.codex/hooks.json + [features] hooks=true flag)",
	},
	cursor: {
		label: "cursor",
		eventCountText:
			"15 events (.cursor/hooks.json — gates + subagent + postToolUseFailure + preCompact)",
	},
};

export async function enableCommand(options: EnableOptions): Promise<void> {
	const cwd = process.cwd();
	const requestedClients = parseRequestedClients(options.clients);

	if (options.dryRun) {
		printDryRun(cwd, options, requestedClients);
		return;
	}

	console.log(c.bold("Interlinked CLI — Enable Hook Management"));
	console.log(c.dim("─".repeat(40)));

	announceConfigState(cwd);
	maybeMigrateLegacyConfig(cwd);
	ensureConfigPresent(cwd, options.server);
	applyOptionFlags(cwd, options);
	announceHookManagers(cwd);

	const hookScriptPath = writeHookScript(cwd);
	const relativeHookPath = hookScriptPath.replace(`${cwd}/`, "");
	console.log(`\n${c.green("Wrote")} hook script: ${c.dim(relativeHookPath)}`);

	const detectedNames = detectClients(cwd)
		.filter((d) => d.exists)
		.map((d) => d.name);
	const targetClients = resolveTargetClients(requestedClients, detectedNames);

	console.log(`\n${c.bold("Installing hooks:")}`);
	const results = installAllHooks(cwd, targetClients);
	const installedCount = printInstallResults(results, detectedNames);

	if (ensureGitignore(cwd)) {
		console.log(`\n${c.green("Updated")} .gitignore with Interlinked CLI local paths`);
	}

	configureStatusLine(targetClients);
	installEnforceSkillForClients(cwd, targetClients);
	await startHarnessIfNeeded(cwd);
	noteUndetectedClients(detectedNames, targetClients, requestedClients);
	await maybeScaffoldStructure(options.structure);
	printSummary(cwd, relativeHookPath, installedCount, targetClients);
}

function installEnforceSkillForClients(cwd: string, targetClients: ClientName[]): void {
	if (targetClients.length === 0) return;
	const results = installEnforceSkill(cwd, targetClients);
	const installed = results.filter((r) => r.installed);
	if (installed.length === 0) {
		const firstErr = results.find((r) => r.error)?.error;
		if (firstErr) {
			console.log(`\n${c.dim("/enforce skill: not installed —")} ${c.yellow(firstErr)}`);
		}
		return;
	}
	console.log(
		`\n${c.green("Installed")} /enforce skill for ${installed.map((r) => r.client).join(", ")}`,
	);
	console.log(
		c.dim(
			"  Invoke as `/enforce <target>` from your agent — e.g. /enforce AGENTS.md",
		),
	);
}

function parseRequestedClients(raw: string | undefined): ClientName[] | null {
	if (!raw) return null;
	return raw.split(",").map((s) => s.trim().toLowerCase() as ClientName);
}

function announceConfigState(cwd: string): void {
	if (!isConfigured(cwd)) return;
	console.log(`\n${c.yellow("Already enabled.")} Config exists at ${c.dim(getConfigDir(cwd))}`);
	console.log(c.dim("Updating hooks and config..."));
}

function maybeMigrateLegacyConfig(cwd: string): void {
	if (!hasLegacyConfig(cwd)) return;
	console.log(`\n${c.yellow("Legacy config detected:")} .claude/interlinked-session.json`);
	const migrated = migrateLegacyConfig(cwd);
	if (migrated) {
		console.log(`  ${c.green("Migrated")} to .interlinked/config.json + config.local.json`);
	} else {
		console.log(`  ${c.dim("Migration skipped (could not read legacy config)")}`);
	}
}

function ensureConfigPresent(cwd: string, serverFlag: string | undefined): void {
	if (!isConfigured(cwd)) {
		initConfig({ serverUrl: serverFlag }, cwd);
		console.log(`\n${c.green("Created")} .interlinked/config.json`);
		return;
	}
	if (!serverFlag) return;
	const config = resolveConfig(cwd);
	if (config.server_url === serverFlag) return;
	initConfig({ serverUrl: serverFlag }, cwd);
	console.log(`\n${c.green("Updated")} Server URL to ${c.cyan(serverFlag)}`);
}

function applyOptionFlags(cwd: string, options: EnableOptions): void {
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
}

function announceHookManagers(cwd: string): void {
	const managers = detectHookManagers(cwd);
	for (const mgr of managers) {
		console.log(
			`\n${c.yellow("Detected")} ${c.bold(mgr.name)} at ${c.dim(mgr.detected_at)}. Interlinked CLI hooks will coexist but check for conflicts.`,
		);
	}
}

function resolveTargetClients(
	requested: ClientName[] | null,
	detected: ClientName[],
): ClientName[] {
	if (requested) return requested;
	if (detected.length > 0) return detected;
	return ["claude"];
}

interface InstallResultLike {
	client: ClientName;
	installed: boolean;
	events: string[];
	error?: string;
}

function printInstallResults(results: InstallResultLike[], detected: ClientName[]): number {
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
		if (detected.length === 0) {
			console.log(
				c.dim(
					"  No client directories (.claude/, .github/hooks/, .gemini/, .codex/, .cursor/) found.",
				),
			);
			console.log(
				c.dim(
					"  Use --clients claude,copilot,gemini,codex,cursor to force installation.",
				),
			);
		}
	}
	return installedCount;
}

function configureStatusLine(targetClients: ClientName[]): void {
	const statusLineClients = targetClients.filter((client) =>
		STATUS_LINE_CLIENTS.includes(client),
	);
	if (statusLineClients.length === 0) return;
	const statusLinePath = installStatusLine(statusLineClients);
	if (statusLinePath) {
		console.log(
			`\n${c.green("Configured")} status line for ${statusLineClients.join(", ")}: ${c.dim(statusLinePath)}`,
		);
	}
}

async function startHarnessIfNeeded(cwd: string): Promise<void> {
	if (isHarnessRunning(cwd).running) return;
	const harnessOpts = { daemon: true };
	try {
		await harnessStartCommand(harnessOpts);
	} catch {
		console.log(
			`\n${c.yellow("!")} Failed to start harness. Run: ${c.cyan("interlinked harness start --verbose")}`,
		);
	}
}

function noteUndetectedClients(
	detected: ClientName[],
	target: ClientName[],
	requested: ClientName[] | null,
): void {
	if (requested) return;
	const undetected = ALL_CLIENTS.filter(
		(name) => !detected.includes(name) && !target.includes(name),
	);
	if (undetected.length === 0) return;
	console.log(
		`\n${c.dim("Not detected:")} ${undetected.join(", ")} ${c.dim("(add with --clients)")}`,
	);
}

async function maybeScaffoldStructure(mode: string | undefined): Promise<void> {
	if (!mode) return;
	const structureOpts = { mode, write: true };
	try {
		const { structureInitCommand } = await import("./structure.js");
		await structureInitCommand(structureOpts);
	} catch (err) {
		console.log(
			`\n${c.yellow("!")} Structure scaffolding failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function printSummary(
	cwd: string,
	relativeHookPath: string,
	installedCount: number,
	targetClients: ClientName[],
): void {
	const config = resolveConfig(cwd);
	console.log(`\n${c.bold("Configuration:")}`);
	console.log(`  ${c.dim("Server:")}    ${config.server_url}`);
	console.log(`  ${c.dim("Config:")}    ${getConfigDir(cwd)}/`);
	console.log(`  ${c.dim("Hook:")}      ${relativeHookPath}`);
	if (config.agent_name) {
		console.log(`  ${c.dim("Agent:")}     ${config.agent_name}`);
	}
	console.log(`  ${c.dim("Sync:")}      ${config.sync_mode}`);

	if (config.access_token) {
		console.log(`  ${c.dim("Auth:")}      ${c.green("Authenticated")}`);
	} else {
		console.log(
			`  ${c.dim("Auth:")}      ${c.yellow("Not logged in")} — run ${c.cyan("interlinked login")}`,
		);
	}

	if (installedCount > 0) {
		console.log(
			`\n${c.green("Hooks are active.")} Agent activity is logged to ${c.cyan(".interlinked/activity.jsonl")}.`,
		);
		for (const note of buildPostEnableNotes(targetClients)) {
			console.log(`  ${c.dim(note)}`);
		}
	} else {
		console.log(
			`\n${c.yellow("Hooks are not active.")} No hook entries were installed. Re-run with ${c.cyan("--clients claude,copilot,gemini,codex,cursor")} or check client settings paths.`,
		);
	}
}

export function buildPostEnableNotes(targetClients: readonly ClientName[]): string[] {
	const notes: string[] = [];
	if (targetClients.includes("copilot")) {
		notes.push("Run `/skills reload` or restart Copilot CLI to load the newly installed repository skill.");
	}
	if (targetClients.includes("codex")) {
		notes.push("Restart Codex or open a new Codex session to load updated hooks.");
	}
	return notes;
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

	if (isConfigured(cwd)) {
		console.log(`${c.dim("Config:")}     Already exists at ${getConfigDir(cwd)}/`);
	} else {
		console.log(`${c.green("Create:")}     ${getConfigDir(cwd)}/config.json`);
	}

	if (hasLegacyConfig(cwd)) {
		console.log(`${c.yellow("Migrate:")}    .claude/interlinked-session.json -> .interlinked/`);
	}

	const hookPath = getHookScriptPath(cwd).replace(`${cwd}/`, "");
	console.log(`${c.green("Write:")}      ${hookPath}`);

	const detected = detectClients(cwd);
	const detectedNames = detected.filter((d) => d.exists).map((d) => d.name);
	const targetClients = resolveTargetClients(requestedClients, detectedNames);

	console.log(`\n${c.bold("Would install hooks for:")}`);
	for (const client of targetClients) {
		const isDetected = detectedNames.includes(client);
		const suffix = isDetected ? c.dim(" (detected)") : c.dim(" (forced)");
		const summary = CLIENT_SUMMARIES[client];
		if (summary) {
			console.log(`  ${c.bold(summary.label)} — ${summary.eventCountText}${suffix}`);
		}
	}

	console.log(`\n${c.bold("Would update .gitignore with:")}`);
	console.log("  .interlinked/config.local.json");
	console.log("  .interlinked/sessions/");

	const serverUrl = options.server || "http://localhost:8787";
	console.log(`\n${c.dim("Server:")} ${serverUrl}`);
	if (options.agent) {
		console.log(`${c.dim("Agent:")}  ${options.agent}`);
	}

	console.log(`\n${c.dim("Run without --dry-run to apply.")}`);
}
