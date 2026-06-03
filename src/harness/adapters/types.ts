// ===========================================
// RunnerAdapter contract
// ===========================================
// Every supported coding-agent CLI (Claude Code, Copilot CLI, Cursor, Gemini
// CLI, Codex) provides an implementation of this interface. The adapter's job
// is to normalize native hook events into a UnifiedHookEvent and translate
// HarnessDecision back into the runner's expected stdout/stderr/exit-code
// format. See docs/design/cli-hook-normalization.md §"Per-runner adapters".

import type { HarnessDecision } from "../types.js";
import type { RunnerId, ToolClass, UnifiedHookEvent } from "../unified-event.js";

export type MergeStrategy = "deep-merge" | "array-append" | "replace-key";

export interface SettingsFragment {
	/** Settings file path relative to the user's home or the project root.
	 *  `user`-scope paths start with `~/`; project-scope paths are relative. */
	path: string;
	/** The JSON/YAML/etc. fragment to merge into the target. */
	fragment: unknown;
	/** How to merge. `array-append` is essential for hook arrays so we never
	 *  clobber user-owned entries. */
	mergeStrategy: MergeStrategy;
}

export interface AdapterOutput {
	/** What the adapter writes to stdout. Format is runner-specific. */
	stdout?: string | undefined;
	/** What the adapter writes to stderr. `warnings[]` always land here. */
	stderr?: string | undefined;
	/** Process exit code the adapter requests (0 = allow, 2 = deny on most runners). */
	exit_code: number;
}

export interface InstallerManifestEntry {
	runner: RunnerId;
	scope: "user" | "project" | "local";
	settings_path: string;
	/** JSON-pointer paths that the installer wrote (for precise uninstall). */
	added_paths: string[];
	/** Binary path or script path referenced from the hook entry. */
	binary_path: string;
	/** ISO timestamp of install. */
	installed_at: string;
	/** Schema version of the manifest record. */
	schema_version: "1";
}

export interface RunnerAdapter {
	readonly id: RunnerId;

	/** Human-friendly label ("Claude Code", "GitHub Copilot CLI"). */
	readonly label: string;

	/** When true we may flag this adapter as experimental in the installer UI. */
	readonly experimental?: boolean;

	/** Heuristic detection. True if the current process environment suggests
	 *  this adapter is the caller. Used by install-hooks when the user passes
	 *  no explicit `--runner`. Must be a fast, side-effect-free check. */
	detectFromEnv(env: NodeJS.ProcessEnv): boolean;

	/** Native hook event names this adapter knows how to parse. Used to
	 *  validate installation fragments and to classify incoming payloads. */
	readonly nativeEventNames: readonly string[];

	/** Translate a native hook-input JSON payload + event name into a unified
	 *  event. Must be tolerant of unknown fields — runners evolve their
	 *  payload shapes and we must not crash on new keys. */
	parseHookInput(nativeJson: unknown, nativeEventName: string): UnifiedHookEvent;

	/** Classify a tool call into a ToolClass. Runs after parseHookInput so the
	 *  adapter can inject runner-specific heuristics (e.g. Claude's
	 *  `MultiEdit` → modify). Falls back to the shared command classifier. */
	classifyToolClass(toolName: string, toolInput: unknown): ToolClass;

	/** Produce a settings-file fragment for the installer. Must be merge-safe;
	 *  `array-append` merge on hook arrays is mandatory. The returned
	 *  `added_paths` list is used to construct the installer manifest. */
	renderSettingsFragment(
		binaryPath: string,
		scope: "user" | "project" | "local",
	): SettingsFragment;

	/** Translate a canonical HarnessDecision into the runner-specific output
	 *  (stdout JSON / stderr / exit code). Adapters are responsible for
	 *  mapping the internal "block" value to the runner's native keyword
	 *  (Claude: "deny"; Copilot: exit code 2; etc.). */
	encodeDecision(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput;

	/** Optional side-effects to run after the JSON settings fragment has been
	 *  merged into the target file. Used by runners that need additional
	 *  out-of-band configuration the JSON merger can't express — e.g. Codex
	 *  CLI requires `[features] hooks = true` in `.codex/config.toml`
	 *  (legacy `codex_hooks` auto-migrated by the writer)
	 *  before any hooks.json is honored. The installer calls this after
	 *  writing the JSON fragment, with the resolved scope and the dryRun
	 *  flag so adapters can no-op or trace under `--dry-run`. */
	postInstall?(opts: PostInstallOptions): void;
}

export interface PostInstallOptions {
	/** Repo root for project/local scope; user home for user scope. */
	cwd: string;
	/** Scope the install ran under. Adapters typically only care about this
	 *  to decide which directory layer to write to (project vs user). */
	scope: "user" | "project" | "local";
	/** When true, adapters must not write files — only log what they would do. */
	dryRun: boolean;
}
