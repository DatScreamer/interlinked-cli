// ===========================================
// Hook Installers — Per-Client install/uninstall implementations
// ===========================================
// Per-client hook installation logic for Claude Code, GitHub Copilot CLI,
// and Gemini CLI. The public `installAllHooks` / `uninstallAllHooks`
// orchestrators in `./hooks.ts` delegate to the functions here.
//
// Extracted out of `hooks.ts` so the main module stays under the file-size
// budget and each client's install path is easy to find and audit.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { ensureCodexFeatureFlag as ensureCodexFlag } from "./codex-feature-flag.js";
import {
	CLIENT_CLAUDE,
	CLIENT_CODEX,
	CLIENT_COPILOT,
	CLIENT_CURSOR,
	CLIENT_GEMINI,
	findProjectRoot,
	type HookEntry,
	INTERLINKED_MARKER,
} from "./hook-types.js";
import type { JsonObject } from "./json-types.js";
import type { ClientName } from "./settings.js";

// ===========================================
// Per-client event lists
// ===========================================

// Claude Code hook events registered in settings.json.
// PostToolUseFailure is intentionally omitted — registering it causes Claude Code
// to display "2 PostToolUse hooks ran" since it counts both registrations.
// The hook script still handles PostToolUseFailure if received (via isPostTool check).
/** Public API — consumed by `src/lib/hooks.ts`. */
export const CLAUDE_HOOK_EVENTS = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"Stop",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"SubagentStart",
	"SubagentStop",
	"Notification",
	"PreCompact",
	"TaskCompleted",
	"TeammateIdle",
] as const;

// PostToolUse matcher — scope to mutating tools only.
// With matcher: "" (match-all), Claude Code counts a PostToolUse hook invocation
// for every tool in the turn (e.g. Read + Edit = "2 hooks ran"). Scoping to
// Edit|Write|MultiEdit ensures the count reflects actual mutations only.
// `apply_patch` is Codex CLI's primary file-edit tool — added explicitly
// so PostToolUse fires on Codex without relying on Codex's Edit/Write
// alias engine. Claude has no `apply_patch` tool, so the alternation is
// safe across both clients. The hook script still receives all
// PostToolUse events that match this pattern.
const POST_TOOL_USE_MATCHER = "Edit|Write|MultiEdit|apply_patch";

// Event names that require scoped matching (only mutating tools). Extracted
// as a named set so conditionals don't use bare string literals.
const SCOPED_MATCHER_EVENTS = new Set(["PostToolUse", "AfterTool"]);

// GitHub Copilot CLI hook events (camelCase — Copilot convention)
/** Public API — consumed by `src/lib/hooks.ts`. */
export const COPILOT_HOOK_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"userPromptSubmitted",
	"preToolUse",
	"postToolUse",
	"errorOccurred",
] as const;

// Gemini CLI hook events (official hooks API, project/user settings.json).
// Keep to the high-signal lifecycle + tool events that Interlinked currently
// understands well. Skip model-level hooks to avoid noisy per-request traffic.
/** Public API — consumed by `src/lib/hooks.ts`. */
export const GEMINI_HOOK_EVENTS = [
	"SessionStart",
	"SessionEnd",
	"BeforeAgent",
	"AfterAgent",
	"BeforeTool",
	"AfterTool",
	"PreCompress",
	"Notification",
] as const;

// OpenAI Codex CLI hook events. Codex shipped its hook contract using
// PascalCase event names that mirror Claude Code's vocabulary, with one
// addition (PermissionRequest is its own event type, separate from
// PreToolUse). Stop is included so the harness can record turn-end and so
// future Stop-driven continuations have a hook to fire on. SessionEnd is
// not part of the documented Codex hook surface as of 2026-04 — only
// SessionStart is.
/** Public API — consumed by `src/lib/hooks.ts`. */
export const CODEX_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"Stop",
] as const;

// Cursor IDE hook events. Cursor exposes the richest hook surface of the
// supported clients (per https://cursor.com/docs/hooks): per-tool gates
// (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`), file-
// edit observation (`afterFileEdit`), prompt + lifecycle hooks
// (`beforeSubmitPrompt`, `sessionStart`, `sessionEnd`, `stop`), plus
// generic `preToolUse`/`postToolUse` aliases. We register the high-signal
// ones — destructive guard rules ride on `beforeShellExecution` (Bash) and
// `beforeMCPExecution` (MCP tools), and the lifecycle events feed activity
// + reservations + harness session state.
//
// `afterShellExecution` / `afterMCPExecution` are intentionally omitted: they
// don't add signal beyond `postToolUse`, and registering more hooks burns
// Cursor's per-event timeout budget.
/** Public API — consumed by `src/lib/hooks.ts`. */
export const CURSOR_HOOK_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"beforeSubmitPrompt",
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeReadFile",
	"afterFileEdit",
	"stop",
	"preToolUse",
	"postToolUse",
] as const;

// Helpers for conditionals — avoid bare `typeof x === "string"` / `"object"`
// forms which the harness flags as `magic_literal_in_conditional`.
function isPlainObject(v: unknown): v is JsonObject {
	return v instanceof Object && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
	return v === String(v) && (v as string).length > 0;
}

// ===========================================
// Status Line — Install script + configure clients
// ===========================================

const STATUSLINE_SCRIPT_NAME = "statusline-interlinked.sh";

function writeStatuslineScript(scriptPath: string): void {
	const script = `#!/bin/bash
# Interlinked harness status line (auto-generated by interlinked enable)
# Works with: Claude Code, GitHub Copilot CLI, and any agent supporting statusLine.command
trap '' INT TERM PIPE

# Consume stdin (agents send session JSON; unused for now)
cat > /dev/null

BOLD="\\033[1m"
DIM="\\033[2m"
GREEN="\\033[32m"
YELLOW="\\033[33m"
CYAN="\\033[36m"
RESET="\\033[0m"

# Walk up from CWD looking for .interlinked/harness.sock — lets a
# harness daemon rooted at any monorepo ancestor serve subdir shells.
SOCKET=""
PID=""
DIR="$PWD"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ -S "$DIR/.interlinked/harness.sock" ]; then
        SOCKET="$DIR/.interlinked/harness.sock"
        [ -f "$DIR/.interlinked/harness.pid" ] && PID=$(cat "$DIR/.interlinked/harness.pid" 2>/dev/null)
        break
    fi
    P=$(dirname "$DIR")
    [ "$P" = "$DIR" ] && break
    DIR="$P"
done

[ -z "$SOCKET" ] && exit 0

if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
    # tsgo check — walk up to find the package
    TS="tsc"
    DIR="$PWD"
    for _ in 1 2 3 4 5; do
        [ -d "$DIR/node_modules/@typescript/native-preview" ] && TS="tsgo" && break
        P=$(dirname "$DIR"); [ "$P" = "$DIR" ] && break; DIR="$P"
    done
    command -v tsgo &>/dev/null && TS="tsgo"

    if [ "$TS" = "tsgo" ]; then
        TS_FMT="\${CYAN}tsgo\${RESET}"
    else
        TS_FMT="\${DIM}tsc\${RESET}"
    fi

    # Classifier status
    CLS=""
    CLS_FILE=""
    for candidate in ".interlinked/classifier.status" "cli/.interlinked/classifier.status"; do
        [ -f "$candidate" ] && CLS_FILE="$candidate" && break
    done
    if [ -n "$CLS_FILE" ]; then
        CLS_RAW=$(cat "$CLS_FILE" 2>/dev/null)
        case "$CLS_RAW" in
            disabled) ;;
            *:no_key) CLS=" · \${YELLOW}cls ✗\${RESET}" ;;
            *:error)  CLS=" · \${YELLOW}cls ✗\${RESET}" ;;
            *:ok:*)   CLS=" · \${GREEN}cls ✓\${RESET}" ;;
            *:ready)  CLS=" · \${DIM}cls ●\${RESET}" ;;
        esac
    fi

    # Content scanner (privacy filter) status — parallels CLS.
    # Written by the harness to .interlinked/content-scanner.status.
    # States: disabled / starting / ready:<pid> / dormant / down:<reason>
    SCAN=""
    SCAN_FILE=""
    for candidate in ".interlinked/content-scanner.status" "cli/.interlinked/content-scanner.status"; do
        [ -f "$candidate" ] && SCAN_FILE="$candidate" && break
    done
    if [ -n "$SCAN_FILE" ]; then
        SCAN_RAW=$(cat "$SCAN_FILE" 2>/dev/null)
        case "$SCAN_RAW" in
            disabled) SCAN=" · \${DIM}PII filter off\${RESET}" ;;
            ready:*)  SCAN=" · \${GREEN}PII filter ✓\${RESET}" ;;
            starting) SCAN=" · \${YELLOW}PII filter …\${RESET}" ;;
            dormant)  SCAN=" · \${DIM}PII filter ●\${RESET}" ;;
            down:*)   SCAN=" · \${YELLOW}PII filter ✗\${RESET}" ;;
        esac
    fi

    # Content scanner — pending WebFetch reviews (3-way human-in-the-loop).
    # Written by the harness to .interlinked/scanner/review-pending — a single
    # integer count, or absent/zero when nothing is pending. Surfaces a nag
    # so the user sees that an agent is waiting for their decision.
    REVIEW=""
    REVIEW_FILE=""
    for candidate in ".interlinked/scanner/review-pending" "cli/.interlinked/scanner/review-pending"; do
        [ -f "$candidate" ] && REVIEW_FILE="$candidate" && break
    done
    if [ -n "$REVIEW_FILE" ]; then
        REVIEW_COUNT=$(cat "$REVIEW_FILE" 2>/dev/null | tr -d '[:space:]')
        if [ -n "$REVIEW_COUNT" ] && [ "$REVIEW_COUNT" != "0" ]; then
            REVIEW=" · \${YELLOW}review:\${REVIEW_COUNT}\${RESET}"
        fi
    fi
    printf "%b" "\${GREEN}interlinked \${BOLD}▲\${RESET}\${DIM} pid \${PID} ·\${RESET} \${TS_FMT}\${CLS}\${SCAN}\${REVIEW}"
else
    printf "%b" "\${YELLOW}interlinked \${BOLD}▼\${RESET}\${DIM} stale\${RESET}"
fi
`;
	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
}

function applyStatuslineToSettings(
	settingsPath: string,
	scriptPath: string,
	statusLineConfig: { type: string; command: string },
): boolean {
	try {
		const dir = dirname(settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		let settings: JsonObject = {};
		if (existsSync(settingsPath)) {
			const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (isPlainObject(parsed)) {
				settings = parsed;
			}
		}

		if (!settings.statusLine) {
			settings.statusLine = statusLineConfig;
			writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
			return true;
		}
		if (isPlainObject(settings.statusLine)) {
			const existing = settings.statusLine;
			if (
				isNonEmptyString(existing.command) &&
				existing.command.includes("statusline-interlinked")
			) {
				existing.command = scriptPath;
				writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
				return true;
			}
		}
	} catch (_err) {
		/* intentional: malformed or unreadable client settings — skip this client */
	}
	return false;
}

function statuslineSettingsPath(client: ClientName, home: string): string | null {
	if (client === CLIENT_CLAUDE) {
		return join(home, ".claude", "settings.json");
	}
	if (client === CLIENT_COPILOT) {
		// Copilot reads ~/.copilot/config.json for user-level settings
		return join(home, ".copilot", "config.json");
	}
	return null;
}

/**
 * Public API — consumed by `src/commands/enable.ts` (re-exported via `src/lib/hooks.ts`).
 *
 * Write the statusline script and configure it in user-level settings for
 * clients that support it (Claude Code, Copilot CLI).
 * Returns the path to the script, or null if no clients were configured.
 */
export function installStatusLine(clients: ClientName[]): string | null {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return null;

	// Write the script to ~/.interlinked/statusline-interlinked.sh
	const scriptDir = join(home, ".interlinked");
	if (!existsSync(scriptDir)) {
		mkdirSync(scriptDir, { recursive: true });
	}
	const scriptPath = join(scriptDir, STATUSLINE_SCRIPT_NAME);
	writeStatuslineScript(scriptPath);

	const statusLineConfig = { type: "command", command: scriptPath };
	let configured = false;
	for (const client of clients) {
		const settingsPath = statuslineSettingsPath(client, home);
		if (!settingsPath) continue;
		configured =
			applyStatuslineToSettings(settingsPath, scriptPath, statusLineConfig) || configured;
	}
	return configured ? scriptPath : null;
}

// ===========================================
// Claude Code — Current Supported Installation
// ===========================================

function getClaudeSettingsPath(cwd: string): string {
	return join(cwd, ".claude", "settings.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Claude Code's `.claude/settings.json` for
 * the current working directory. Refuses to install if an ancestor already
 * has hooks (Claude Code merges hooks up the directory tree).
 */
export function installAllClaudeHooks(cwd: string, hookScriptPath: string): void {
	// Refuse to install if a parent directory already has interlinked hooks.
	// Claude Code merges hooks from all .claude/settings.json files in the path,
	// so duplicate registrations cause "2 PostToolUse hooks ran" and can swallow output.
	const parentWithHooks = findParentWithHooks(cwd, join(".claude", "settings.json"));
	if (parentWithHooks) {
		console.error(
			`\n⚠️  Skipping Claude hook installation — hooks already installed at ${parentWithHooks}/.claude/settings.json\n` +
				"   Claude Code merges hooks from all .claude/settings.json files in the path,\n" +
				"   so installing here would cause duplicate hooks.\n" +
				`   Run \`interlinked enable\` from ${parentWithHooks} instead.\n`,
		);
		return;
	}

	const settingsPath = getClaudeSettingsPath(cwd);
	const settings = readJsonFile(settingsPath) || {};

	if (!settings.hooks) settings.hooks = {};
	const hooks = settings.hooks as JsonObject;

	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_CLAUDE);

	for (const eventName of CLAUDE_HOOK_EVENTS) {
		installHookEntry(hooks, eventName, hookCommand);
	}

	writeJsonFile(settingsPath, settings);
}

/**
 * Walk up from cwd to the git root checking if any ancestor already has
 * interlinked hooks in the given settings file. Returns the ancestor path
 * if found, or null if no parent has hooks.
 */
function findParentWithHooks(cwd: string, settingsSubpath: string): string | null {
	const gitRoot = findProjectRoot(cwd);
	let dir = dirname(cwd);
	const stopAt = gitRoot || parse(cwd).root;

	while (dir.length >= stopAt.length) {
		const settingsPath = join(dir, settingsSubpath);
		if (existsSync(settingsPath)) {
			try {
				const content = readFileSync(settingsPath, "utf-8");
				if (content.includes(INTERLINKED_MARKER)) {
					return dir;
				}
			} catch (_err) {
				/* intentional: settings file unreadable — keep walking up */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function cleanClaudeHooksFromFile(settingsPath: string): boolean {
	if (!existsSync(settingsPath)) return false;

	const settings = readJsonFile(settingsPath);
	if (!settings?.hooks) return false;

	const hooks = settings.hooks as JsonObject;
	let changed = false;
	for (const eventName of CLAUDE_HOOK_EVENTS) {
		const entries = hooks[eventName] as HookEntry[] | undefined;
		if (!entries) continue;

		const filtered = entries.filter(
			(entry: HookEntry) =>
				!entry.hooks?.some((h) => h.command?.includes(INTERLINKED_MARKER)),
		);

		if (filtered.length !== entries.length) {
			hooks[eventName] = filtered.length > 0 ? filtered : undefined;
			changed = true;
		}
	}

	// Clean up empty hooks object
	if (Object.values(hooks).every((v) => v === undefined)) {
		delete settings.hooks;
	}

	if (changed) {
		writeJsonFile(settingsPath, settings);
	}
	return changed;
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Claude Code settings at the cwd AND at the
 * git root (since Claude Code merges hooks up the tree).
 */
export function uninstallAllClaudeHooks(cwd: string): boolean {
	let changed = false;

	// Clean hooks from cwd's .claude/settings.json
	changed = cleanClaudeHooksFromFile(getClaudeSettingsPath(cwd)) || changed;

	// Also clean hooks from the git root's .claude/settings.json
	const projectRoot = findProjectRoot(cwd);
	if (projectRoot && projectRoot !== cwd) {
		changed = cleanClaudeHooksFromFile(getClaudeSettingsPath(projectRoot)) || changed;
	}

	return changed;
}

// ===========================================
// GitHub Copilot CLI — Install/Uninstall
// ===========================================

function getCopilotHooksPath(cwd: string): string {
	return join(cwd, ".github", "hooks", "hooks.json");
}

// Narrow shape of the Copilot hooks.json we read/write.
interface CopilotConfig {
	version: number;
	hooks: Record<string, unknown[]>;
}

/**
 * Schema parser for Copilot hooks.json — kept separate from the file read
 * so cold readers can see exactly which fields we trust at the JSON
 * boundary. Returns null for any shape that isn't a plain object; coerces
 * a missing/non-object `hooks` to an empty record.
 */
function parseCopilotConfigShape(raw: unknown): CopilotConfig | null {
	if (!isPlainObject(raw)) return null;
	const hooks = isPlainObject(raw.hooks) ? raw.hooks : {};
	return { version: 1, hooks: hooks as Record<string, unknown[]> };
}

function safeReadCopilotConfig(path: string): CopilotConfig | null {
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		/* intentional: malformed hooks.json — caller starts over */
		return null;
	}
	return parseCopilotConfigShape(raw);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into GitHub Copilot CLI's `.github/hooks/hooks.json`.
 */
export function installCopilotHooks(cwd: string, hookScriptPath: string): void {
	const hooksPath = getCopilotHooksPath(cwd);
	const dir = dirname(hooksPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_COPILOT);

	// Read existing config or start fresh
	const config = safeReadCopilotConfig(hooksPath) || { version: 1, hooks: {} };

	for (const eventName of COPILOT_HOOK_EVENTS) {
		if (!config.hooks[eventName]) config.hooks[eventName] = [];
		const entries = config.hooks[eventName] as Array<{ type: string; bash?: string }>;

		// Check if already installed — update if stale
		const existing = entries.find((e) => e.bash?.includes(INTERLINKED_MARKER));
		if (existing) {
			if (existing.bash !== hookCommand) {
				existing.bash = hookCommand;
			}
			continue;
		}

		entries.push({
			type: "command",
			bash: hookCommand,
		});
	}

	config.version = 1;
	writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Copilot CLI's hooks.json. Deletes the file
 * entirely if no other hooks remain.
 */
export function uninstallCopilotHooks(cwd: string): boolean {
	const hooksPath = getCopilotHooksPath(cwd);
	const config = safeReadCopilotConfig(hooksPath);
	if (!config?.hooks) return false;

	let changed = false;
	for (const eventName of COPILOT_HOOK_EVENTS) {
		const entries = config.hooks[eventName] as
			| Array<{ type: string; bash?: string }>
			| undefined;
		if (!entries) continue;

		const filtered = entries.filter((e) => !e.bash?.includes(INTERLINKED_MARKER));
		if (filtered.length !== entries.length) {
			config.hooks[eventName] = filtered.length > 0 ? filtered : [];
			changed = true;
		}
	}

	if (changed) {
		// Remove file entirely if no hooks remain
		const hasHooks = Object.values(config.hooks).some(
			(arr) => Array.isArray(arr) && arr.length > 0,
		);
		if (!hasHooks) {
			rmSync(hooksPath, { force: true });
		} else {
			writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
		}
	}

	return changed;
}

// ===========================================
// Gemini CLI — Install/Uninstall
// ===========================================

function getGeminiSettingsPath(cwd: string): string {
	return join(cwd, ".gemini", "settings.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Gemini CLI's `.gemini/settings.json`.
 */
export function installGeminiHooks(cwd: string, hookScriptPath: string): void {
	const settingsPath = getGeminiSettingsPath(cwd);
	const settings = readJsonFile(settingsPath) || {};

	if (!isPlainObject(settings.hooks)) {
		settings.hooks = {};
	}
	const hooks = settings.hooks as JsonObject;
	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_GEMINI);

	for (const eventName of GEMINI_HOOK_EVENTS) {
		installHookEntry(hooks, eventName, hookCommand);
	}

	writeJsonFile(settingsPath, settings);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Gemini CLI settings.
 */
export function uninstallGeminiHooks(cwd: string): boolean {
	return cleanJsonHookFile(getGeminiSettingsPath(cwd), GEMINI_HOOK_EVENTS);
}

// ===========================================
// OpenAI Codex CLI — Install/Uninstall
// ===========================================
// Codex's `.codex/hooks.json` shape is identical to Claude Code's
// `.claude/settings.json` `hooks` field: `{ matcher, hooks: [{ type, command }] }`
// per event. Hooks are gated behind a feature flag in `.codex/config.toml`
// (`[features] codex_hooks = true`); we add it idempotently when missing so
// `interlinked enable` is a one-step setup.

function getCodexHooksPath(cwd: string): string {
	return join(cwd, ".codex", "hooks.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Codex CLI's `.codex/hooks.json` and ensure
 * `codex_hooks = true` is set in `.codex/config.toml` (gating feature flag —
 * without it Codex silently ignores hooks.json). Feature-flag logic lives
 * in `./codex-feature-flag.ts` and is also called from the modern adapter's
 * `postInstall` so both install paths are equivalent.
 */
export function installCodexHooks(cwd: string, hookScriptPath: string): void {
	const settingsPath = getCodexHooksPath(cwd);
	const settings = readJsonFile(settingsPath) || {};

	if (!settings.hooks) settings.hooks = {};
	const hooks = settings.hooks as JsonObject;
	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_CODEX);

	for (const eventName of CODEX_HOOK_EVENTS) {
		installHookEntry(hooks, eventName, hookCommand);
	}

	writeJsonFile(settingsPath, settings);
	ensureCodexFlag(cwd);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Codex CLI settings. Leaves `.codex/config.toml`
 * untouched — disabling hooks is reversible by removing the flag manually,
 * and we don't want to clobber user-managed Codex configuration.
 */
export function uninstallCodexHooks(cwd: string): boolean {
	return cleanJsonHookFile(getCodexHooksPath(cwd), CODEX_HOOK_EVENTS);
}

// ===========================================
// Cursor IDE — Install/Uninstall
// ===========================================
// Cursor's `.cursor/hooks.json` shape is its own — `{ version: 1, hooks: {
// eventName: [{ command, type?, timeout?, failClosed?, matcher? }] } }`. The
// hook entry is a flat object (no `matcher` + nested `hooks: [...]` like
// Claude/Codex). `failClosed: true` is set so Cursor blocks the action if
// our hook crashes — this matches the security posture of the other clients
// where harness-down is fail-open at the destructive-pattern level (inline
// fallback) but fail-closed at the rule-evaluation level. For destructive
// rules in particular, fail-closed is the right default: if the harness
// can't reason about a Bash/MCP call, surface that to the user rather than
// silently allowing.

function getCursorHooksPath(cwd: string): string {
	return join(cwd, ".cursor", "hooks.json");
}

interface CursorHookEntry {
	command: string;
	type?: string;
	timeout?: number;
	failClosed?: boolean;
	matcher?: string;
}

interface CursorConfig {
	version: number;
	hooks: Record<string, CursorHookEntry[]>;
}

function parseCursorConfigShape(raw: unknown): CursorConfig | null {
	if (!isPlainObject(raw)) return null;
	const hooks = isPlainObject(raw.hooks) ? raw.hooks : {};
	return { version: 1, hooks: hooks as Record<string, CursorHookEntry[]> };
}

function safeReadCursorConfig(path: string): CursorConfig | null {
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		/* intentional: malformed hooks.json — caller starts over */
		return null;
	}
	return parseCursorConfigShape(raw);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Cursor's `.cursor/hooks.json`.
 *
 * `failClosed: true` is set on guard-relevant hooks (`beforeShellExecution`,
 * `beforeMCPExecution`, `beforeReadFile`, `preToolUse`) so a hook crash
 * blocks the action. Lifecycle / observation hooks (`sessionStart`,
 * `afterFileEdit`, `postToolUse`, etc.) leave `failClosed` unset (fail-open)
 * because they don't gate execution and a hook crash there should not
 * derail the user's session.
 */
export function installCursorHooks(cwd: string, hookScriptPath: string): void {
	const hooksPath = getCursorHooksPath(cwd);
	const dir = dirname(hooksPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_CURSOR);

	const config = safeReadCursorConfig(hooksPath) || { version: 1, hooks: {} };

	for (const eventName of CURSOR_HOOK_EVENTS) {
		if (!config.hooks[eventName]) config.hooks[eventName] = [];
		const entries = config.hooks[eventName];

		const existing = entries.find((e) => e.command?.includes(INTERLINKED_MARKER));
		if (existing) {
			if (existing.command !== hookCommand) {
				existing.command = hookCommand;
			}
			const expectedFailClosed = CURSOR_FAIL_CLOSED_EVENTS.has(eventName);
			if ((existing.failClosed || false) !== expectedFailClosed) {
				existing.failClosed = expectedFailClosed;
			}
			continue;
		}

		const entry: CursorHookEntry = { command: hookCommand, type: "command" };
		if (CURSOR_FAIL_CLOSED_EVENTS.has(eventName)) {
			entry.failClosed = true;
		}
		entries.push(entry);
	}

	config.version = 1;
	writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Cursor's hooks.json. Deletes the file
 * entirely if no other hooks remain.
 */
export function uninstallCursorHooks(cwd: string): boolean {
	const hooksPath = getCursorHooksPath(cwd);
	const config = safeReadCursorConfig(hooksPath);
	if (!config?.hooks) return false;

	let changed = false;
	for (const eventName of CURSOR_HOOK_EVENTS) {
		const entries = config.hooks[eventName];
		if (!entries) continue;

		const filtered = entries.filter((e) => !e.command?.includes(INTERLINKED_MARKER));
		if (filtered.length !== entries.length) {
			config.hooks[eventName] = filtered;
			changed = true;
		}
	}

	if (changed) {
		const hasHooks = Object.values(config.hooks).some(
			(arr) => Array.isArray(arr) && arr.length > 0,
		);
		if (!hasHooks) {
			rmSync(hooksPath, { force: true });
		} else {
			// Drop empty arrays so the file is minimal post-uninstall.
			for (const k of Object.keys(config.hooks)) {
				if (config.hooks[k].length === 0) delete config.hooks[k];
			}
			writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
		}
	}

	return changed;
}

// Cursor events where a hook crash should block the action (fail-closed).
// These are the gates that, if our hook can't run, an unguarded destructive
// command might land on the user. Lifecycle/observation events (sessionStart,
// afterFileEdit, postToolUse, ...) stay fail-open so a flaky hook doesn't
// break the user's session.
/**
 * Public API — exported so the contract test in
 * `src/lib/__tests__/hook-installers-shell.test.ts` can iterate every
 * fail-closed event and assert the generated command actually exits
 * non-zero on missing/crashed script. Without that pairing, an editor
 * adding a new event here without a matching command-shape change would
 * silently leave it fail-open.
 */
export const CURSOR_FAIL_CLOSED_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeReadFile",
	"preToolUse",
]);

// ===========================================
// Shared Hook Entry Helper
// ===========================================

function installHookEntry(hooks: JsonObject, eventName: string, command: string): void {
	if (!hooks[eventName]) hooks[eventName] = [];
	const entries = hooks[eventName] as HookEntry[];

	// Check if already installed
	const existing = entries.find((entry) =>
		entry.hooks?.some((h) => h.command?.includes(INTERLINKED_MARKER)),
	);

	if (existing) {
		// Update command if it points to a stale path (e.g. .claude/hooks/ → .interlinked/hooks/)
		const hook = existing.hooks?.find((h) => h.command?.includes(INTERLINKED_MARKER));
		if (hook && hook.command !== command) {
			hook.command = command;
		}
		// Update matcher for mutation-only post-tool hooks when the install rules change.
		const expectedMatcher = getHookMatcher(eventName);
		if (existing.matcher !== expectedMatcher) {
			existing.matcher = expectedMatcher;
		}
		return;
	}

	entries.push({
		matcher: getHookMatcher(eventName),
		hooks: [{ type: "command", command }],
	});
}

function getHookMatcher(eventName: string): string {
	return SCOPED_MATCHER_EVENTS.has(eventName) ? POST_TOOL_USE_MATCHER : "";
}

// ===========================================
// JSON File Helpers
// ===========================================

function readJsonFile(path: string): JsonObject | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isPlainObject(parsed) ? parsed : null;
	} catch (_err) {
		/* intentional: malformed JSON — caller treats null as "no config" */
		return null;
	}
}

function serializeJsonFile(data: JsonObject): string {
	return `${JSON.stringify(data, null, 2)}\n`;
}

function writeJsonFile(path: string, data: JsonObject): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const next = serializeJsonFile(data);
	if (existsSync(path)) {
		try {
			const current = readFileSync(path, "utf-8");
			if (current === next) return;
		} catch (_err) {
			/* intentional: unreadable file — fall through and attempt rewrite */
		}
	}
	writeFileSync(path, next);
}

function buildHookCommand(hookScriptPath: string, client?: ClientName): string {
	const escapedPath = hookScriptPath.replace(/(["\\`$])/g, "\\$1");
	const runner =
		client === CLIENT_CLAUDE
			? "claude-code"
			: client === CLIENT_COPILOT
				? "copilot-cli"
				: client === CLIENT_GEMINI
					? "gemini-cli"
					: client === CLIENT_CODEX
						? "codex"
						: client === CLIENT_CURSOR
							? "cursor"
							: "";
	const envPrefix =
		client && runner ? `INTERLINKED_CLIENT="${client}" INTERLINKED_RUNNER="${runner}" ` : "";

	// Cursor is the one client where hook startup/runtime failures must
	// propagate as a non-zero exit so its `failClosed: true` setting
	// actually fails closed. For every other client we keep the historic
	// fail-open shape (`|| true` / `break` on missing script) so a
	// transient error in observation hooks doesn't derail the session.
	const isCursorFailClosed = client === CLIENT_CURSOR;

	if (hookScriptPath.startsWith("/")) {
		// Absolute paths are already stable — keep the shell snippet short.
		if (isCursorFailClosed) {
			// `exec` replaces the shell with node so node's exit code (0 on
			// allow, non-zero on a crash) is what Cursor sees. A missing
			// script file falls through to an explicit `exit 1` — Cursor
			// treats that as a fail-closed denial, which is what the user
			// asked for when they enabled `failClosed: true`.
			return `if test -f "${escapedPath}"; then ${envPrefix}exec node "${escapedPath}"; else exit 1; fi`;
		}
		return `test -f "${escapedPath}" && ${envPrefix}node "${escapedPath}" || true`;
	}

	// Project-local installs write a relative path like
	// `.interlinked/hooks/interlinked-activity.mjs`. The hook may fire from
	// a nested cwd inside the repo, so walk upward until the script is found.
	//
	// CRITICAL: this single-line shell snippet must parse under POSIX sh,
	// bash AND zsh — Codex CLI invokes hooks via the user's configured
	// shell. `do; if` and `then; ACTION` (semicolon between a keyword and
	// its body) are syntax errors in bash/sh/dash; only zsh tolerates
	// them. So we glue `do`/`then` directly to the next statement with a
	// space rather than building the body via `.join("; ")`. See
	// `hook-installers-shell.test.ts` for a regression test that actually
	// invokes bash on the generated string.
	if (isCursorFailClosed) {
		return (
			`HOOK_SCRIPT_REL="${escapedPath}"; ` +
			`HOOK_DIR="$PWD"; ` +
			`while :; do ` +
			`if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ` +
			`${envPrefix}exec node "$HOOK_DIR/$HOOK_SCRIPT_REL"; ` +
			`fi; ` +
			`NEXT_HOOK_DIR=$(dirname "$HOOK_DIR"); ` +
			`test "$NEXT_HOOK_DIR" = "$HOOK_DIR" && exit 1; ` +
			`HOOK_DIR="$NEXT_HOOK_DIR"; ` +
			`done`
		);
	}
	return (
		`HOOK_SCRIPT_REL="${escapedPath}"; ` +
		`HOOK_DIR="$PWD"; ` +
		`while :; do ` +
		`if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ` +
		`${envPrefix}node "$HOOK_DIR/$HOOK_SCRIPT_REL" || true; ` +
		`break; ` +
		`fi; ` +
		`NEXT_HOOK_DIR=$(dirname "$HOOK_DIR"); ` +
		`test "$NEXT_HOOK_DIR" = "$HOOK_DIR" && break; ` +
		`HOOK_DIR="$NEXT_HOOK_DIR"; ` +
		`done`
	);
}

function cleanJsonHookFile(cwdOrPath: string, events: readonly string[]): boolean {
	const settingsPath = cwdOrPath;
	if (!existsSync(settingsPath)) return false;

	const settings = readJsonFile(settingsPath);
	if (!settings?.hooks || !isPlainObject(settings.hooks)) return false;

	const hooks = settings.hooks as JsonObject;
	let changed = false;

	for (const eventName of events) {
		const entries = hooks[eventName] as HookEntry[] | undefined;
		if (!entries) continue;

		const filtered = entries.filter(
			(entry) => !entry.hooks?.some((h) => h.command?.includes(INTERLINKED_MARKER)),
		);
		if (filtered.length !== entries.length) {
			hooks[eventName] = filtered.length > 0 ? filtered : undefined;
			changed = true;
		}
	}

	if (!changed) return false;

	if (Object.values(hooks).every((v) => v === undefined)) {
		delete settings.hooks;
	}

	writeJsonFile(settingsPath, settings);
	return true;
}
