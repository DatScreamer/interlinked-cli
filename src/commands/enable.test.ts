// ===========================================
// enable command — behavioral coverage
// ===========================================
// Exercises every branch of enableCommand + its private helpers (reached only
// through the public command) and the dry-run printer:
//   - dry-run vs apply fork
//   - configured / not-configured announce
//   - legacy-config migrate (ok / skipped / absent)
//   - config create vs server-url update (unchanged / changed / no-flag)
//   - option flags (agent / sync-mode valid / sync-mode invalid → exit(1) /
//     data-dir)
//   - hook-manager detection notices
//   - target-client resolution (requested / detected / fallback-claude)
//   - per-client install rendering (installed / error / none) + zero-install
//     warning with and without detected dirs
//   - .gitignore update toggle
//   - status-line config (eligible / path-null / none-eligible)
//   - /enforce skill (installed / error / empty-targets / silent)
//   - harness autostart (already-running / starts / start-fails)
//   - undetected-client hint (suppressed when --clients given)
//   - structure scaffolding (none / ok / Error-throw / non-Error-throw)
//   - summary auth + agent + active/inactive forks + post-enable notes
//   - buildPostEnableNotes copilot/codex matrix
//
// Every module boundary the command crosses is mocked (../lib/config,
// ../lib/hooks, ../lib/settings, ../lib/skill-installers, ./harness,
// ./structure) plus node:fs for defense-in-depth, so the test asserts real
// output strings, side-effect calls, and exit codes without touching the
// filesystem or network. The formatter is left real and normalized via
// stripAnsi at read time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallResult } from "../lib/hook-types.js";
import type { ClientName } from "../lib/settings.js";
import type { SkillInstallResult } from "../lib/skill-installers.js";

// --- module boundary mocks ------------------------------------------------

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
	getConfigDir: vi.fn(),
	hasLegacyConfig: vi.fn(),
	initConfig: vi.fn(),
	isConfigured: vi.fn(),
	migrateLegacyConfig: vi.fn(),
	resolveConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));

vi.mock("../lib/guard-state.js", () => ({
	// Stub the re-arm so the enable suite never touches real marker files.
	clearGuardDisable: vi.fn(() => ({ cleared: [] })),
}));

vi.mock("../lib/hooks.js", () => ({
	detectHookManagers: vi.fn(),
	ensureGitignore: vi.fn(),
	getHookScriptPath: vi.fn(),
	installAllHooks: vi.fn(),
	installStatusLine: vi.fn(),
	writeHookScript: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({
	detectClients: vi.fn(),
}));

vi.mock("../lib/skill-installers.js", () => ({
	installEnforceSkill: vi.fn(),
}));

vi.mock("./harness.js", () => ({
	harnessStartCommand: vi.fn(),
	isHarnessRunning: vi.fn(),
}));

vi.mock("./structure.js", () => ({
	structureInitCommand: vi.fn(),
}));

import {
	getConfigDir,
	hasLegacyConfig,
	initConfig,
	isConfigured,
	migrateLegacyConfig,
	resolveConfig,
	updateLocalConfig,
} from "../lib/config.js";
import { stripAnsi } from "../lib/formatter.js";
import {
	detectHookManagers,
	ensureGitignore,
	getHookScriptPath,
	installAllHooks,
	installStatusLine,
	writeHookScript,
} from "../lib/hooks.js";
import { detectClients } from "../lib/settings.js";
import { installEnforceSkill } from "../lib/skill-installers.js";
import { buildPostEnableNotes, enableCommand } from "./enable.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";
import { structureInitCommand } from "./structure.js";

// --- shapes the source consumes from resolveConfig ------------------------

interface ConfigShape {
	server_url: string;
	sync_mode: string;
	agent_name?: string;
	access_token?: string;
}

// --- helpers --------------------------------------------------------------

const CWD = "/fake/project";

function install(client: ClientName, over: Partial<InstallResult> = {}): InstallResult {
	return { client, installed: false, events: [], ...over };
}

function detected(name: ClientName, exists: boolean) {
	return { name, settingsPath: `${CWD}/.${name}/settings.json`, exists };
}

function skill(client: ClientName, over: Partial<SkillInstallResult> = {}): SkillInstallResult {
	return { client, path: `${CWD}/skill/${client}`, installed: false, ...over };
}

function config(over: Partial<ConfigShape> = {}): ConfigShape {
	return { server_url: "http://localhost:8787", sync_mode: "realtime", ...over };
}

/** Concatenate every console.log argument into one ANSI-stripped blob. */
function logged(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls as unknown[][];
	return stripAnsi(calls.map((args) => args.join(" ")).join("\n"));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	// process.exit is reached on the invalid-sync-mode branch; throw so the
	// command unwinds at that point instead of running to completion.
	exitSpy = vi
		.spyOn(process, "exit")
		.mockImplementation(((code?: number) => {
			throw new Error(`process.exit:${code}`);
		}) as never);
	vi.spyOn(process, "cwd").mockReturnValue(CWD);

	// Conservative apply-path defaults; individual tests override as needed.
	vi.mocked(isConfigured).mockReturnValue(false);
	vi.mocked(hasLegacyConfig).mockReturnValue(false);
	vi.mocked(migrateLegacyConfig).mockReturnValue(false);
	vi.mocked(getConfigDir).mockReturnValue(`${CWD}/.interlinked`);
	vi.mocked(resolveConfig).mockReturnValue(config() as never);
	vi.mocked(detectHookManagers).mockReturnValue([]);
	vi.mocked(writeHookScript).mockReturnValue(`${CWD}/.interlinked/hooks/interlinked-activity.mjs`);
	vi.mocked(getHookScriptPath).mockReturnValue(
		`${CWD}/.interlinked/hooks/interlinked-activity.mjs`,
	);
	vi.mocked(detectClients).mockReturnValue([]);
	vi.mocked(installAllHooks).mockReturnValue([]);
	vi.mocked(ensureGitignore).mockReturnValue(false);
	vi.mocked(installStatusLine).mockReturnValue(null);
	vi.mocked(installEnforceSkill).mockReturnValue([]);
	vi.mocked(isHarnessRunning).mockReturnValue({ running: true, pid: 4242 } as never);
	vi.mocked(harnessStartCommand).mockResolvedValue(undefined);
	vi.mocked(structureInitCommand).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ==========================================================================
// dry-run printer
// ==========================================================================

describe("enableCommand — dry run", () => {
	it("prints the create/write plan and never touches apply-path side effects", async () => {
		vi.mocked(isConfigured).mockReturnValue(false);
		vi.mocked(hasLegacyConfig).mockReturnValue(false);
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);

		await enableCommand({ dryRun: true });

		const out = logged(logSpy);
		expect(out).toContain("Interlinked CLI — Enable (dry run)");
		expect(out).toContain("No files will be modified.");
		// Not configured → "Create" line, not "Already exists".
		expect(out).toContain(`Create:     ${CWD}/.interlinked/config.json`);
		expect(out).not.toContain("Already exists");
		// Hook path printed repo-relative (cwd prefix stripped).
		expect(out).toContain("Write:      .interlinked/hooks/interlinked-activity.mjs");
		// Detected client → "(detected)" suffix + its event summary.
		expect(out).toContain("claude — 13 events (all Claude Code hooks) (detected)");
		expect(out).toContain(".interlinked/config.local.json");
		expect(out).toContain(".interlinked/sessions/");
		// Default server URL when no --server.
		expect(out).toContain("Server: http://localhost:8787");
		expect(out).toContain("Run without --dry-run to apply.");
		// Apply-only side effects must be untouched.
		expect(vi.mocked(writeHookScript)).not.toHaveBeenCalled();
		expect(vi.mocked(installAllHooks)).not.toHaveBeenCalled();
		expect(vi.mocked(initConfig)).not.toHaveBeenCalled();
	});

	it("shows the already-exists + migrate lines and forced/custom-server details", async () => {
		vi.mocked(isConfigured).mockReturnValue(true);
		vi.mocked(hasLegacyConfig).mockReturnValue(true);
		// No detected clients → resolveTargetClients falls back to ["claude"],
		// which is therefore "(forced)" here.
		vi.mocked(detectClients).mockReturnValue([detected("claude", false)]);

		await enableCommand({
			dryRun: true,
			server: "https://example.test",
			agent: "scout",
		});

		const out = logged(logSpy);
		expect(out).toContain(`Config:     Already exists at ${CWD}/.interlinked/`);
		expect(out).toContain("Migrate:    .claude/interlinked-session.json -> .interlinked/");
		expect(out).toContain("claude — 13 events (all Claude Code hooks) (forced)");
		// Custom --server overrides the default URL; --agent line appears.
		expect(out).toContain("Server: https://example.test");
		expect(out).toContain("Agent:  scout");
	});

	it("renders every requested client's event summary via --clients", async () => {
		vi.mocked(detectClients).mockReturnValue([]);

		await enableCommand({ dryRun: true, clients: "copilot,gemini,codex,cursor" });

		const out = logged(logSpy);
		expect(out).toContain("copilot — 6 events (Copilot CLI hooks) (forced)");
		expect(out).toContain("gemini — 8 events (Gemini CLI hooks) (forced)");
		expect(out).toContain("codex — 6 events (.codex/hooks.json + [features] hooks=true flag)");
		expect(out).toContain("cursor — 15 events");
	});

	it("skips clients with no summary entry (guards the CLIENT_SUMMARIES lookup)", async () => {
		vi.mocked(detectClients).mockReturnValue([]);

		// "bogus" is not a real ClientName → CLIENT_SUMMARIES[client] is
		// undefined and the `if (summary)` guard must skip it without throwing.
		await enableCommand({ dryRun: true, clients: "bogus" });

		const out = logged(logSpy);
		expect(out).toContain("Would install hooks for:");
		// No event-summary line for the unknown client.
		expect(out).not.toContain("bogus — ");
	});
});

// ==========================================================================
// apply path — config announce / migrate / ensure
// ==========================================================================

describe("enableCommand — config lifecycle", () => {
	it("prints the header banner and creates config when unconfigured", async () => {
		vi.mocked(isConfigured).mockReturnValue(false);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Interlinked CLI — Enable Hook Management");
		expect(out).not.toContain("Already enabled.");
		expect(out).toContain("Created .interlinked/config.json");
		// initConfig called with empty opts when no --server.
		expect(vi.mocked(initConfig)).toHaveBeenCalledWith({}, CWD);
	});

	it("announces already-enabled and passes --server into initConfig when unconfigured", async () => {
		// isConfigured is consulted twice (announce + ensure). First call true
		// (announce), but ensureConfigPresent re-checks: return false there to
		// force the create branch with the server flag threaded through.
		vi.mocked(isConfigured)
			.mockReturnValueOnce(true) // announceConfigState
			.mockReturnValue(false); // ensureConfigPresent + later checks

		await enableCommand({ server: "https://s.test" });

		const out = logged(logSpy);
		expect(out).toContain("Already enabled.");
		expect(out).toContain("Updating hooks and config...");
		expect(vi.mocked(initConfig)).toHaveBeenCalledWith({ serverUrl: "https://s.test" }, CWD);
	});

	it("updates the server URL when configured and the flag differs", async () => {
		vi.mocked(isConfigured).mockReturnValue(true);
		vi.mocked(resolveConfig).mockReturnValue(config({ server_url: "http://old" }) as never);

		await enableCommand({ server: "http://new" });

		const out = logged(logSpy);
		expect(out).toContain("Updated Server URL to http://new");
		expect(vi.mocked(initConfig)).toHaveBeenCalledWith({ serverUrl: "http://new" }, CWD);
	});

	it("leaves the server URL untouched when configured and the flag matches", async () => {
		vi.mocked(isConfigured).mockReturnValue(true);
		vi.mocked(resolveConfig).mockReturnValue(config({ server_url: "http://same" }) as never);

		await enableCommand({ server: "http://same" });

		const out = logged(logSpy);
		expect(out).not.toContain("Updated Server URL");
		// Configured + matching server → initConfig never called.
		expect(vi.mocked(initConfig)).not.toHaveBeenCalled();
	});

	it("does nothing in ensureConfigPresent when configured and no --server", async () => {
		vi.mocked(isConfigured).mockReturnValue(true);

		await enableCommand({});

		expect(vi.mocked(initConfig)).not.toHaveBeenCalled();
		expect(logged(logSpy)).not.toContain("Created .interlinked/config.json");
	});

	it("migrates a legacy config and reports success", async () => {
		vi.mocked(hasLegacyConfig).mockReturnValue(true);
		vi.mocked(migrateLegacyConfig).mockReturnValue(true);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Legacy config detected:");
		expect(out).toContain("Migrated to .interlinked/config.json + config.local.json");
	});

	it("reports a skipped migration when the legacy config could not be read", async () => {
		vi.mocked(hasLegacyConfig).mockReturnValue(true);
		vi.mocked(migrateLegacyConfig).mockReturnValue(false);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Legacy config detected:");
		expect(out).toContain("Migration skipped (could not read legacy config)");
	});
});

// ==========================================================================
// apply path — option flags
// ==========================================================================

describe("enableCommand — option flags", () => {
	it("sets the agent name", async () => {
		await enableCommand({ agent: "nova" });

		expect(vi.mocked(updateLocalConfig)).toHaveBeenCalledWith({ agent_name: "nova" }, CWD);
		expect(logged(logSpy)).toContain("Set agent name: nova");
	});

	it("sets a valid sync mode", async () => {
		await enableCommand({ syncMode: "local" });

		expect(vi.mocked(updateLocalConfig)).toHaveBeenCalledWith({ sync_mode: "local" }, CWD);
		expect(logged(logSpy)).toContain("Set sync mode: local");
	});

	it("rejects an invalid sync mode and exits(1) before installing hooks", async () => {
		await expect(enableCommand({ syncMode: "turbo" })).rejects.toThrow("process.exit:1");

		const out = logged(logSpy);
		expect(out).toContain('Invalid sync mode "turbo"');
		expect(out).toContain("Must be one of: realtime, local, manual");
		expect(exitSpy).toHaveBeenCalledWith(1);
		// exit unwinds before the install phase.
		expect(vi.mocked(installAllHooks)).not.toHaveBeenCalled();
	});

	it("sets the data dir", async () => {
		await enableCommand({ dataDir: "/var/data" });

		expect(vi.mocked(updateLocalConfig)).toHaveBeenCalledWith({ data_dir: "/var/data" }, CWD);
		expect(logged(logSpy)).toContain("Set data dir: /var/data");
	});

	it("applies no option-flag updates when none are passed", async () => {
		await enableCommand({});

		expect(vi.mocked(updateLocalConfig)).not.toHaveBeenCalled();
	});
});

// ==========================================================================
// apply path — hook managers + target resolution + install rendering
// ==========================================================================

describe("enableCommand — hook managers + install results", () => {
	it("announces every detected external hook manager", async () => {
		vi.mocked(detectHookManagers).mockReturnValue([
			{ name: "husky", detected_at: ".husky/" },
			{ name: "lefthook", detected_at: "lefthook.yml" },
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Detected husky at .husky/");
		expect(out).toContain("Detected lefthook at lefthook.yml");
		expect(out).toContain("will coexist but check for conflicts");
	});

	it("writes the hook script and prints its repo-relative path", async () => {
		await enableCommand({});

		expect(vi.mocked(writeHookScript)).toHaveBeenCalledWith(CWD);
		expect(logged(logSpy)).toContain(
			"Wrote hook script: .interlinked/hooks/interlinked-activity.mjs",
		);
	});

	it("installs for detected clients when no --clients flag is given", async () => {
		vi.mocked(detectClients).mockReturnValue([
			detected("claude", true),
			detected("gemini", false),
			detected("codex", true),
		]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse", "PostToolUse"] }),
			install("codex", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		// Only the exists:true clients are targeted.
		expect(vi.mocked(installAllHooks)).toHaveBeenCalledWith(CWD, ["claude", "codex"]);
		const out = logged(logSpy);
		expect(out).toContain("claude — 2 event(s): PreToolUse, PostToolUse");
		expect(out).toContain("codex — 1 event(s): PreToolUse");
	});

	it("honors an explicit --clients list over detection", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("gemini", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({ clients: " Gemini , Cursor " });

		// Requested list is trimmed + lowercased and wins over detection.
		expect(vi.mocked(installAllHooks)).toHaveBeenCalledWith(CWD, ["gemini", "cursor"]);
	});

	it("falls back to claude when nothing is detected and no --clients given", async () => {
		vi.mocked(detectClients).mockReturnValue([]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		expect(vi.mocked(installAllHooks)).toHaveBeenCalledWith(CWD, ["claude"]);
	});

	it("renders error and no-op install lines distinctly", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
			install("copilot", { error: "permission denied" }),
			install("gemini"),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("claude — 1 event(s): PreToolUse");
		expect(out).toContain("copilot — permission denied");
		expect(out).toContain("gemini — no changes needed");
	});

	it("warns with the directory hint when nothing installs and nothing was detected", async () => {
		vi.mocked(detectClients).mockReturnValue([]);
		vi.mocked(installAllHooks).mockReturnValue([install("claude")]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Warning: No hooks were installed.");
		expect(out).toContain("No client directories");
		expect(out).toContain("Use --clients claude,copilot,gemini,codex,cursor");
	});

	it("warns WITHOUT the directory hint when clients were detected but none installed", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([install("claude", { error: "nope" })]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Warning: No hooks were installed.");
		// detected.length > 0 → the "No client directories" hint is suppressed.
		expect(out).not.toContain("No client directories");
	});
});

// ==========================================================================
// apply path — gitignore / status line / enforce skill
// ==========================================================================

describe("enableCommand — gitignore, status line, enforce skill", () => {
	it("announces a .gitignore update when one was written", async () => {
		vi.mocked(ensureGitignore).mockReturnValue(true);

		await enableCommand({});

		expect(logged(logSpy)).toContain("Updated .gitignore with Interlinked CLI local paths");
	});

	it("stays silent about .gitignore when nothing changed", async () => {
		vi.mocked(ensureGitignore).mockReturnValue(false);

		await enableCommand({});

		expect(logged(logSpy)).not.toContain("Updated .gitignore");
	});

	it("configures the status line for eligible clients and prints the path", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installStatusLine).mockReturnValue("/fake/project/.claude/statusline.sh");

		await enableCommand({});

		// claude is in STATUS_LINE_CLIENTS → installStatusLine gets the filtered set.
		expect(vi.mocked(installStatusLine)).toHaveBeenCalledWith(["claude"]);
		expect(logged(logSpy)).toContain(
			"Configured status line for claude: /fake/project/.claude/statusline.sh",
		);
	});

	it("filters status-line clients to the eligible subset (drops gemini/codex)", async () => {
		vi.mocked(detectClients).mockReturnValue([
			detected("claude", true),
			detected("copilot", true),
			detected("gemini", true),
			detected("codex", true),
		]);
		vi.mocked(installStatusLine).mockReturnValue("/fake/project/.claude/statusline.sh");

		await enableCommand({});

		// Only claude + copilot are STATUS_LINE_CLIENTS.
		expect(vi.mocked(installStatusLine)).toHaveBeenCalledWith(["claude", "copilot"]);
		expect(logged(logSpy)).toContain("Configured status line for claude, copilot:");
	});

	it("does not call installStatusLine when no eligible client is targeted", async () => {
		// Only gemini targeted → STATUS_LINE_CLIENTS filter is empty → early return.
		await enableCommand({ clients: "gemini" });

		expect(vi.mocked(installStatusLine)).not.toHaveBeenCalled();
		expect(logged(logSpy)).not.toContain("Configured status line");
	});

	it("stays silent when installStatusLine returns null despite eligible clients", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installStatusLine).mockReturnValue(null);

		await enableCommand({});

		expect(vi.mocked(installStatusLine)).toHaveBeenCalledWith(["claude"]);
		expect(logged(logSpy)).not.toContain("Configured status line");
	});

	it("announces /enforce skill installation with the invocation tip", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installEnforceSkill).mockReturnValue([
			skill("claude", { installed: true }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(vi.mocked(installEnforceSkill)).toHaveBeenCalledWith(CWD, ["claude"]);
		expect(out).toContain("Installed /enforce skill for claude");
		expect(out).toContain("Invoke as `/enforce <target>`");
	});

	it("reports the first error when no /enforce skill installs", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installEnforceSkill).mockReturnValue([
			skill("claude", { installed: false, error: "no SKILL.md found" }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("/enforce skill: not installed —");
		expect(out).toContain("no SKILL.md found");
		expect(out).not.toContain("Installed /enforce skill");
	});

	it("stays fully silent about the skill when nothing installed and no error surfaced", async () => {
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installEnforceSkill).mockReturnValue([skill("claude", { installed: false })]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).not.toContain("Installed /enforce skill");
		expect(out).not.toContain("/enforce skill: not installed");
	});

	it("always reaches installEnforceSkill on the normal path (target list is never empty)", async () => {
		// The `if (targetClients.length === 0) return;` guard in
		// installEnforceSkillForClients is unreachable through the public command:
		// resolveTargetClients always yields a non-empty list (requested split,
		// detected set, or the ["claude"] fallback), so installEnforceSkill is
		// always invoked. This pins that invariant; the empty-guard arm is dead
		// code from the CLI's perspective (see the uncovered-lines note).
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);

		await enableCommand({});

		expect(vi.mocked(installEnforceSkill)).toHaveBeenCalledWith(CWD, ["claude"]);
	});
});

// ==========================================================================
// apply path — harness autostart
// ==========================================================================

describe("enableCommand — harness autostart", () => {
	it("does not start the harness when it is already running", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: true, pid: 99 } as never);

		await enableCommand({});

		expect(vi.mocked(harnessStartCommand)).not.toHaveBeenCalled();
	});

	it("starts the harness as a daemon when it is not running", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as never);
		vi.mocked(harnessStartCommand).mockResolvedValue(undefined);

		await enableCommand({});

		expect(vi.mocked(harnessStartCommand)).toHaveBeenCalledWith({ daemon: true });
	});

	it("reports a recovery hint when harness start throws", async () => {
		vi.mocked(isHarnessRunning).mockReturnValue({ running: false } as never);
		vi.mocked(harnessStartCommand).mockRejectedValue(new Error("port in use"));

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Failed to start harness.");
		expect(out).toContain("interlinked harness start --verbose");
	});
});

// ==========================================================================
// apply path — undetected-client hint
// ==========================================================================

describe("enableCommand — undetected client hint", () => {
	it("lists undetected clients when relying on auto-detection", async () => {
		// Only claude detected → the other four are undetected.
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Not detected: copilot, gemini, codex, cursor");
		expect(out).toContain("(add with --clients)");
	});

	it("suppresses the undetected hint entirely when --clients is explicit", async () => {
		await enableCommand({ clients: "claude" });

		expect(logged(logSpy)).not.toContain("Not detected:");
	});

	it("prints no undetected hint when every client was detected", async () => {
		vi.mocked(detectClients).mockReturnValue([
			detected("claude", true),
			detected("copilot", true),
			detected("gemini", true),
			detected("codex", true),
			detected("cursor", true),
		]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		expect(logged(logSpy)).not.toContain("Not detected:");
	});
});

// ==========================================================================
// apply path — structure scaffolding
// ==========================================================================

describe("enableCommand — structure scaffolding", () => {
	it("does not scaffold structure when no --structure mode is given", async () => {
		await enableCommand({});

		expect(vi.mocked(structureInitCommand)).not.toHaveBeenCalled();
	});

	it("invokes structureInitCommand with write:true for the requested mode", async () => {
		vi.mocked(structureInitCommand).mockResolvedValue(undefined);

		await enableCommand({ structure: "strict" });

		expect(vi.mocked(structureInitCommand)).toHaveBeenCalledWith({
			mode: "strict",
			write: true,
		});
	});

	it("reports the Error message when structure scaffolding throws an Error", async () => {
		vi.mocked(structureInitCommand).mockRejectedValue(new Error("bad mode"));

		await enableCommand({ structure: "weird" });

		expect(logged(logSpy)).toContain("Structure scaffolding failed: bad mode");
	});

	it("stringifies a non-Error rejection from structure scaffolding", async () => {
		vi.mocked(structureInitCommand).mockRejectedValue("kaboom");

		await enableCommand({ structure: "weird" });

		expect(logged(logSpy)).toContain("Structure scaffolding failed: kaboom");
	});
});

// ==========================================================================
// apply path — final summary
// ==========================================================================

describe("enableCommand — summary block", () => {
	it("renders the full configuration block with agent + authenticated + active hooks", async () => {
		vi.mocked(resolveConfig).mockReturnValue(
			config({
				server_url: "https://srv",
				sync_mode: "manual",
				agent_name: "atlas",
				access_token: "tok",
			}) as never,
		);
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Server:    https://srv");
		expect(out).toContain(`Config:    ${CWD}/.interlinked/`);
		expect(out).toContain("Hook:      .interlinked/hooks/interlinked-activity.mjs");
		expect(out).toContain("Agent:     atlas");
		expect(out).toContain("Sync:      manual");
		expect(out).toContain("Auth:      Authenticated");
		expect(out).toContain("Hooks are active.");
		expect(out).toContain("Agent activity is logged to .interlinked/activity.jsonl");
	});

	it("omits the agent line and shows the not-logged-in prompt when no token", async () => {
		vi.mocked(resolveConfig).mockReturnValue(
			config({ server_url: "https://srv", sync_mode: "realtime" }) as never,
		);
		vi.mocked(detectClients).mockReturnValue([detected("claude", true)]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("claude", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).not.toContain("Agent:     ");
		expect(out).toContain("Auth:      Not logged in");
		expect(out).toContain("run interlinked login");
	});

	it("prints the inactive-hooks fork with the re-run hint when nothing installed", async () => {
		vi.mocked(detectClients).mockReturnValue([]);
		vi.mocked(installAllHooks).mockReturnValue([install("claude")]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Hooks are not active.");
		expect(out).toContain("No hook entries were installed.");
		expect(out).toContain("Re-run with");
		expect(out).not.toContain("Hooks are active.");
	});

	it("appends copilot + codex post-enable notes when those clients install", async () => {
		vi.mocked(detectClients).mockReturnValue([
			detected("copilot", true),
			detected("codex", true),
		]);
		vi.mocked(installAllHooks).mockReturnValue([
			install("copilot", { installed: true, events: ["PreToolUse"] }),
			install("codex", { installed: true, events: ["PreToolUse"] }),
		]);

		await enableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Run `/skills reload` or restart Copilot CLI");
		expect(out).toContain("Restart Codex or open a new Codex session");
	});
});

// ==========================================================================
// buildPostEnableNotes (exported helper)
// ==========================================================================

describe("buildPostEnableNotes", () => {
	it("returns the copilot note when copilot is among the clients", () => {
		expect(buildPostEnableNotes(["copilot"])).toEqual([
			"Run `/skills reload` or restart Copilot CLI to load the newly installed repository skill.",
		]);
	});

	it("returns the codex note when codex is among the clients", () => {
		expect(buildPostEnableNotes(["codex"])).toContain(
			"Restart Codex or open a new Codex session to load updated hooks.",
		);
	});

	it("returns both notes (copilot first, codex second) when both present", () => {
		expect(buildPostEnableNotes(["copilot", "codex"])).toEqual([
			"Run `/skills reload` or restart Copilot CLI to load the newly installed repository skill.",
			"Restart Codex or open a new Codex session to load updated hooks.",
		]);
	});

	it("returns an empty array for clients without notes", () => {
		expect(buildPostEnableNotes(["claude", "gemini", "cursor"])).toEqual([]);
	});
});
