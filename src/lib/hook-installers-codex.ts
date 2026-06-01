// ===========================================
// OpenAI Codex CLI — Install/Uninstall
// ===========================================
// Codex's `.codex/hooks.json` shape is identical to Claude Code's
// `.claude/settings.json` `hooks` field: `{ matcher, hooks: [{ type, command }] }`
// per event. Hooks are gated behind a feature flag in `.codex/config.toml`
// (`[features] hooks = true`; legacy `codex_hooks` auto-migrated); we add it
// idempotently when missing so `interlinked enable` is a one-step setup.

import { join } from "node:path";
import { ensureCodexFeatureFlag as ensureCodexFlag } from "./codex-feature-flag.js";
import {
	buildHookCommand,
	cleanJsonHookFile,
	installHookEntry,
	readJsonFile,
	writeJsonFile,
} from "./hook-installers-shared.js";
import { CLIENT_CODEX } from "./hook-types.js";
import type { JsonObject } from "./json-types.js";

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

function getCodexHooksPath(cwd: string): string {
	return join(cwd, ".codex", "hooks.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Codex CLI's `.codex/hooks.json` and ensure
 * `[features] hooks = true` is set in `.codex/config.toml` (gating feature
 * flag — without it Codex silently ignores hooks.json; legacy `codex_hooks`
 * key still recognized but auto-migrated). Feature-flag logic lives in
 * `./codex-feature-flag.ts` and is also called from the modern adapter's
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
	return cleanJsonHookFile(getCodexHooksPath(cwd));
}
