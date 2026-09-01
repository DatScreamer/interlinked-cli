// ===========================================
// OpenCode v2 (opencode2) — Install/Uninstall
// ===========================================
// Opencode v2 has no stdin hooks.json. It auto-loads
// `.opencode/plugins/*.{ts,js}` (project) plus the v2 XDG plugin dir.
// The v1 managed bridge owns `.opencode/plugins/interlinked.ts`; this
// installer writes `interlinked-opencode2.ts` so both can be enabled.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildOpencodePluginSource,
	OPENCODE_PLUGIN_FILENAME,
	OPENCODE_PLUGIN_MARKER,
} from "./opencode-plugin-source.js";

/** Native plugin hooks we subscribe to (documented for enable summaries). */
export const OPENCODE2_HOOK_EVENTS = [
	"tool.execute.before",
	"tool.execute.after",
	"session.created",
	"session.deleted",
	"session.idle",
] as const;

export function opencodePluginRelPath(): string {
	return join(".opencode", "plugins", OPENCODE_PLUGIN_FILENAME);
}

export function getOpencodePluginPath(cwd: string, scope: "user" | "project" | "local" = "project"): string {
	if (scope === "user") {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
		// opencode2's `plugin list` loads ~/.config/opencode/plugins/*.js
		return join(home, ".config", "opencode", "plugins", OPENCODE_PLUGIN_FILENAME.replace(/\.ts$/, ".js"));
	}
	return join(cwd, ".opencode", "plugins", OPENCODE_PLUGIN_FILENAME);
}

function writePlugin(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, buildOpencodePluginSource());
}

function pluginPaths(cwd: string): string[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	const project = getOpencodePluginPath(cwd, "project");
	const userV2 = getOpencodePluginPath(cwd, "user");
	const projectDir = dirname(project);
	const v1UserDir = join(home, ".config", "opencode", "plugins");
	return [
		project,
		userV2,
		join(projectDir, "interlinked.js"),
		join(projectDir, "interlinked.ts"),
		join(v1UserDir, "interlinked.js"),
		join(v1UserDir, OPENCODE_PLUGIN_FILENAME),
		join(v1UserDir, "interlinked.ts"),
	];
}

function pluginIsOurs(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return readFileSync(path, "utf-8").includes(OPENCODE_PLUGIN_MARKER);
	} catch {
		return false;
	}
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install the Interlinked OpenCode v2 plugin.
 */
export function installOpencode2Hooks(cwd: string, _hookScriptPath: string): void {
	const project = getOpencodePluginPath(cwd, "project");
	const userJs = getOpencodePluginPath(cwd, "user");
	writePlugin(project);
	writePlugin(userJs);
	for (const leftover of pluginPaths(cwd)) {
		if (leftover === project || leftover === userJs) continue;
		if (!pluginIsOurs(leftover)) continue;
		rmSync(leftover, { force: true });
	}
}

/**
 * Public API — consumed by `src/lib/hooks.ts`.
 * Remove the Interlinked OpenCode v2 plugin if we own it.
 */
export function uninstallOpencode2Hooks(cwd: string): boolean {
	let changed = false;
	for (const path of pluginPaths(cwd)) {
		if (!pluginIsOurs(path)) continue;
		rmSync(path, { force: true });
		changed = true;
	}
	return changed;
}

/** True when the on-disk plugin is the Interlinked one. Used by doctor. */
export function isOpencode2PluginInstalled(cwd: string): boolean {
	return pluginPaths(cwd).some((path) => pluginIsOurs(path));
}
