// ===========================================
// Enforcement modes — balanced / strict / lenient presets
// ===========================================
// A "mode" is a named preset that overrides individual check actions on top
// of the registry defaults. It lives in `.interlinked/check-policy.json`
// under the top-level `mode` key, and the check-policy loader applies the
// mode's overrides BEFORE any user-specified `checks` / `overrides` entries
// (so per-check user tweaks still win).
//
// Three built-in modes plus "custom" (user-authored policy, no preset applied).

import type { CheckAction, CheckPolicyEntry } from "./check-policy.js";

export type ModeName = "balanced" | "strict" | "lenient" | "custom";

export interface ModePreset {
	name: ModeName;
	description: string;
	/** Per-check action overrides. Check IDs not listed here keep their
	 *  registration default. */
	check_overrides: Readonly<Record<string, CheckAction>>;
	/** Override the global default action for checks that aren't named
	 *  explicitly. Omit to keep the built-in default (`warn_after`). */
	default_action?: CheckAction;
}

// -----------------------------------------------------------------------------
// Presets
// -----------------------------------------------------------------------------

/** Balanced — today's shipping defaults. Truly-destructive commands already
 *  block (guard rules, outside this system). Everything else warns. */
export const BALANCED: ModePreset = {
	name: "balanced",
	description:
		"Default. Destructive commands blocked; type errors and lint issues warn after edits land.",
	check_overrides: {},
};

/** Strict — promote low-FP, high-value checks from post → pre_block so
 *  broken code never reaches disk. Only checks whose cost fits the modify
 *  class budget (<800ms) are in here; heavier checks stay post. */
export const STRICT: ModePreset = {
	name: "strict",
	description:
		"Block edits that would introduce type, lint, or test-quality errors before they land.",
	check_overrides: {
		// Test-quality — tiny regex/AST checks, very low FP.
		focused_tests: "ask",
		placeholder_test: "ask",
		assertion_free_test: "ask",
		tautological_assertion: "ask",
		// Type/promise correctness — fully deterministic.
		promise_reject_non_error: "ask",
		floating_promises: "ask",
		// Agent-quality — clear rules.
		broad_object_types: "warn_before",
		commented_out_code: "warn_before",
		default_export: "warn_before",
	},
};

/** Lenient — warn on everything possible; only the guard-rules layer (which
 *  this policy does not govern) remains blocking. Useful for exploratory
 *  sessions, migrations, or unfamiliar codebases. */
export const LENIENT: ModePreset = {
	name: "lenient",
	description:
		"Advisory only — warn on issues but never block. Destructive guard rules still apply.",
	check_overrides: {},
	default_action: "info",
};

export const ALL_PRESETS: readonly ModePreset[] = [BALANCED, STRICT, LENIENT] as const;

const PRESETS_BY_NAME: Readonly<Record<string, ModePreset>> = {
	balanced: BALANCED,
	strict: STRICT,
	lenient: LENIENT,
};

export function getPreset(name: ModeName): ModePreset | null {
	if (name === "custom") return null;
	return PRESETS_BY_NAME[name] ?? null;
}

export function isKnownMode(name: string): name is ModeName {
	return name === "balanced" || name === "strict" || name === "lenient" || name === "custom";
}

// -----------------------------------------------------------------------------
// Materialize preset → policy entries
// -----------------------------------------------------------------------------

/** Return a `CheckPolicyEntry` map equivalent to the preset's check_overrides.
 *  Used both at load time (to compute effective policy) and at write time
 *  (to snapshot what "strict" meant when the user enabled it). */
export function presetToPolicyEntries(preset: ModePreset): Record<string, CheckPolicyEntry> {
	const out: Record<string, CheckPolicyEntry> = {};
	for (const [id, action] of Object.entries(preset.check_overrides)) {
		out[id] = { action };
	}
	return out;
}

// -----------------------------------------------------------------------------
// Diff two presets — powers `interlinked mode strict --diff`
// -----------------------------------------------------------------------------

export interface ModeDiffEntry {
	check_id: string;
	from_action: CheckAction | "(default)";
	to_action: CheckAction;
}

export function diffPresets(from: ModePreset, to: ModePreset): ModeDiffEntry[] {
	const keys = new Set<string>([
		...Object.keys(from.check_overrides),
		...Object.keys(to.check_overrides),
	]);
	const out: ModeDiffEntry[] = [];
	for (const key of Array.from(keys).sort()) {
		const fromAction = from.check_overrides[key] ?? "(default)";
		const toAction = to.check_overrides[key] ?? to.default_action ?? "warn_after";
		if (fromAction !== toAction) {
			out.push({ check_id: key, from_action: fromAction, to_action: toAction });
		}
	}
	return out;
}
