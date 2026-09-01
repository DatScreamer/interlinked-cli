// ===========================================
// Merge parity — every GuardRulesConfig key must be CLASSIFIED
// ===========================================
// The recurring bug class this pins (5 instances by 2026-07-02):
// a key is added to GuardRulesConfig + default-config, but no branch is added
// to rules/merge.ts — so `{"<key>": {...}}` in guard-rules.local.json is
// SILENTLY DROPPED and the documented override path is a no-op
// (grep_acceleration, structural_checks, per_edit_coverage, per_edit_mutation,
// trajectory_shadow — each found live, months apart).
//
// The fix shape (registry-parity pattern): every top-level key must appear in
// exactly ONE of the two tables below —
//   • LOCAL_PROBES — locally overridable; the probe MUST take effect, or
//   • EXEMPT — deliberately not local-mergeable, with a written rationale;
//     the probe MUST have no effect (pins the tier boundary both ways).
// Adding a 36th key to GuardRulesConfig without classifying it here is a
// COMPILE error (the assertExhaustive calls), not a runtime discovery.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GuardRulesConfig } from "../../types.js";
import { DEFAULT_CONFIG } from "../default-config.js";
import { mergeLocalOverrides, mergeTeamRules } from "../merge.js";

function mkBaseConfig() {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as typeof DEFAULT_CONFIG;
}

/** Cast helper: probes only need to be shaped well enough for their branch. */
function asCfg<K extends keyof GuardRulesConfig>(v: unknown): NonNullable<GuardRulesConfig[K]> {
	return v as NonNullable<GuardRulesConfig[K]>;
}

interface LocalProbe {
	override: Partial<GuardRulesConfig>;
	changed: (c: GuardRulesConfig) => boolean;
}

// Runtime-derived flips so the probes stay correct if a default flips later.
const csEnabled = DEFAULT_CONFIG.content_scanner?.enabled ?? false;
const scEnabled = DEFAULT_CONFIG.structural_checks.enabled;
const pecEnabled = DEFAULT_CONFIG.per_edit_coverage?.enabled ?? false;
const pemEnabled = DEFAULT_CONFIG.per_edit_mutation?.enabled ?? false;
const tsEnabled = DEFAULT_CONFIG.trajectory_shadow?.enabled ?? false;

const LOCAL_PROBES = {
	disabled_rules: {
		override: { disabled_rules: ["parity-probe-rule"] },
		changed: (c) => c.disabled_rules?.[0] === "parity-probe-rule",
	},
	extra_exceptions: {
		override: { extra_exceptions: { "parity-probe": ["x"] } },
		changed: (c) => Boolean(c.extra_exceptions?.["parity-probe"]),
	},
	file_reminders: {
		override: { file_reminders: [{ glob: "**/parity-probe", message: "p" }] },
		changed: (c) => c.file_reminders.some((r) => r.glob === "**/parity-probe"),
	},
	quality_checks: {
		override: {
			quality_checks: {
				parity_probe: { enabled: true, file_types: [".parity"], timeout_ms: 1, severity: "warning" },
			},
		},
		changed: (c) => Boolean(c.quality_checks.parity_probe),
	},
	project_wide_checks: {
		override: { project_wide_checks: asCfg<"project_wide_checks">({ __parity: true }) },
		changed: (c) => (c.project_wide_checks as unknown as Record<string, unknown>).__parity === true,
	},
	content_scanner: {
		override: { content_scanner: asCfg<"content_scanner">({ enabled: !csEnabled }) },
		changed: (c) => c.content_scanner?.enabled === !csEnabled,
	},
	structural_checks: {
		override: { structural_checks: asCfg<"structural_checks">({ enabled: !scEnabled }) },
		changed: (c) => c.structural_checks.enabled === !scEnabled,
	},
	plan_capture: {
		override: { plan_capture: asCfg<"plan_capture">({ enabled: true }) },
		changed: (c) => c.plan_capture?.enabled === true,
	},
	git_session_scope_gate: {
		override: { git_session_scope_gate: asCfg<"git_session_scope_gate">({ enabled: true, mode: "ask" }) },
		changed: (c) => c.git_session_scope_gate?.enabled === true,
	},
	tsc_overlay: {
		override: { tsc_overlay: asCfg<"tsc_overlay">({ mode: "in-process" }) },
		changed: (c) => c.tsc_overlay?.mode === "in-process",
	},
	linked_projects: {
		override: { linked_projects: ["../parity-probe"] },
		changed: (c) => c.linked_projects?.includes("../parity-probe") === true,
	},
	grep_acceleration: {
		override: { grep_acceleration: asCfg<"grep_acceleration">({ substitution_enabled: true }) },
		changed: (c) => c.grep_acceleration?.substitution_enabled === true,
	},
	per_edit_coverage: {
		override: { per_edit_coverage: asCfg<"per_edit_coverage">({ enabled: !pecEnabled }) },
		changed: (c) => c.per_edit_coverage?.enabled === !pecEnabled,
	},
	per_edit_mutation: {
		override: { per_edit_mutation: asCfg<"per_edit_mutation">({ enabled: !pemEnabled }) },
		changed: (c) => c.per_edit_mutation?.enabled === !pemEnabled,
	},
	trajectory_shadow: {
		override: { trajectory_shadow: { enabled: !tsEnabled } },
		changed: (c) => c.trajectory_shadow?.enabled === !tsEnabled,
	},
	scratchpad_guard: {
		override: { scratchpad_guard: { code_write_mode: "warn" } },
		changed: (c) => c.scratchpad_guard?.code_write_mode === "warn",
	},
	spec_checks: {
		override: { spec_checks: { enabled: false } },
		changed: (c) => c.spec_checks?.enabled === false,
	},
	edit_contract: {
		override: { edit_contract: { stale_read: "off" } },
		changed: (c) => c.edit_contract?.stale_read === "off",
	},
	scratchpad_archive: {
		override: { scratchpad_archive: { enabled: false } },
		changed: (c) => c.scratchpad_archive?.enabled === false,
	},
	baseline_autofold: {
		override: { baseline_autofold: { enabled: false } },
		changed: (c) => c.baseline_autofold?.enabled === false,
	},
	verification_stop_checks: {
		override: {
			verification_stop_checks: asCfg<"verification_stop_checks">({
				warn_spec_drift: false,
			}),
		},
		changed: (c) => c.verification_stop_checks?.warn_spec_drift === false,
	},
	mutation_directed_strict_profile: {
		override: { mutation_directed_strict_profile: { enabled: true } },
		changed: (c) => c.mutation_directed_strict_profile?.enabled === true,
	},
	// `interlinked mode --local` writes commit_cadence posture to the local file.
	commit_cadence: {
		override: { commit_cadence: asCfg<"commit_cadence">({ enabled: false }) },
		changed: (c) => (c.commit_cadence as unknown as { enabled?: boolean })?.enabled === false,
	},
} as const satisfies Partial<Record<keyof GuardRulesConfig, LocalProbe>>;

// ───────────────────────────────────────────────────────────────
// TEAM-tier classification — EXHAUSTIVE (review 2026-08-29 P1). Every
// GuardRulesConfig key must appear in exactly one of TEAM_PROBES (mergeable
// through mergeTeamRules — the probe MUST take effect) or NOT_TEAM
// (deliberately rejected at the team tier — the probe MUST have no effect).
// The assertExhaustive calls below make an unclassified new key a COMPILE
// error, closing the hole the partial table left: the committed
// guard-rules.json enabled mutation_directed_strict_profile while
// mergeTeamRules silently dropped the section ("configured but unreachable").
// ───────────────────────────────────────────────────────────────
const firstQualityCheckKey = Object.keys(DEFAULT_CONFIG.quality_checks)[0] ?? "";

const TEAM_PROBES = {
	enabled: {
		override: { enabled: false },
		changed: (c) => c.enabled === false,
	},
	rules: {
		override: { rules: asCfg<"rules">([{ id: "team-parity-rule" }]) },
		changed: (c) => (c.rules as Array<{ id?: string }>).some((r) => r.id === "team-parity-rule"),
	},
	protected_files: {
		override: { protected_files: asCfg<"protected_files">([{ glob: "**/team-parity", reason: "p" }]) },
		changed: (c) =>
			(c.protected_files as Array<{ glob?: string }>).some((r) => r.glob === "**/team-parity"),
	},
	file_reminders: {
		override: { file_reminders: [{ glob: "**/team-parity", message: "p" }] },
		changed: (c) => c.file_reminders.some((r) => r.glob === "**/team-parity"),
	},
	curl_mcp_detection: {
		override: { curl_mcp_detection: asCfg<"curl_mcp_detection">({ escalate_after: 777 }) },
		changed: (c) =>
			(c.curl_mcp_detection as unknown as { escalate_after?: number }).escalate_after === 777,
	},
	quality_checks: {
		// Team may only toggle SAFE fields on an EXISTING check (never commands
		// or new entries — pinned in merge.test.ts); the parity probe is that
		// safe-field path working at all.
		override: {
			quality_checks: asCfg<"quality_checks">({ [firstQualityCheckKey]: { timeout_ms: 777_777 } }),
		},
		changed: (c) => c.quality_checks[firstQualityCheckKey]?.timeout_ms === 777_777,
	},
	error_memory: {
		override: { error_memory: asCfg<"error_memory">({ __team_parity: true }) },
		changed: (c) => (c.error_memory as unknown as Record<string, unknown>).__team_parity === true,
	},
	project_specific: {
		override: { project_specific: asCfg<"project_specific">({ __team_parity: true }) },
		changed: (c) =>
			(c.project_specific as unknown as Record<string, unknown>)?.__team_parity === true,
	},
	policy_classifier: {
		override: { policy_classifier: asCfg<"policy_classifier">({ __team_parity: true }) },
		changed: (c) =>
			(c.policy_classifier as unknown as Record<string, unknown>)?.__team_parity === true,
	},
	auto_coordination: {
		override: { auto_coordination: asCfg<"auto_coordination">({ __team_parity: true }) },
		changed: (c) =>
			(c.auto_coordination as unknown as Record<string, unknown>)?.__team_parity === true,
	},
	project_wide_checks: {
		override: { project_wide_checks: asCfg<"project_wide_checks">({ __team_parity: true }) },
		changed: (c) => (c.project_wide_checks as unknown as Record<string, unknown>)?.__team_parity === true,
	},
	grep_acceleration: {
		override: { grep_acceleration: asCfg<"grep_acceleration">({ substitution_enabled: true }) },
		changed: (c) => c.grep_acceleration?.substitution_enabled === true,
	},
	mutation_directed_strict_profile: {
		override: { mutation_directed_strict_profile: { enabled: true } },
		changed: (c) => c.mutation_directed_strict_profile?.enabled === true,
	},
	// Mode/wizard POSTURE sections (review 2026-08-30 P0): `interlinked mode`
	// and the setup wizard write these to the committed file; only whitelisted
	// safe fields merge (see the "unsafe posture fields" describe below).
	structural_checks: {
		override: { structural_checks: asCfg<"structural_checks">({ test_first: true }) },
		changed: (c) => (c.structural_checks as unknown as { test_first?: boolean }).test_first === true,
	},
	per_edit_coverage: {
		override: { per_edit_coverage: asCfg<"per_edit_coverage">({ debt_mode: true }) },
		changed: (c) => c.per_edit_coverage?.debt_mode === true,
	},
	verification_stop_checks: {
		override: { verification_stop_checks: asCfg<"verification_stop_checks">({ enabled: false }) },
		changed: (c) =>
			(c.verification_stop_checks as unknown as { enabled?: boolean })?.enabled === false,
	},
	commit_cadence: {
		override: { commit_cadence: asCfg<"commit_cadence">({ enabled: false }) },
		changed: (c) => (c.commit_cadence as unknown as { enabled?: boolean })?.enabled === false,
	},
	diff_aware: {
		override: { diff_aware: asCfg<"diff_aware">({ enabled: true }) },
		changed: (c) => c.diff_aware?.enabled === true,
	},
} as const satisfies Partial<Record<keyof GuardRulesConfig, LocalProbe>>;

type TeamKey = keyof typeof TEAM_PROBES;

/** Keys the TEAM tier deliberately does NOT merge. `why` is the policy;
 *  `probe` is a value that must have no effect through mergeTeamRules. */
const NOT_TEAM = {
	version: { why: "schema stamp", probe: 999 },
	disabled_rules: { why: "personal tuning tier (mergeLocalOverrides)", probe: ["x"] },
	extra_exceptions: { why: "personal tuning tier", probe: { x: ["y"] } },
	content_scanner: { why: "carries runtime/endpoint knobs — machine-local trust tier", probe: { enabled: true } },
	plan_capture: { why: "personal opt-in", probe: { enabled: true } },
	git_session_scope_gate: { why: "personal opt-in", probe: { enabled: true } },
	tsc_overlay: { why: "machine-local runtime knob", probe: { mode: "in-process" } },
	linked_projects: { why: "SECURITY: widens write-confinement — must stay a per-dev local choice", probe: ["/p"] },
	per_edit_mutation: { why: "personal opt-in tier (runner endpoints are local config)", probe: { enabled: true } },
	trajectory_shadow: { why: "personal tier", probe: { enabled: false } },
	scratchpad_guard: { why: "personal softening tier", probe: { code_write_mode: "warn" } },
	spec_checks: { why: "personal tier", probe: { enabled: false } },
	edit_contract: { why: "personal tier", probe: { stale_read: "off" } },
	scratchpad_archive: { why: "personal tier", probe: { enabled: false } },
	baseline_autofold: { why: "personal tier", probe: { enabled: false } },
	taint_tracking: { why: "default-only today", probe: { __parity: true } },
	output_scanning: { why: "default-only today", probe: { __parity: true } },
	skip_paths: { why: "loader/preset-managed", probe: ["p"] },
	suggestion_limit: { why: "default-only today", probe: 42 },
	suggestion_threshold: { why: "default-only today", probe: 42 },
	repo_confinement_allowlist: { why: "SECURITY boundary — never via a committed file a PR can edit", probe: ["/p"] },
	required_tools: { why: "preset-managed", probe: ["p"] },
	strict_skips: { why: "preset-managed", probe: { __parity: true } },
	skip_allowlist: { why: "preset-managed", probe: { __parity: true } },
} as const satisfies Partial<Record<keyof GuardRulesConfig, { why: string; probe: unknown }>>;

type NotTeamKey = keyof typeof NOT_TEAM;

/** Deliberately NOT local-mergeable. Every entry carries the WHY — moving a key
 *  out of here is a policy decision, made visible in the diff. */
const EXEMPT = {
	version: { why: "config-schema version stamp — never overridable", probe: 999 },
	enabled: {
		why: "master kill-switch is team-tier + `interlinked disable` (audited); a silent local off would defeat the guard's purpose",
		probe: false,
	},
	rules: { why: "guard-rule SET is team surface; local tuning goes through disabled_rules / extra_exceptions", probe: [] },
	protected_files: { why: "committed team policy surface", probe: [] },
	curl_mcp_detection: { why: "team-tier tunable only (mergeTeamRules)", probe: { escalate_after: 999 } },
	error_memory: { why: "team-tier tunable only (mergeTeamRules)", probe: { __parity: true } },
	taint_tracking: { why: "default-only today — no override tier designed yet", probe: { __parity: true } },
	output_scanning: { why: "default-only today — no override tier designed yet", probe: { __parity: true } },
	project_specific: { why: "team-tier (mergeTeamRules)", probe: { __parity: true } },
	skip_paths: { why: "default/preset-managed by the loader, not a per-dev override", probe: ["parity"] },
	suggestion_limit: { why: "default-only today", probe: 42 },
	suggestion_threshold: { why: "default-only today", probe: 42 },
	repo_confinement_allowlist: {
		why: "security boundary — write-scope widening must stay explicit (linked_projects is the audited local path)",
		probe: ["/parity"],
	},
	required_tools: { why: "default/preset-managed", probe: ["parity"] },
	strict_skips: { why: "default/preset-managed", probe: { __parity: true } },
	skip_allowlist: { why: "default/preset-managed", probe: { __parity: true } },
	diff_aware: { why: "team-posture tier (mergeTeamRules whitelist); no local override designed", probe: { __parity: true } },
	policy_classifier: { why: "team-tier (mergeTeamRules)", probe: { __parity: true } },
	auto_coordination: { why: "team-tier (mergeTeamRules)", probe: { __parity: true } },
} as const satisfies Partial<Record<keyof GuardRulesConfig, { why: string; probe: unknown }>>;

type LocalKey = keyof typeof LOCAL_PROBES;
type ExemptKey = keyof typeof EXEMPT;

/** Compile-time only: instantiating with a non-never type is a tsc error. */
function assertExhaustive<T extends never>(): T | undefined {
	return undefined;
}

describe("merge parity — every GuardRulesConfig key classified exactly once", () => {
	it("covers the whole key universe (enforced at compile time)", () => {
		// A 36th key on GuardRulesConfig fails HERE at typecheck until classified.
		assertExhaustive<Exclude<keyof GuardRulesConfig, LocalKey | ExemptKey>>();
		// No key may be in both tables.
		assertExhaustive<Extract<LocalKey, ExemptKey>>();
		expect(Object.keys(LOCAL_PROBES).length + Object.keys(EXEMPT).length).toBeGreaterThan(30);
	});

	for (const [key, spec] of Object.entries(LOCAL_PROBES) as Array<[LocalKey, LocalProbe]>) {
		it(`local override for \`${key}\` takes effect (merge branch exists + works)`, () => {
			const config = mkBaseConfig();
			mergeLocalOverrides(config, spec.override);
			expect(spec.changed(config)).toBe(true);
		});
	}

	// test-contract: bug — the "configured but unreachable" class, generalized:
	// the repo's REAL committed team file carried five keys mergeTeamRules
	// silently dropped (per_edit_coverage, diff_aware, structural_checks,
	// verification_stop_checks, commit_cadence — review 2026-08-29). Every key
	// actually committed must be team-mergeable, or it is dead policy prose.
	it("every key in the repository's committed guard-rules.json is team-mergeable", () => {
		const committedPath = join(process.cwd(), ".interlinked", "guard-rules.json");
		const committed = JSON.parse(readFileSync(committedPath, "utf-8")) as Record<string, unknown>;
		const teamKeys = new Set<string>(Object.keys(TEAM_PROBES));
		const unreachable = Object.keys(committed).filter((k) => !teamKeys.has(k));
		expect(unreachable).toEqual([]);
	});

	it("classifies every key for the TEAM tier too (enforced at compile time)", () => {
		// A new GuardRulesConfig key fails HERE at typecheck until it is placed
		// in TEAM_PROBES (merged) or NOT_TEAM (explicitly rejected, with a why).
		assertExhaustive<Exclude<keyof GuardRulesConfig, TeamKey | NotTeamKey>>();
		// No key may claim both tiers.
		assertExhaustive<Extract<TeamKey, NotTeamKey>>();
		expect(Object.keys(TEAM_PROBES).length + Object.keys(NOT_TEAM).length).toBeGreaterThan(40);
	});

	// SAFETY: Object.entries erases the const table's key type; the table is
	// declared `satisfies Partial<Record<keyof GuardRulesConfig, LocalProbe>>`
	// so the re-narrowing only restores what the literal guarantees.
	for (const [key, spec] of Object.entries(TEAM_PROBES) as Array<[TeamKey, LocalProbe]>) {
		it(`team-config option \`${key}\` takes effect through mergeTeamRules`, () => {
			const config = mkBaseConfig();
			mergeTeamRules(config, spec.override);
			expect(spec.changed(config)).toBe(true);
		});
	}

	// SAFETY: same Object.entries re-narrowing as above, for the NOT_TEAM table.
	for (const [key, entry] of Object.entries(NOT_TEAM) as Array<
		[NotTeamKey, { why: string; probe: unknown }]
	>) {
		it(`team config CANNOT set \`${key}\` (${entry.why.slice(0, 48)}…)`, () => {
			const config = mkBaseConfig();
			const before = JSON.stringify(config[key]);
			mergeTeamRules(config, { [key]: entry.probe } as Partial<GuardRulesConfig>);
			expect(JSON.stringify(config[key])).toBe(before);
		});
	}

	for (const [key, entry] of Object.entries(EXEMPT) as Array<[ExemptKey, { why: string; probe: unknown }]>) {
		it(`exempt \`${key}\` is untouched by a local override (${entry.why.slice(0, 48)}…)`, () => {
			const config = mkBaseConfig();
			const before = JSON.stringify(config[key]);
			mergeLocalOverrides(config, { [key]: entry.probe } as Partial<GuardRulesConfig>);
			expect(JSON.stringify(config[key])).toBe(before);
		});
	}
});
