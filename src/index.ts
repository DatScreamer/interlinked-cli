#!/usr/bin/env node
// ===========================================
// Interlinked CLI — Local companion: hooks, activity capture, guard evaluation, and developer observability
// ===========================================

import { readFileSync } from "node:fs";
import { Command, type OptionValues } from "commander";
import { activityCommand } from "./commands/activity.js";
import { attachCommand } from "./commands/attach.js";
import { cleanCommand } from "./commands/clean.js";
import { disableCommand } from "./commands/disable.js";
import { doctorCommand } from "./commands/doctor.js";
import { enableCommand } from "./commands/enable.js";
import { explainCommand } from "./commands/explain.js";
import { handleImplicitEntry } from "./commands/first-run.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { loginCommand } from "./commands/login.js";
import { resetCommand } from "./commands/reset.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { watchCommand } from "./commands/watch.js";
import { resolveAuthToken } from "./lib/auth.js";
import { c } from "./lib/formatter.js";
import { ensureRemoteOnboarding } from "./lib/onboarding.js";
import { getCachedUpdateNotice, maybeRefreshUpdateCache } from "./lib/update-check.js";

// Common option shapes for commander action callbacks.
// Commander passes OptionValues (Record<string, any>) to action handlers;
// these interfaces provide type safety without per-command boilerplate.
interface JsonOpts extends OptionValues {
	json?: boolean;
}
interface ViewOpts extends JsonOpts {
	short?: boolean;
	full?: boolean;
}

const program = new Command();

// Read version from package.json so it stays in sync with the package
function resolveVersion(): string {
	try {
		const pkgPath = new URL("../package.json", import.meta.url);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}
const CLI_VERSION = resolveVersion();

program
	.name("interlinked")
	.description("Interlinked CLI: local hooks, activity capture, and developer observability")
	.version(CLI_VERSION);

program.showHelpAfterError();
program.addHelpText(
	"afterAll",
	`
Interface boundaries:
  Interlinked CLI        local hooks, harness checks, activity capture, diagnostics
  Server                 optional remote tasks/messages/reservations/agent state
  Web UI (/chat, /map)   optional human oversight and coordination

Zero-arg behavior:
  interlinked            setup wizard (if unconfigured) or status dashboard

Quick start:
  interlinked install-hooks --runner claude-code    install local agent hooks
  interlinked harness start                         start local guard server
  interlinked status                                 dashboard
  interlinked login --server <url>                  optional server auth
`,
);

// ===========================================
// Commands (alphabetical order)
// ===========================================

program
	.command("activity")
	.description("Recent activity feed")
	.option("--agent <name>", "Filter by agent")
	.option("--limit <n>", "Max entries", "30")
	.option("--since <duration>", "e.g. 1h, 30m")
	.option("--json", "Machine-readable output")
	.action(activityCommand);

program
	.command("attach")
	.description("Attach local CLI settings to workspace/agent and link remote identity")
	.option("--server <url>", "Server URL")
	.option("--workspace <id>", "Active workspace ID (ws_...)")
	.option("--workspace-key <key>", "Default internal workspace_key for MCP tool calls")
	.option("--project <key>", "Default internal project_key for MCP tool calls")
	.option("--agent <name>", "Agent identity to attach")
	.option("--auto", "Derive workspace_key/project from git repo")
	.option("--json", "Machine-readable output")
	.action(attachCommand);

program
	.command("check")
	.description(
		"Scan project for structural issues and optionally run external tool checks (tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, etc.)",
	)
	.option(
		"--only <check>",
		"Run only a specific check (structural: broken-imports, cycles, duplicates, missing-tests, secrets, any-types, blast-radius, dead-imports; tools: tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, cargo-check, cargo-clippy, go-build, golangci-lint, c-compile, clang-tidy)",
	)
	.option(
		"--tools [list]",
		"Also run external tool checks (comma-separated, or omit for all available)",
	)
	.option("--report", "Show tool coverage/discovery report")
	.option("--json", "Machine-readable output")
	.option("--cwd <path>", "Project root (default: current directory)")
	.action(async (opts: OptionValues) => {
		const { checkCommand } = await import("./commands/check.js");
		await checkCommand(opts);
	});

const cpCmd = program.command("checkpoint").description("Git checkpoint management");

cpCmd
	.argument("[message]", "Checkpoint message")
	.option("--agent <name>", "Agent name")
	.option("--json", "Machine-readable output")
	.action(async (message: string | undefined, opts: { agent?: string; json?: boolean }) => {
		const { checkpointCommand } = await import("./commands/checkpoint.js");
		await checkpointCommand(message, opts);
	});

cpCmd
	.command("list")
	.description("List checkpoints")
	.option("--agent <name>", "Filter by agent")
	.option("--since <duration>", "e.g. 1h, 1d")
	.option("--limit <n>", "Max entries")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues, cmd: Command) => {
		const parentOpts = cmd.parent?.opts() || {};
		const merged = {
			...opts,
			json: opts.json || parentOpts.json,
			agent: opts.agent || parentOpts.agent,
		};
		const { checkpointListCommand } = await import("./commands/checkpoint.js");
		await checkpointListCommand(merged);
	});

cpCmd
	.command("show <id>")
	.description("Show checkpoint details")
	.option("--json", "Machine-readable output")
	.action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
		const parentOpts = cmd.parent?.opts() || {};
		const merged = { ...opts, json: opts.json || parentOpts.json };
		const { checkpointShowCommand } = await import("./commands/checkpoint.js");
		await checkpointShowCommand(id, merged);
	});

cpCmd
	.command("compare <id1> <id2>")
	.description("Diff two checkpoints")
	.option("--json", "Machine-readable output")
	.action(async (id1: string, id2: string, opts: { json?: boolean }, cmd: Command) => {
		const parentOpts = cmd.parent?.opts() || {};
		const merged = { ...opts, json: opts.json || parentOpts.json };
		const { checkpointCompareCommand } = await import("./commands/checkpoint.js");
		await checkpointCompareCommand(id1, id2, merged);
	});

cpCmd
	.command("prune")
	.description("Remove old checkpoints")
	.option("--older-than <days>", "Remove checkpoints older than N days")
	.option("--keep-latest <n>", "Keep the N most recent checkpoints")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues, cmd: Command) => {
		const parentOpts = cmd.parent?.opts() || {};
		const merged = { ...opts, json: opts.json || parentOpts.json };
		const { checkpointPruneCommand } = await import("./commands/checkpoint.js");
		await checkpointPruneCommand(merged);
	});

cpCmd
	.command("archive")
	.description("Archive old stash checkpoints to metadata-only")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues, cmd: Command) => {
		const parentOpts = cmd.parent?.opts() || {};
		const merged = { ...opts, json: opts.json || parentOpts.json };
		const { checkpointArchiveCommand } = await import("./commands/checkpoint.js");
		await checkpointArchiveCommand(merged);
	});

program
	.command("clean")
	.description("Remove stale data")
	.option("--dry-run", "Show what would be removed (default)")
	.option("--force", "Actually delete")
	.option("--json", "Machine-readable output")
	.action(cleanCommand);

program
	.command("completions <shell>")
	.description("Output shell completion script (bash, zsh, fish)")
	.action(async (shell: string) => {
		const { completionsCommand } = await import("./commands/completions.js");
		await completionsCommand(shell);
	});

program
	.command("context")
	.description("Show effective configuration (merged from all sources)")
	.option("--json", "Machine-readable output")
	.option("--short", "One-line summary")
	.option("--full", "Detailed output")
	.action(async (opts: ViewOpts) => {
		const { contextCommand } = await import("./commands/context.js");
		await contextCommand(opts);
	});

program
	.command("disable")
	.description("Remove hooks and optionally clean config")
	.option("--keep-config", "Preserve .interlinked/ config files")
	.action(disableCommand);

program
	.command("doctor")
	.description("Diagnose issues (local + server checks)")
	.option("--fix", "Auto-fix what's possible")
	.option("--json", "Machine-readable output")
	.action(doctorCommand);

program
	.command("enable")
	.description("Install hooks + create .interlinked/ config")
	.option("--server <url>", "Server URL")
	.option("--agent <name>", "Default agent name")
	.option("--clients <list>", "Comma-separated client list (claude,gemini,codex)")
	.option("--sync-mode <mode>", "Sync mode: realtime (default), local, manual")
	.option("--data-dir <path>", "Override data directory for activity logs and sessions")
	.option("--dry-run", "Show what would change without modifying files")
	.option("--structure <mode>", "Scaffold structure manifests: minimal, standard, strict")
	.action(enableCommand);

program
	.command("env")
	.description("Show supported environment variables and their current values")
	.option("--json", "Machine-readable output")
	.option("--short", "One-line summary")
	.option("--full", "Detailed output")
	.action(async (opts: ViewOpts) => {
		const { envCommand } = await import("./commands/env.js");
		await envCommand(opts);
	});

program
	.command("explain")
	.description("Reconstruct what happened (narrative view)")
	.option("--agent <name>", "Filter by agent")
	.option("--since <duration>", "Time window", "1h")
	.option("--full", "Include event detail")
	.option("--json", "Machine-readable output")
	.action(explainCommand);

const gitCmd = program.command("git").description("Git bridge: metadata, trailers, and notes");

gitCmd
	.command("context")
	.description("Show Interlinked metadata for HEAD or a commit")
	.option("--commit <sha>", "Specific commit (default: HEAD)")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { gitContextCommand } = await import("./commands/git.js");
		await gitContextCommand(opts);
	});

gitCmd
	.command("link-checkpoint")
	.description("Link a server checkpoint to a git commit")
	.option("--checkpoint <id>", "Checkpoint ID (default: latest)")
	.option("--commit <sha>", "Commit SHA (default: HEAD)")
	.option("--apply", "Apply trailers and notes to HEAD (amends commit)")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { gitLinkCheckpointCommand } = await import("./commands/git.js");
		await gitLinkCheckpointCommand(opts);
	});

const guardCmd = program.command("guard").description("File reservation enforcement via git hooks");

guardCmd
	.command("install")
	.description("Install pre-commit hook for reservation checks")
	.option("--mode <mode>", "warn (default) or block", "warn")
	.option("--pre-push", "Also install pre-push hook")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { guardInstallCommand } = await import("./commands/guard.js");
		await guardInstallCommand(opts);
	});

guardCmd
	.command("check")
	.description("Check files against active reservations")
	.option("--files <paths...>", "File paths to check (default: staged files)")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { guardCheckCommand } = await import("./commands/guard.js");
		await guardCheckCommand(opts);
	});

guardCmd
	.command("status")
	.description("Show guard configuration and hook status")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { guardStatusCommand } = await import("./commands/guard.js");
		await guardStatusCommand(opts);
	});

guardCmd
	.command("uninstall")
	.description("Remove guard hooks")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { guardUninstallCommand } = await import("./commands/guard.js");
		await guardUninstallCommand(opts);
	});

const reminderCmd = program
	.command("reminder")
	.description("File reminder management (warnings when files are touched)");

reminderCmd
	.command("add")
	.description("Add a file reminder")
	.requiredOption("--glob <pattern>", "File glob pattern to match")
	.requiredOption("--message <text>", "Reminder message")
	.option("--ops <list>", "Comma-separated operations (Edit,Write,Read)")
	.option("--once", "Fire once per session (default)", true)
	.option("--no-once", "Fire every time the file is touched")
	.option("--id <id>", "Stable ID (auto-generated from glob if omitted)")
	.option("--team", "Write to guard-rules.json instead of local")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { reminderAddCommand } = await import("./commands/reminder.js");
		reminderAddCommand(opts);
	});

reminderCmd
	.command("list", { isDefault: true })
	.description("List active file reminders")
	.option("--json", "Machine-readable output")
	.option("--short", "One-line summary")
	.option("--full", "Detailed output")
	.action(async (opts: OptionValues) => {
		const { reminderListCommand } = await import("./commands/reminder.js");
		reminderListCommand(opts);
	});

reminderCmd
	.command("remove [id-or-glob]")
	.description("Remove a file reminder by id or glob")
	.option("--team", "Remove from guard-rules.json instead of local")
	.option("--all", "Remove all reminders")
	.option("--json", "Machine-readable output")
	.action(async (idOrGlob: string | undefined, opts: OptionValues) => {
		const { reminderRemoveCommand } = await import("./commands/reminder.js");
		reminderRemoveCommand(idOrGlob, opts);
	});

program
	.command("handoff <from-agent> <to-agent>")
	.description("Explicit agent-to-agent handoff with context transfer")
	.option("--include-files", "Include file context in handoff")
	.option("--json", "Machine-readable output")
	.action(async (from: string, to: string, opts: OptionValues) => {
		const { handoffCommand } = await import("./commands/handoff.js");
		await handoffCommand(from, to, opts);
	});

const harnessCmd = program
	.command("harness")
	.description("Local harness server: guard evaluation, auto-reservations, agent lifecycle");

harnessCmd
	.command("start")
	.description("Start the harness server (background daemon by default)")
	.option("--no-daemon", "Run in foreground instead of background")
	.option("--verbose", "Verbose logging")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { harnessStartCommand } = await import("./commands/harness.js");
		await harnessStartCommand(opts);
	});

harnessCmd
	.command("stop")
	.description("Stop the harness server")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { harnessStopCommand } = await import("./commands/harness.js");
		await harnessStopCommand(opts);
	});

harnessCmd
	.command("restart")
	.description("Stop and restart the harness server (picks up config changes)")
	.option("--no-daemon", "Run in foreground instead of daemon")
	.option("--verbose", "Verbose output")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { harnessRestartCommand } = await import("./commands/harness.js");
		await harnessRestartCommand(opts);
	});

harnessCmd
	.command("status")
	.description("Show harness status, loaded rules, and active agents")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { harnessStatusCommand } = await import("./commands/harness.js");
		await harnessStatusCommand(opts);
	});

harnessCmd
	.command("test <command>")
	.description("Test a command against guard rules without executing")
	.option("--tool <name>", "Tool name to simulate (default: Bash)", "Bash")
	.option("--json", "Machine-readable output")
	.action(async (command: string, opts: OptionValues) => {
		const { harnessTestCommand } = await import("./commands/harness.js");
		await harnessTestCommand(command, opts);
	});

program
	.command("inbox")
	.description("Show recent messages from the server")
	.option("--all", "Show all messages (default: unread only)")
	.option("--agent <name>", "Filter by recipient agent")
	.option("--limit <n>", "Max entries")
	.option("--since <duration>", "e.g. 1h, 30m")
	.option("--json", "Machine-readable output")
	.option("--short", "One-line summary")
	.option("--full", "Detailed output")
	.action(async (opts: OptionValues) => {
		const { inboxCommand } = await import("./commands/inbox.js");
		await inboxCommand(opts);
	});

registerIndexCommand(program);

program
	.command("init")
	.description("One-command onboarding: detect clients, configure, login, verify")
	.option("--server <url>", "Server URL")
	.option("--agent <name>", "Agent name")
	.option("--sync-mode <mode>", "Sync mode: realtime (default), local, manual")
	.option("--dry-run", "Show what would change without modifying files")
	.option("--json", "Machine-readable output")
	.option("-y, --yes", "Accept all defaults without prompting")
	.action(async (opts: OptionValues) => {
		const { initCommand } = await import("./commands/init.js");
		await initCommand(opts);
	});

program
	.command("login")
	.description("Authenticate with the server (opens browser)")
	.option("--server <url>", "Server URL")
	.option("--token <token>", "Manual token for CI/headless use")
	.action(loginCommand);

program
	.command("logout")
	.description("Clear authentication credentials (preserves other config)")
	.option("--all", "Also clear agent handle (requires re-registration)")
	.option("--json", "Machine-readable output")
	.action(async (opts: JsonOpts) => {
		const { logoutCommand } = await import("./commands/logout.js");
		await logoutCommand(opts);
	});

program
	.command("logs")
	.description("View local activity log (offline, no server needed)")
	.option("-f, --follow", "Follow mode (like tail -f)")
	.option("--agent <name>", "Filter by agent name")
	.option("--tool <name>", "Filter by tool name")
	.option("--type <type>", "Filter by event type")
	.option("--since <duration>", "Show events from last duration (e.g. 5m, 1h)")
	.option("--limit <n>", "Max events to show (default: 20)")
	.option("--raw", "Show raw JSON per line")
	.option("--json", "Machine-readable output")
	.option("--short", "Compact output")
	.action(async (opts: OptionValues) => {
		const { logsCommand } = await import("./commands/logs.js");
		await logsCommand(opts);
	});

program
	.command("multi-edit [path]")
	.description(
		"Apply N old/new string edits atomically to one or more files. Gate runs once on final content. Ambiguity evaluated after prior edits.",
	)
	.option("--stdin", "Read a single-file manifest ({version,edits}) from stdin (requires <path>)")
	.option(
		"--manifest <file>",
		"Read a single- or multi-file manifest ({version,edits} or {version,batches}) from <file>",
	)
	.option("--json", "Machine-readable output (emits the design-doc error-code shape)")
	.action(async (path: string | undefined, opts: OptionValues) => {
		const { multiEditCommand } = await import("./commands/multi-edit.js");
		await multiEditCommand(path, opts);
	});

program
	.command("reset")
	.description("Nuclear: clear all local state")
	.option("--force", "Required to confirm")
	.option("--json", "Machine-readable output")
	.action(resetCommand);

program
	.command("resume [checkpoint-id]")
	.description("Resume from latest or specified checkpoint with context")
	.option("--agent <name>", "Filter by agent")
	.option("--json", "Machine-readable output")
	.action(async (id: string | undefined, opts: OptionValues) => {
		const { resumeCommand } = await import("./commands/resume.js");
		await resumeCommand(id, opts);
	});

program
	.command("rewind [checkpoint-id]")
	.description("Restore working tree to a checkpoint state")
	.option("--force", "Discard uncommitted changes")
	.option("--list", "List checkpoints (shorthand)")
	.option("--json", "Machine-readable output")
	.action(async (id: string | undefined, opts: OptionValues) => {
		const { rewindCommand } = await import("./commands/rewind.js");
		await rewindCommand(id, opts);
	});

program
	.command("search <query>")
	.description("Search the local codebase (ripgrep with native fallback)")
	.option("--path <dir>", "Search root directory (default: cwd)")
	.option("--glob <pattern>", "File glob pattern (e.g. '*.ts')")
	.option("--type <type>", "File type filter for ripgrep (e.g. ts, py, rust)")
	.option("--limit <n>", "Max results (default: 30, max: 200)")
	.option("--context <n>", "Context lines around matches (default: 2)")
	.option("--engine <engine>", "Force engine: ripgrep or native")
	.option("--json", "Machine-readable output")
	.option("--short", "One-line summary")
	.option("--full", "Full output with context lines")
	.action(async (query: string, opts: OptionValues) => {
		const { searchCommand } = await import("./commands/search.js");
		await searchCommand(query, opts);
	});

program
	.command("send <to> [message]")
	.description("Send a message to an agent")
	.option("--file <path>", "Send file contents as message body")
	.option("--importance <level>", "Message importance: normal, urgent")
	.option("--json", "Machine-readable output")
	.action(async (to: string, message: string | undefined, opts: OptionValues) => {
		const { sendCommand } = await import("./commands/send.js");
		await sendCommand(to, message, opts);
	});

program
	.command("setup")
	.description("One-command setup: install hooks, configure server, authenticate")
	.option("--server <url>", "Server URL")
	.option("--agent <name>", "Default agent name")
	.option("--clients <list>", "Comma-separated client list (claude,gemini,codex)")
	.option("--sync-mode <mode>", "Sync mode: realtime (default), local, manual")
	.option("--token <token>", "Manual token for CI/headless use")
	.option("--dry-run", "Show what would change without modifying files")
	.action(async (opts: OptionValues) => {
		await enableCommand({
			server: opts.server,
			agent: opts.agent,
			clients: opts.clients,
			syncMode: opts.syncMode,
			dryRun: opts.dryRun,
		});

		if (opts.dryRun) return;

		if (opts.token) {
			await loginCommand({ server: opts.server, token: opts.token });
			return;
		}

		if (resolveAuthToken()) {
			console.log(c.dim("\nAuth token already present. Skipping login."));
			const onboarding = await ensureRemoteOnboarding({ serverUrl: opts.server });
			if (onboarding.status === "linked") {
				console.log(
					c.dim(
						`Remote agent linked: ${onboarding.agentName || "agent"}${
							onboarding.agentHandle ? ` (${onboarding.agentHandle})` : ""
						}`,
					),
				);
			}
			return;
		}

		await loginCommand({ server: opts.server });
	});

program
	.command("status")
	.description("Dashboard: local sessions, recent activity, sync status")
	.option("--short", "One-line summary")
	.option("--full", "Per-session detail with tools and files")
	.option("--json", "Machine-readable output")
	.option("--watch [seconds]", "Auto-refresh interval (default 10s)")
	.action(statusCommand);

program
	.command("sync")
	.description("Push locally-buffered events to the server")
	.option("--dry-run", "Show what would be synced without sending")
	.option("--limit <n>", "Max events to sync")
	.option("--json", "Machine-readable output")
	.action(syncCommand);

const tasksCmd = program
	.command("tasks")
	.description("Task management via the server");

tasksCmd
	.command("list", { isDefault: true })
	.description("List tasks")
	.option("--status <status>", "Filter by status")
	.option("--assignee <name>", "Filter by assignee")
	.option("--priority <level>", "Filter by priority")
	.option("--limit <n>", "Max entries")
	.option("--json", "Machine-readable output")
	.option("--short", "One-line summary")
	.option("--full", "Detailed output")
	.action(async (opts: OptionValues) => {
		const { tasksListCommand } = await import("./commands/tasks.js");
		await tasksListCommand(opts);
	});

tasksCmd
	.command("create <title>")
	.description("Create a new task")
	.option("--description <text>", "Task description")
	.option("--assignee <name>", "Assign to agent")
	.option("--priority <level>", "Task priority")
	.option("--json", "Machine-readable output")
	.action(async (title: string, opts: OptionValues) => {
		const { tasksCreateCommand } = await import("./commands/tasks.js");
		await tasksCreateCommand(title, opts);
	});

tasksCmd
	.command("show <id>")
	.description("Show task detail")
	.option("--json", "Machine-readable output")
	.action(async (id: string, opts: OptionValues) => {
		const { tasksShowCommand } = await import("./commands/tasks.js");
		await tasksShowCommand(id, opts);
	});

tasksCmd
	.command("claim <id>")
	.description("Claim a task")
	.option("--json", "Machine-readable output")
	.action(async (id: string, opts: OptionValues) => {
		const { tasksClaimCommand } = await import("./commands/tasks.js");
		await tasksClaimCommand(id, opts);
	});

tasksCmd
	.command("complete <id>")
	.description("Mark a task as complete")
	.option("--json", "Machine-readable output")
	.action(async (id: string, opts: OptionValues) => {
		const { tasksCompleteCommand } = await import("./commands/tasks.js");
		await tasksCompleteCommand(id, opts);
	});

const traceCmd = program.command("trace").description("Agent trace export/import");

traceCmd
	.command("export")
	.description("Export local activity as agent trace")
	.option("--since <duration>", "e.g. 1h, 1d")
	.option("--agent <name>", "Filter by agent")
	.option("--output <file>", "Output file (default: stdout)")
	.option("--format <fmt>", "Format: json (default) or jsonl")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { traceExportCommand } = await import("./commands/trace.js");
		await traceExportCommand(opts);
	});

traceCmd
	.command("import <file>")
	.description("Import trace file into local activity")
	.option("--json", "Machine-readable output")
	.action(async (file: string, opts: OptionValues) => {
		const { traceImportCommand } = await import("./commands/trace.js");
		await traceImportCommand(file, opts);
	});

program
	.command("update")
	.alias("upgrade")
	.description("Update guidance for npm installs; pull/rebuild source checkouts")
	.option("--force", "Pull even with uncommitted changes")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { updateCommand } = await import("./commands/update.js");
		await updateCommand(opts);
	});

program
	.command("verify [target]")
	.description(
		"Run tsc + biome on a project and report errors. Target can be a local path, GitHub URL, or any git remote URL.",
	)
	.option("--only <tool>", "Run only tsc or biome (e.g., --only tsc)")
	.option("--suggestions", "Also run scored regex heuristics (sql-injection, perf, quality)")
	.option("--json", "Machine-readable output")
	.option("--details", "Show per-file details for all findings")
	.option("--cwd <path>", "Project root (default: current directory)")
	.option("--branch <ref>", "Branch, tag, or commit to check (remote repos)")
	.option("--subdir <path>", "Only scan a subdirectory (useful for monorepos)")
	.option(
		"--skip <checks>",
		"Skip specific checks (comma-separated: semgrep,knip,complexity,silent_catches,...)",
	)
	.option("--suppress <entries...>", "Suppress a finding: file:check or file:check:reason")
	.option("--show-suppressions", "List all active suppressions")
	.option("--structure", "Include generic artifact structure checks")
	.option("--structure-only", "Run only structure checks")
	.option("--adoption-gate", "Fail when adopted categories drop below thresholds")
	.option(
		"--all-checks",
		"Include broad advisory smell checks and dead-code scans in addition to the default high-signal audit",
	)
	.action(async (target: string | undefined, opts: OptionValues) => {
		const { verifyCommand } = await import("./commands/verify.js");
		await verifyCommand({ ...opts, target });
	});

program
	.command("version")
	.description("Show Interlinked CLI + server version")
	.action(async () => {
		const { getClient } = await import("./lib/api-client.js");
		console.log(`Interlinked CLI v${CLI_VERSION}`);
		try {
			const client = getClient();
			const result = await client.callTool<{ status?: string }>("health_check");
			console.log(
				`Server: ${client.getConfig().server_url} (${result.status || "ok"})`,
			);
		} catch {
			console.log(
				`Server: ${getClient().getConfig().server_url} (unreachable or not authenticated)`,
			);
		}
	});

program
	.command("watch")
	.description("Monitor server for pending work (messages, tasks, agents)")
	.option("--interval <seconds>", "Refresh interval (default 10s)")
	.option("--short", "One-line summary")
	.option("--json", "Machine-readable output")
	.action(watchCommand);

// `interlinked write` routes Bash-mediated file writes through the full
// content-quality pipeline (pre_block registry, biome diff-overlay, tsc
// diff-overlay). The Bash pre_block rule BLOCKS naive `node -e
// fs.writeFileSync(...)` / `cat > file.ts` / `sed -i` / `tee` invocations
// against tracked source files; this command is the supported escape
// hatch for coordinated multi-site atomic edits (add an import AND use
// it in the same landing) that would trip the diff-overlay if staged as
// two separate Edit calls. See
// `docs/design/bash-writes-through-content-gates.md`.
program
	.command("write [path]")
	.description(
		"Write file(s) through the content-quality gate (pre_block + biome + tsc diff-overlay). Supports --stdin, --from-file, and --batch <manifest.json> for atomic multi-file writes.",
	)
	.option("--stdin", "Read content from stdin (single-file mode)")
	.option("--from-file <src>", "Read content from a source file (single-file mode)")
	.option(
		"--batch <manifest>",
		"Path to a batch manifest JSON {version:1, writes:[{path,content}]}",
	)
	.option("--unsafe-outside-repo", "Allow writing outside the project root (discouraged)")
	.option("--json", "Machine-readable output")
	.action(async (path: string | undefined, opts: OptionValues) => {
		const { writeCommand } = await import("./commands/write.js");
		await writeCommand(path, opts);
	});

// Structure: generic artifact structure management
const structCmd = program
	.command("structure")
	.description("Generic artifact structure management (manifests, catalogs, adoption)");

structCmd
	.command("init")
	.description("Create interlinked/structure.json and scaffold artifact files")
	.option("--mode <mode>", "Structure mode: minimal, standard, strict", "standard")
	.option("--with <categories>", "Comma-separated artifact categories to scaffold")
	.option("--write", "Actually write files (default is dry-run)")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { structureInitCommand } = await import("./commands/structure.js");
		await structureInitCommand(opts);
	});

structCmd
	.command("scan")
	.description("Build or refresh local generated artifact catalogs")
	.option("--full", "Force full rescan")
	.option("--incremental", "Only refresh changed categories")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { structureScanCommand } = await import("./commands/structure.js");
		await structureScanCommand(opts);
	});

structCmd
	.command("status")
	.description("Show adoption coverage, cache staleness, and invalid references")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { structureStatusCommand } = await import("./commands/structure.js");
		await structureStatusCommand(opts);
	});

structCmd
	.command("accept")
	.description("Promote extracted findings into committed artifact files")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { structureAcceptCommand } = await import("./commands/structure.js");
		await structureAcceptCommand(opts);
	});

structCmd
	.command("doctor")
	.description("Validate structure files, cache freshness, and cross-references")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { structureDoctorCommand } = await import("./commands/structure.js");
		await structureDoctorCommand(opts);
	});

structCmd
	.command("baseline <action>")
	.description("Manage structure baselines (save, clear, status)")
	.option("--json", "Machine-readable output")
	.action(async (action: string, opts: OptionValues) => {
		const { structureBaselineCommand } = await import("./commands/structure.js");
		await structureBaselineCommand(action, opts);
	});

const wsCmd = program.command("workspace").description("Registry workspace management (ws_ IDs)");

wsCmd
	.command("list")
	.description("Show workspaces")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { workspaceListCommand } = await import("./commands/workspace.js");
		await workspaceListCommand(opts);
	});

wsCmd
	.command("switch <id>")
	.description("Change active workspace")
	.action(async (id: string) => {
		const { workspaceSwitchCommand } = await import("./commands/workspace.js");
		await workspaceSwitchCommand(id);
	});

// ===========================================
// Coverage ratchet — per-file coverage-delta gate
// ===========================================
const coverageCmd = program
	.command("coverage")
	.description("Per-file coverage ratchet — fails on any file whose coverage drops");

coverageCmd
	.command("check", { isDefault: true })
	.description("Compare current coverage against baseline and exit non-zero on any per-file drop")
	.option("--summary <path>", "Path to coverage-summary.json", "coverage/coverage-summary.json")
	.option(
		"--baseline <path>",
		"Path to baseline (defaults to .interlinked/coverage-baseline.json)",
	)
	.option("--update-baseline", "Persist the current coverage as the new baseline")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { coverageCheckCommand } = await import("./commands/coverage.js");
		await coverageCheckCommand(opts);
	});

coverageCmd
	.command("baseline")
	.description("Show the current coverage baseline")
	.option("--json", "Machine-readable output")
	.action(async (opts: { json?: boolean }) => {
		const { coverageBaselineCommand } = await import("./commands/coverage.js");
		coverageBaselineCommand(opts);
	});

// ===========================================
// Daemons — list active harness daemons + health
// ===========================================
program
	.command("daemons")
	.description("List active harness daemons, PID liveness, socket paths, and health")
	.option("--json", "Machine-readable output")
	.option("--cleanup", "Remove orphan daemon records (dead PIDs)")
	.action(async (opts: OptionValues) => {
		const { daemonsCommand } = await import("./commands/daemons.js");
		await daemonsCommand(opts);
	});

// ===========================================
// install-hooks / uninstall-hooks — blessed install path (adapter-based, manifest-driven)
// ===========================================
program
	.command("install-hooks")
	.description("Install agent hooks for detected runners (adapter-based, manifest-driven)")
	.option(
		"--runner <list>",
		"Comma-separated runners (claude-code,copilot-cli,cursor,gemini-cli,codex); defaults to auto-detect",
	)
	.option("--scope <scope>", "Install scope: user, project, or local", "project")
	.option("--mode <mode>", "Enforcement preset: balanced, strict, lenient", "balanced")
	.option("--binary <path>", "Override path to the interlinked binary")
	.option("--dry-run", "Show what would change without writing")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { installHooksCommand } = await import("./commands/install-hooks.js");
		await installHooksCommand(opts);
	});

program
	.command("uninstall-hooks")
	.description("Remove hooks previously installed via install-hooks (manifest-driven)")
	.option(
		"--runner <list>",
		"Comma-separated runners to target; defaults to every runner in the manifest",
	)
	.option("--dry-run", "Show what would change without writing")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { uninstallHooksCommand } = await import("./commands/uninstall-hooks.js");
		await uninstallHooksCommand(opts);
	});

// ===========================================
// Mode — show / switch enforcement preset
// ===========================================
program
	.command("mode [name]")
	.description("Show current enforcement mode, or switch to balanced / strict / lenient")
	.option("--diff", "Preview changes without writing")
	.option("--local", "Write to the gitignored personal override instead of the shared config")
	.option("--force", "Skip confirmation prompts")
	.option("--json", "Machine-readable output")
	.action(async (name: string | undefined, opts: OptionValues) => {
		const { modeCommand } = await import("./commands/mode.js");
		await modeCommand(name, opts);
	});

// ===========================================
// Mutation ratchet — per-file mutation-score gate
// ===========================================
const mutationCmd = program
	.command("mutation")
	.description("Per-file mutation-score ratchet — fails on any file whose mutation score drops");

mutationCmd
	.command("check", { isDefault: true })
	.description("Compare the Stryker report against baseline and exit non-zero on any drop")
	.option("--report <path>", "Path to Stryker mutation.json", "reports/mutation/mutation.json")
	.option(
		"--baseline <path>",
		"Path to baseline (defaults to .interlinked/mutation-baseline.json)",
	)
	.option("--update-baseline", "Persist the current mutation scores as the new baseline")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { mutationCheckCommand } = await import("./commands/mutation.js");
		await mutationCheckCommand(opts);
	});

mutationCmd
	.command("baseline")
	.description("Show the current mutation-score baseline")
	.option("--json", "Machine-readable output")
	.action(async (opts: { json?: boolean }) => {
		const { mutationBaselineCommand } = await import("./commands/mutation.js");
		mutationBaselineCommand(opts);
	});

// ===========================================
// Telemetry — tail the local JSONL spool
// ===========================================
program
	.command("telemetry")
	.description("View or tail the local telemetry spool (.interlinked/offline-spool.jsonl)")
	.option("-f, --follow", "Tail the spool for new events (like tail -f)")
	.option("--limit <n>", "Show the last N events")
	.option("--spool <path>", "Override spool path")
	.option("--json", "Machine-readable output")
	.action(async (opts: OptionValues) => {
		const { telemetryShowCommand } = await import("./commands/telemetry.js");
		await telemetryShowCommand(opts);
	});

// ===========================================
// Parse and Execute
// ===========================================

// Sort top-level commands alphabetically in help output.
// Commander renders commands in registration order, so we sort the
// internal array just before parsing. This keeps help tidy even as
// new commands are added anywhere in this file.
(program.commands as Command[]).sort((a: Command, b: Command) => a.name().localeCompare(b.name()));

// Background: refresh the cached "latest on npm" version so the NEXT run
// can print a notice. Fire-and-forget — doesn't delay this invocation.
maybeRefreshUpdateCache();

// Print an update notice on clean exit if a newer version is cached. Writes
// to stderr so it doesn't pollute stdout JSON output. Suppressed in CI,
// non-TTY, tests, or when INTERLINKED_NO_UPDATE_CHECK=1.
process.on("beforeExit", () => {
	const notice = getCachedUpdateNotice(CLI_VERSION);
	if (notice) process.stderr.write(c.dim(notice));
});

if (!(await handleImplicitEntry())) {
	await program.parseAsync(process.argv);
}
