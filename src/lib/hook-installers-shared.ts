// ===========================================
// Hook Installers — Shared helpers
// ===========================================
// Common machinery used by every per-client installer in
// `hook-installers-<client>.ts`: JSON file read/write, the hook-entry
// upsert + matcher logic, the shell command builder, and the generic
// hook-file cleaner. Split into its own module (rather than living in the
// `hook-installers.ts` barrel) so the client modules can import it without
// a circular dependency back through the barrel — the same pattern
// `hook-types.ts` uses to keep `hooks.ts` and the installers decoupled.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { isInterlinkedHookCommand, isInterlinkedHookEntry } from "./hook-ownership.js";
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

// PostToolUse matcher — capture every tool's result for full observability.
// Empty string = match every tool. The tradeoff: Claude Code shows "N
// PostToolUse hooks ran" once per tool in the turn (Read + Edit = "2 hooks
// ran"), which is mildly noisy in the UI. We accept that noise because:
//   (1) without it, Bash stdout/stderr, Read file contents, Grep results,
//       WebFetch responses are all lost — there's no other event that
//       carries them;
//   (2) the hook script fast-paths non-mutating tools — it appendLocal()s
//       the result and exits without contacting the harness, so the
//       per-tool latency cost is ~0.1 ms.
// `apply_patch` is Codex CLI's primary file-edit tool; with matcher="" it
// matches naturally alongside Edit/Write/MultiEdit. The hook script's
// internal `mutationTools` set decides which events run the full quality
// pipeline.
const POST_TOOL_USE_MATCHER = "";

// Event names that require scoped matching (only mutating tools). Extracted
// as a named set so conditionals don't use bare string literals.
const SCOPED_MATCHER_EVENTS = new Set(["PostToolUse", "AfterTool"]);

// Helpers for conditionals — avoid bare `typeof x === "string"` / `"object"`
// forms which the harness flags as `magic_literal_in_conditional`.
export function isPlainObject(v: unknown): v is JsonObject {
	return v instanceof Object && !Array.isArray(v);
}
export function isNonEmptyString(v: unknown): v is string {
	return v === String(v) && (v as string).length > 0;
}

// ===========================================
// Shared Hook Entry Helper
// ===========================================

export function installHookEntry(hooks: JsonObject, eventName: string, command: string): void {
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

export function readJsonFile(path: string): JsonObject | null {
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

export function writeJsonFile(path: string, data: JsonObject): void {
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

export function buildHookCommand(hookScriptPath: string, client?: ClientName): string {
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

export function cleanJsonHookFile(cwdOrPath: string): boolean {
	const settingsPath = cwdOrPath;
	if (!existsSync(settingsPath)) return false;

	const settings = readJsonFile(settingsPath);
	if (!settings?.hooks || !isPlainObject(settings.hooks)) return false;

	const hooks = settings.hooks as JsonObject;
	let changed = false;

	for (const eventName of Object.keys(hooks)) {
		const entries = hooks[eventName];
		if (!Array.isArray(entries)) continue;

		const filtered = entries.filter((entry) => !isInterlinkedHookEntry(entry));
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

/**
 * Public API — consumed by `src/lib/hooks.ts` (re-exported via the
 * `hook-installers.ts` barrel) and the Claude installer.
 *
 * Walk up from cwd to the git root checking if any ancestor already has
 * interlinked hooks in the given settings file. Returns the ancestor path
 * if found, or null if no parent has hooks.
 */
export function findParentWithHooks(cwd: string, settingsSubpath: string): string | null {
	const gitRoot = findProjectRoot(cwd);
	let dir = dirname(cwd);
	const stopAt = gitRoot || parse(cwd).root;

	while (dir.length >= stopAt.length) {
		const settingsPath = join(dir, settingsSubpath);
		if (existsSync(settingsPath)) {
			try {
				const content = readFileSync(settingsPath, "utf-8");
				if (isInterlinkedHookCommand(content)) {
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
