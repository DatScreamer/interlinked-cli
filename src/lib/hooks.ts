// ===========================================
// Hook Management — orchestration only
// ===========================================
// Public surface for hook lifecycle: write the generated `.mjs` script,
// install/uninstall it into each detected client, manage `.gitignore`,
// and detect colocated git-hook managers.
//
// Per-client install/uninstall logic lives in `./hook-installers.ts` —
// this module just orchestrates and re-exports the public API. Adding a
// new client means editing `./hook-installers.ts` (events list +
// install/uninstall functions) and wiring it into CLIENT_INSTALL_REGISTRY
// below; nothing else in this file should need to change.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { installHooks, manifestPath, readManifest } from "../harness/installer.js";
import {
	getModePreset,
	type HarnessModePreset,
	migrateLegacyMode,
	QUALITY_MODE,
} from "../harness/rules/modes.js";
import type { RunnerId } from "../harness/unified-event.js";
import { readSharedConfig } from "./config.js";
import {
	CLAUDE_HOOK_EVENTS,
	CODEX_HOOK_EVENTS,
	COPILOT_HOOK_EVENTS,
	CURSOR_HOOK_EVENTS,
	findParentWithHooks,
	GEMINI_HOOK_EVENTS,
	installAllClaudeHooks,
	installCodexHooks,
	installCopilotHooks,
	installCursorHooks,
	installGeminiHooks,
	installStatusLine as installStatusLineImpl,
	uninstallAllClaudeHooks,
	uninstallCodexHooks,
	uninstallCopilotHooks,
	uninstallCursorHooks,
	uninstallGeminiHooks,
} from "./hook-installers.js";
import { CLIENT_CLAUDE } from "./hook-types.js";
import { buildHookScript } from "./hooks-template.js";
import type { JsonObject } from "./json-types.js";
import { nonNull } from "./non-null.js";
import type { ClientName } from "./settings.js";

export { findProjectRoot } from "./hook-types.js";
export { ensureGitignore } from "./hooks-gitignore.js";

/**
 * Public API — consumed by `src/commands/enable.ts`.
 * Write the statusline script and configure it in user-level settings for
 * clients that support it (Claude Code, Copilot CLI). Returns the path to
 * the script, or null if no clients were configured.
 *
 * Thin wrapper over `installStatusLineImpl` from `./hook-installers.ts` so
 * the dependency between modules is explicit (the dead-export check
 * doesn't follow bare `export { ... } from` re-exports as usages).
 */
export function installStatusLine(clients: ClientName[]): string | null {
	return installStatusLineImpl(clients);
}

// Hook script version — derived from package.json so there's one source of truth.
// Embedded in the generated .mjs script for staleness detection by `doctor`.
export const HOOK_SCRIPT_VERSION: string = ((): string => {
	try {
		const pkgPath = new URL("../../package.json", import.meta.url);
		const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const version = readPackageVersion(parsed);
		return version || "0.0.0";
	} catch (_err) {
		/* intentional: package.json missing or unreadable — fallback version */
		return "0.0.0";
	}
})();

// ===========================================
// Path Helpers
// ===========================================

/**
 * Get the path to the hook script inside .interlinked/hooks/.
 */
export function getHookScriptPath(cwd: string): string {
	return join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
}

// ===========================================
// Hook Script Generation
// ===========================================

/**
 * Resolve the operational tier preset (budget / quality / ci) for the
 * generated hook. Reads `.interlinked/config.json`'s `mode` field, applies
 * legacy migration (`balanced` → `budget` on Copilot CLI / `quality`
 * elsewhere) using the active runner from installer-manifest.json, and
 * defaults to QUALITY_MODE when nothing is configured. Phase C; see
 * src/harness/rules/modes.ts for the preset definitions.
 */
function resolveHarnessModePreset(cwd: string): HarnessModePreset {
	const shared = readSharedConfig(cwd);
	const rawMode = typeof shared?.mode === "string" ? shared.mode : undefined;
	let activeRunner: string | undefined;
	const mfPath = manifestPath(cwd);
	if (existsSync(mfPath)) {
		const entries = readManifest(mfPath);
		activeRunner = entries.length > 0 ? nonNull(entries[0]).runner : undefined;
	}
	const resolved = migrateLegacyMode(rawMode, activeRunner);
	return getModePreset(resolved);
}

/**
 * Write the universal hook script to .interlinked/hooks/interlinked-activity.mjs.
 * This script reads config from .interlinked/config.local.json and
 * normalizes events from any supported AI coding client.
 *
 * Bakes the active harness mode's `HARNESS_POST_TIMEOUT_MS` literal into
 * the generated .mjs so subsequent edits to `.interlinked/config.json`'s
 * `mode` field require re-rendering this file (typically via
 * `interlinked harness mode <name>`).
 */
export function writeHookScript(cwd: string): string {
	const scriptPath = getHookScriptPath(cwd);
	const hookDir = dirname(scriptPath);
	if (!existsSync(hookDir)) {
		mkdirSync(hookDir, { recursive: true });
	}

	const preset = resolveHarnessModePreset(cwd);
	// Default to QUALITY_MODE if resolveHarnessModePreset somehow returned
	// undefined (it shouldn't — getModePreset throws on unknown). The
	// fallback keeps the generated script renderable on a brand-new install
	// before any config file has been written.
	const activePreset = preset ?? QUALITY_MODE;
	// Bake the mode name into the version string so the
	// `interlinked-hook-version: <v>` sentinel embedded in the .mjs visibly
	// changes when the user toggles `interlinked harness mode budget|quality|ci`.
	// Without this, out-of-band staleness checks (e.g., `interlinked doctor`,
	// re-runs of `interlinked enable`) read the unchanged version literal and
	// skip the rewrite — leaving the .mjs's `HARNESS_POST_TIMEOUT_MS` baked
	// at the previous mode's value. (`harnessModeCommand` writes directly so
	// the mode-toggle path is unaffected; this guards every other rewrite path.)
	const versioned = `${HOOK_SCRIPT_VERSION}+mode-${activePreset.name}`;
	const script = buildHookScript(versioned, activePreset);

	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
	return scriptPath;
}

/**
 * Delete the hook script from .interlinked/hooks/.
 */
export function deleteHookScript(cwd: string): boolean {
	const scriptPath = getHookScriptPath(cwd);
	if (existsSync(scriptPath)) {
		unlinkSync(scriptPath);
		return true;
	}
	return false;
}

/**
 * Delete the entire .interlinked/ directory.
 */
export function deleteConfigDir(cwd: string): boolean {
	const configDir = join(cwd, ".interlinked");
	if (existsSync(configDir)) {
		rmSync(configDir, { recursive: true, force: true });
		return true;
	}
	return false;
}

// ===========================================
// Hook Binary Resolution
// ===========================================

/**
 * Resolve the hook binary that installed hooks should invoke. The canonical
 * binary is the compiled adapter hook; the generated self-contained `.mjs` is
 * the fallback for unbuilt source checkouts. Priority:
 *   1. `.interlinked/hooks/interlinked-hook` — a project-local compiled override
 *   2. the packaged `hook-entry.js` bundled beside `dist/index.js`
 *   3. the generated `.mjs` (written on demand when `writeFallback` is set)
 * The returned path always exists on disk.
 *
 * Public API — consumed by `src/commands/install-hooks.ts` and `installAllHooks`.
 */
export function resolveHookBinaryPath(
	cwd: string,
	opts: { writeFallback?: boolean } = {},
): string {
	const compiled = join(cwd, ".interlinked", "hooks", "interlinked-hook");
	if (existsSync(compiled)) return compiled;
	const packaged = packagedHookEntryPath();
	if (packaged && existsSync(packaged)) return packaged;
	const legacy = getHookScriptPath(cwd);
	if (existsSync(legacy)) return legacy;
	const writeFallback = opts.writeFallback ?? true;
	return writeFallback ? writeHookScript(cwd) : legacy;
}

/**
 * Locate the packaged `hook-entry.js` bundled next to `dist/index.js`. Resolves
 * from `process.argv[1]` (the invoked CLI entry) so a globally-installed CLI
 * still finds its own bundled hook. Returns null when not found — e.g. a source
 * checkout running via `tsx`, where there is no `dist/`.
 */
function packagedHookEntryPath(): string | null {
	const invoked = process.argv[1];
	if (!invoked) return null;
	try {
		const real = realpathSync(invoked);
		const candidate = join(dirname(real), "hook-entry.js");
		if (existsSync(candidate)) return candidate;
	} catch {
		/* intentional: argv[1] unreadable / not a real path — no packaged hook */
		return null;
	}
	return null;
}

// ===========================================
// Hook Installation — All Clients
// ===========================================

interface InstallResult {
	client: ClientName;
	installed: boolean;
	events: string[];
	error?: string;
}

interface ClientInstallEntry {
	events: readonly string[];
	install: (cwd: string, hookScriptPath: string) => void;
	uninstall: (cwd: string) => boolean;
}

/**
 * Per-client install/uninstall registry. The single source of truth for the
 * clients Interlinked knows how to wire up — their event lists and uninstall
 * closures.
 *
 * Note on `install`: the canonical install path is now the adapter installer
 * (`installHooks` in `src/harness/installer.ts`), reached via `installAllHooks`
 * below. The legacy per-client `.install` closures are retained here pending
 * full retirement of the legacy install path; `uninstall` is still the live
 * uninstall path. Adding a new client still means a matching pair in
 * `./hook-installers.ts` plus a `CLIENT_TO_RUNNER` entry.
 */
const CLIENT_INSTALL_REGISTRY: Record<ClientName, ClientInstallEntry> = {
	claude: {
		events: CLAUDE_HOOK_EVENTS,
		install: installAllClaudeHooks,
		uninstall: uninstallAllClaudeHooks,
	},
	copilot: {
		events: COPILOT_HOOK_EVENTS,
		install: installCopilotHooks,
		uninstall: uninstallCopilotHooks,
	},
	gemini: {
		events: GEMINI_HOOK_EVENTS,
		install: installGeminiHooks,
		uninstall: uninstallGeminiHooks,
	},
	codex: {
		events: CODEX_HOOK_EVENTS,
		install: installCodexHooks,
		uninstall: uninstallCodexHooks,
	},
	cursor: {
		events: CURSOR_HOOK_EVENTS,
		install: installCursorHooks,
		uninstall: uninstallCursorHooks,
	},
};

// Maps a legacy `ClientName` id to the adapter `RunnerId` vocabulary. The two
// id sets diverge: the adapter layer uses `claude-code` / `copilot-cli` /
// `gemini-cli` where the legacy client layer uses `claude` / `copilot` /
// `gemini`. `installAllHooks` translates here before calling the adapter
// installer.
const CLIENT_TO_RUNNER: Record<ClientName, RunnerId> = {
	claude: "claude-code",
	copilot: "copilot-cli",
	gemini: "gemini-cli",
	codex: "codex",
	cursor: "cursor",
};

/**
 * Install hooks into all specified clients.
 *
 * Routes through the adapter installer (`installHooks` in
 * `src/harness/installer.ts`) — the canonical install path. That installer is
 * idempotent: it purges any prior Interlinked registration (legacy `.mjs` or
 * adapter) before inserting one canonical entry, so re-running `enable` never
 * stacks duplicates. The generated `.mjs` is kept only as the binary fallback
 * for unbuilt source checkouts (see `resolveHookBinaryPath`).
 *
 * Claude Code merges hooks from every `.claude/settings.json` up the directory
 * tree, so installing into a nested checkout when an ancestor already has hooks
 * would double-fire the harness — that client is skipped with a pointer to the
 * ancestor.
 */
export function installAllHooks(cwd: string, clients: ClientName[]): InstallResult[] {
	const binaryPath = resolveHookBinaryPath(cwd);
	const skipReason = new Map<ClientName, string>();
	const runners: RunnerId[] = [];

	for (const client of clients) {
		const entry = CLIENT_INSTALL_REGISTRY[client];
		if (!entry) {
			skipReason.set(client, `Unknown client: ${client}`);
			continue;
		}
		if (client === CLIENT_CLAUDE) {
			const ancestor = findParentWithHooks(cwd, join(".claude", "settings.json"));
			if (ancestor) {
				skipReason.set(
					client,
					`hooks already installed at ${ancestor}/.claude/settings.json — run \`interlinked enable\` from there`,
				);
				continue;
			}
		}
		runners.push(CLIENT_TO_RUNNER[client]);
	}

	const installed =
		runners.length > 0 ? installHooks({ cwd, binaryPath, runners, scope: "project" }) : null;

	return clients.map((client) => {
		const skip = skipReason.get(client);
		if (skip) return { client, installed: false, events: [], error: skip };
		const runner = CLIENT_TO_RUNNER[client];
		if (installed?.entries.some((e) => e.runner === runner)) {
			return { client, installed: true, events: [...CLIENT_INSTALL_REGISTRY[client].events] };
		}
		const reason = installed?.skipped.find((s) => s.runner === runner)?.reason;
		return { client, installed: false, events: [], error: reason ?? "install failed" };
	});
}

/**
 * Uninstall hooks from all specified clients.
 * Uses CLIENT_INSTALL_REGISTRY — add new clients there, not here.
 */
export function uninstallAllHooks(cwd: string, clients: ClientName[]): InstallResult[] {
	return clients.map((client) => {
		const entry = CLIENT_INSTALL_REGISTRY[client];
		if (!entry) {
			return { client, installed: false, events: [], error: `Unknown client: ${client}` };
		}
		try {
			const removed = entry.uninstall(cwd);
			return { client, installed: false, events: removed ? [...entry.events] : [] };
		} catch (e) {
			return {
				client,
				installed: false,
				events: [],
				error: e instanceof Error ? e.message : String(e),
			};
		}
	});
}

// ===========================================
// Hook Manager Detection
// ===========================================

interface HookManagerInfo {
	name: string;
	detected_at: string;
}

interface PackageJsonShape {
	devDependencies: JsonObject;
	dependencies: JsonObject;
	scripts: JsonObject;
}

const EMPTY_PACKAGE_JSON: PackageJsonShape = {
	devDependencies: {},
	dependencies: {},
	scripts: {},
};

// Helpers for narrowing untrusted JSON. Kept off the bare `typeof x === "string"`
// pattern that the harness flags as `magic_literal_in_conditional` — these
// idioms match the project-wide style in `hook-installers.ts`.
function isPlainObject(v: unknown): v is JsonObject {
	return v instanceof Object && !Array.isArray(v);
}

function isStringValue(v: unknown): v is string {
	return v === String(v);
}

function readPackageVersion(parsed: unknown): string | null {
	if (!isPlainObject(parsed)) return null;
	const version = parsed.version;
	return isStringValue(version) ? version : null;
}

/**
 * Read package.json and project the fields detectHookManagers cares about.
 * Returns an empty shape on any read/parse failure so callers can stay in
 * a single happy-path branch (`pkg.devDependencies?.husky`).
 */
function readPackageJsonShape(cwd: string): PackageJsonShape {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return EMPTY_PACKAGE_JSON;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch (_err) {
		/* intentional: malformed package.json — treat as empty */
		return EMPTY_PACKAGE_JSON;
	}
	if (!isPlainObject(parsed)) return EMPTY_PACKAGE_JSON;
	return {
		devDependencies: isPlainObject(parsed.devDependencies) ? parsed.devDependencies : {},
		dependencies: isPlainObject(parsed.dependencies) ? parsed.dependencies : {},
		scripts: isPlainObject(parsed.scripts) ? parsed.scripts : {},
	};
}

function detectHusky(cwd: string, pkg: PackageJsonShape): HookManagerInfo | null {
	if (existsSync(join(cwd, ".husky"))) {
		return { name: "husky", detected_at: ".husky/" };
	}
	const prepareScript = pkg.scripts.prepare;
	const hasHuskyScript = isStringValue(prepareScript) && prepareScript.includes("husky");
	if (pkg.devDependencies.husky || pkg.dependencies.husky || hasHuskyScript) {
		return { name: "husky", detected_at: "package.json" };
	}
	return null;
}

function detectLefthook(cwd: string, pkg: PackageJsonShape): HookManagerInfo | null {
	const lefthookFiles = ["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"];
	for (const file of lefthookFiles) {
		if (existsSync(join(cwd, file))) {
			return { name: "lefthook", detected_at: file };
		}
	}
	if (pkg.devDependencies.lefthook || pkg.dependencies.lefthook) {
		return { name: "lefthook", detected_at: "package.json" };
	}
	return null;
}

function detectOvercommit(cwd: string): HookManagerInfo | null {
	if (existsSync(join(cwd, ".overcommit.yml"))) {
		return { name: "overcommit", detected_at: ".overcommit.yml" };
	}
	return null;
}

/**
 * Detect common git hook managers in the project.
 */
export function detectHookManagers(cwd: string): HookManagerInfo[] {
	const pkg = readPackageJsonShape(cwd);
	const managers: HookManagerInfo[] = [];
	const husky = detectHusky(cwd, pkg);
	if (husky) managers.push(husky);
	const lefthook = detectLefthook(cwd, pkg);
	if (lefthook) managers.push(lefthook);
	const overcommit = detectOvercommit(cwd);
	if (overcommit) managers.push(overcommit);
	return managers;
}
