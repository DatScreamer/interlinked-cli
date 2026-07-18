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

import { describe, expect, it } from "vitest";
import type { GuardRulesConfig } from "../../types.js";
import { DEFAULT_CONFIG } from "../default-config.js";
import { mergeLocalOverrides } from "../merge.js";

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
	verification_stop_checks: {
		override: {
			verification_stop_checks: asCfg<"verification_stop_checks">({
				warn_spec_drift: false,
			}),
		},
		changed: (c) => c.verification_stop_checks?.warn_spec_drift === false,
	},
} as const satisfies Partial<Record<keyof GuardRulesConfig, LocalProbe>>;

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
	diff_aware: { why: "default/preset-managed", probe: { __parity: true } },
	policy_classifier: { why: "team-tier (mergeTeamRules)", probe: { __parity: true } },
	auto_coordination: { why: "team-tier (mergeTeamRules)", probe: { __parity: true } },
	commit_cadence: { why: "default-only today", probe: { __parity: true } },
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

	for (const [key, entry] of Object.entries(EXEMPT) as Array<[ExemptKey, { why: string; probe: unknown }]>) {
		it(`exempt \`${key}\` is untouched by a local override (${entry.why.slice(0, 48)}…)`, () => {
			const config = mkBaseConfig();
			const before = JSON.stringify(config[key]);
			mergeLocalOverrides(config, { [key]: entry.probe } as Partial<GuardRulesConfig>);
			expect(JSON.stringify(config[key])).toBe(before);
		});
	}
});
