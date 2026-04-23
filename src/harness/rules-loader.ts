// ===========================================
// Rules Loader — Load, merge, and watch guard rules
// ===========================================
// This is the public entry point for the rules system. Implementation
// is split across `src/harness/rules/*.ts` to keep each file focused and
// under the file-size threshold:
//
//   rules/builtin-rules-processes.ts   — process, filesystem, git rules
//   rules/builtin-rules-database.ts    — database, container, cloud, wrangler
//   rules/builtin-rules-language.ts    — per-language destructive patterns
//   rules/builtin-rules-security.ts    — supply-chain, process-safety, info-flow
//   rules/builtin-rules.ts             — aggregates the four tables above
//   rules/default-config.ts            — DEFAULT_CONFIG value
//   rules/language-detection.ts        — project language detection + auto-tune
//   rules/merge.ts                     — team/local config merging
//   rules/file-io.ts                   — read/write guard-rules files
//
// All existing exports from `rules-loader.ts` are preserved here.

import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { BUILTIN_RULES } from "./rules/builtin-rules.js";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import {
	readLocalGuardRules,
	readTeamGuardRules,
	writeLocalGuardRules,
	writeTeamGuardRules,
} from "./rules/file-io.js";
import { autoTuneQualityChecks, detectProjectLanguages } from "./rules/language-detection.js";
import { mergeLocalOverrides, mergeTeamRules } from "./rules/merge.js";
import type { GuardRule, GuardRulesConfig } from "./types.js";

// Re-export file-io helpers as part of the public API.
// Consumers: `src/commands/reminder.ts`.
export { readLocalGuardRules, readTeamGuardRules, writeLocalGuardRules, writeTeamGuardRules };

/**
 * Public API — consumed by `src/harness/__tests__/docs-freshness.test.ts`
 * and by documentation generators. Returns a shallow clone so callers
 * cannot mutate the shared builtin-rules table.
 */
export function getBuiltinRules(): GuardRule[] {
	return [...BUILTIN_RULES];
}

/**
 * Public API — consumed by the harness server, the evaluator test suite,
 * and `interlinked verify`. Returns a deep clone of the default config
 * so callers can freely mutate it without affecting future calls.
 */
export function getDefaultConfig(): GuardRulesConfig {
	try {
		return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	} catch {
		// DEFAULT_CONFIG is a static object so this should never fail,
		// but guard against it to satisfy runtime safety checks
		return { ...DEFAULT_CONFIG, rules: [...DEFAULT_CONFIG.rules] };
	}
}

/**
 * Public API — the main entry point the harness server uses on startup
 * and on SIGHUP. Loads the default config, auto-tunes by detected
 * project language, and merges team + local overrides.
 *
 * Priority: local overrides > team rules > built-in defaults.
 */
export function loadRules(cwd: string = process.cwd()): GuardRulesConfig {
	const teamPath = join(cwd, ".interlinked", "guard-rules.json");
	const localPath = join(cwd, ".interlinked", "guard-rules.local.json");

	// Start with defaults
	const config = getDefaultConfig();

	// Auto-detect project languages and disable inapplicable checks
	const languages = detectProjectLanguages(cwd);
	autoTuneQualityChecks(config.quality_checks, languages);

	// Merge team rules
	if (existsSync(teamPath)) {
		try {
			const team = JSON.parse(readFileSync(teamPath, "utf-8"));
			mergeTeamRules(config, team);
		} catch (_err) {
			/* intentional: invalid JSON — best-effort fall back to defaults */
		}
	}

	// Merge local overrides (applied AFTER auto-tune so users can re-enable)
	if (existsSync(localPath)) {
		try {
			const local = JSON.parse(readFileSync(localPath, "utf-8"));
			mergeLocalOverrides(config, local);
		} catch (_err) {
			/* intentional: invalid JSON — best-effort skip overrides */
		}
	}

	// Combine built-in rules with custom rules
	const disabledSet = new Set(config.disabled_rules || []);
	const allRules = [
		...BUILTIN_RULES.filter((r) => !disabledSet.has(r.id)),
		...config.rules.filter((r) => r.enabled !== false),
	];
	config.rules = allRules;

	return config;
}

/**
 * Public API — consumed by the harness server to hot-reload rules when
 * the team or local config file changes on disk. Returns a cleanup
 * function that removes both watchers.
 */
export function watchRulesFiles(
	cwd: string,
	onReload: (config: GuardRulesConfig) => void,
): () => void {
	const teamPath = join(cwd, ".interlinked", "guard-rules.json");
	const localPath = join(cwd, ".interlinked", "guard-rules.local.json");

	const reload = () => {
		try {
			onReload(loadRules(cwd));
		} catch (_err) {
			/* intentional: best-effort hot-reload — swallow errors */
		}
	};

	/** Filesystem poll interval — 2s is a tradeoff between responsiveness
	 *  to rule edits and IO overhead. */
	const WATCH_POLL_INTERVAL_MS = 2_000;
	// Watch both files (if they exist, watchFile still works if they don't)
	watchFile(teamPath, { interval: WATCH_POLL_INTERVAL_MS }, reload);
	watchFile(localPath, { interval: WATCH_POLL_INTERVAL_MS }, reload);

	return () => {
		unwatchFile(teamPath, reload);
		unwatchFile(localPath, reload);
	};
}
