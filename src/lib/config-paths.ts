// interlinked-tdd: exempt
// ===========================================
// Config Path Helpers
// ===========================================
// Pure path-resolution helpers split out of config.ts to keep the main
// module under the per-file line cap. Leaf module: depends only on node
// built-ins + the (type-only) LocalConfig shape; imports nothing back from
// config.ts at runtime.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalConfig } from "./config.js";

const CONFIG_DIR = ".interlinked";
const SHARED_CONFIG = "config.json";
const LOCAL_CONFIG = "config.local.json";
const LEGACY_CONFIG_PATH = ".claude/interlinked-session.json";

/**
 * Get the config directory (.interlinked/).
 * Resolution: INTERLINKED_HOME env > {cwd}/.interlinked/
 */
export function getConfigDir(cwd: string = process.cwd()): string {
	const envHome = process.env.INTERLINKED_HOME?.trim();
	if (envHome) return envHome;
	return join(cwd, CONFIG_DIR);
}

/**
 * Get the data directory for activity logs, sessions, and sync state.
 * Resolution: INTERLINKED_DATA_DIR env > LocalConfig.data_dir > INTERLINKED_HOME env > {cwd}/.interlinked/
 */
export function getDataDir(cwd: string = process.cwd()): string {
	const envDataDir = process.env.INTERLINKED_DATA_DIR?.trim();
	if (envDataDir) return envDataDir;

	// Check local config for data_dir (read directly to avoid circular dependency with resolveConfig)
	const localConfigPath = getLocalConfigPath(cwd);
	if (existsSync(localConfigPath)) {
		try {
			const local = JSON.parse(readFileSync(localConfigPath, "utf-8")) as LocalConfig;
			if (local.data_dir) return local.data_dir;
		} catch (_err) {
			/* intentional: corrupt local config — fall through to default data dir */
		}
	}

	return getConfigDir(cwd);
}

/**
 * Get the hooks directory for generated hook scripts.
 */
export function getHooksDir(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "hooks");
}

export function getSharedConfigPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), SHARED_CONFIG);
}

export function getLocalConfigPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), LOCAL_CONFIG);
}

export function getLegacyConfigPath(cwd: string = process.cwd()): string {
	return join(cwd, LEGACY_CONFIG_PATH);
}
