// ===========================================
// Setup wizard — the harness-first onboarding decision flow
// ===========================================
// The product a new user is adopting is the LOCAL HARNESS (CLAUDE.md Goal 1),
// but the legacy first-run wizard asked only server-era questions (URL, sync,
// login) and silently inherited every opinionated default. This module is the
// decision surface: four questions that define how the harness treats the
// repo — runners, enforcement mode, review scope, caps — plus the brownfield
// floor (`adopt`). It COMPOSES the existing single-purpose machinery
// (`enable`, `mode`, `caps set`, `adopt`) rather than re-implementing any of
// it: each answer routes to the command a user would later use to change that
// answer, so the wizard teaches its own escape hatches.
//
// Operator directive (2026-08-16): onboarding must let people "simply and
// quickly make the decisions for how they want the agent to work the codebase
// going forward, including but not limited to hooks." Time budget ~90s; Enter
// accepts the recommended default at every step; a failing step reports and
// continues (a half-onboarded repo with hooks installed beats an aborted
// wizard — every step is individually re-runnable).
//
// Local-first: the sync default here is "local" (offline-only). The remote
// server is dormant (CLAUDE.md: "the local harness is the product") and a new
// adopter should never be asked to think about it — `interlinked login` /
// `enable --server` remain for the users who want it.

import { METRIC_DEFS } from "../harness/metric-caps.js";
import { getPreset } from "../harness/modes.js";
import { mergeIntoGuardRules } from "../harness/rules/guard-rules-write.js";

/** The review-scope decision: judge only the edited region, or whole files. */
export type WizardScope = "diff" | "whole-file";

/** Enforcement-mode names accepted by the wizard (mirrors harness/modes.ts). */
const WIZARD_MODES = ["strict", "lenient", "balanced"] as const;
export type WizardMode = (typeof WIZARD_MODES)[number];

export interface WizardChoices {
	/** Runner client ids to hook, or null = every detected client. */
	runners: string[] | null;
	mode: WizardMode;
	scope: WizardScope;
	/** Cap overrides by `interlinked caps` metric key; empty = ship defaults. */
	caps: Record<string, number>;
	/** Seed tighten-only baselines from the repo's current state (brownfield). */
	adopt: boolean;
	/** Sync mode passed to enable; local-first by design (server is dormant). */
	syncMode: "local" | "realtime" | "manual";
}

export const DEFAULT_WIZARD_CHOICES: WizardChoices = {
	runners: null,
	mode: "strict",
	scope: "diff",
	caps: {},
	adopt: true,
	syncMode: "local",
};

/** Injected-deps seam: each step is the existing command it composes, so tests
 *  pin the composition (order + arguments) without mocking modules. */
export interface WizardDeps {
	enable: (opts: { clients?: string; syncMode: string }) => Promise<void>;
	applyMode: (name: WizardMode) => Promise<void>;
	setCap: (metric: string, value: number) => Promise<void>;
	adopt: () => Promise<void>;
	writeScope: (cwd: string, scope: WizardScope) => void;
}

export interface WizardApplyResult {
	/** Human-readable step failures; the wizard continues past each. */
	failures: string[];
}

/**
 * Apply the decisions, each step independently: enable (hooks) → mode →
 * scope → caps → adopt. Caps run BEFORE adopt on purpose — adopt seeds
 * baselines against the caps in force, so a user who tightened `lines` gets
 * a grandfather list computed against their number, not ours. A throwing
 * step is recorded and the remaining steps still run: every step is
 * individually re-runnable afterward, so partial progress is strictly
 * better than none.
 */
export async function applyWizardChoices(
	cwd: string,
	choices: WizardChoices,
	deps: WizardDeps,
): Promise<WizardApplyResult> {
	const failures: string[] = [];
	const step = async (label: string, run: () => Promise<void> | void): Promise<void> => {
		try {
			await run();
		} catch (err) {
			failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	await step("enable (hooks)", () =>
		deps.enable({
			...(choices.runners && choices.runners.length > 0
				? { clients: choices.runners.join(",") }
				: {}),
			syncMode: choices.syncMode,
		}),
	);
	await step("mode", () => deps.applyMode(choices.mode));
	await step("scope", () => deps.writeScope(cwd, choices.scope));
	for (const [metric, value] of Object.entries(choices.caps)) {
		await step(`cap ${metric}`, () => deps.setCap(metric, value));
	}
	if (choices.adopt) {
		await step("adopt (baseline floor)", () => deps.adopt());
	}
	return { failures };
}

/**
 * Write the review-scope decision into `.interlinked/guard-rules.json`
 * (shared, committed — the same file the daemon's rules loader merges).
 * Merge-preserving: only `diff_aware.enabled` moves; every other key —
 * including a nested pre-existing `diff_aware` sub-setting — survives.
 */
export function writeScopeConfig(cwd: string, scope: WizardScope): void {
	// Delegates to the ONE merge-preserving guard-rules.json writer (2026-08-17
	// — this function used to carry its own merge and the policy-drift check
	// caught the clone). Contract change with the delegation: a MALFORMED
	// existing file now refuses and throws (preserving the evidence for the
	// user) instead of rewriting cleanly; the wizard's per-step failure report
	// surfaces the thrown message and every step stays re-runnable.
	const r = mergeIntoGuardRules(cwd, { diff_aware: { enabled: scope === "diff" } });
	if (!r.ok) throw new Error(`scope not written: ${r.error}`);
}

/**
 * Arrow-key selection movement shared by the terminal runner and the browser
 * demo: wrap-around in both directions, clamped to the list. Single-sourced
 * so the two surfaces cannot disagree about how ↑/↓ behave.
 */
// interlinked: defer same_typed_primitive_params -- (index, delta, length) is the idiomatic signature for modular index math; a struct param would obscure the two call sites (TUI keyhandler, demo keydown)
export function moveSelection(index: number, delta: number, length: number): number {
	if (length <= 0) return 0;
	return (((index + delta) % length) + length) % length;
}

/** Yes/no answer parsing shared by the terminal runner and the browser demo —
 *  exported so both surfaces execute the SAME acceptance rules. */
export function parseWizardYesNo(raw: string, defaultValue: boolean): boolean {
	const v = raw.trim().toLowerCase();
	if (!v) return defaultValue;
	if (["y", "yes", "1", "true"].includes(v)) return true;
	if (["n", "no", "0", "false"].includes(v)) return false;
	return defaultValue;
}

/** Parse "cyclomatic=15,lines=400"-style cap overrides; invalid pairs drop.
 *  Shared by the terminal runner and the browser demo (single-source rule). */
export function parseWizardCapOverrides(raw: string): Record<string, number> {
	const caps: Record<string, number> = {};
	for (const pair of raw.split(",")) {
		const [k, val] = pair.split("=").map((s) => s.trim());
		const n = Number(val);
		if (k && Number.isFinite(n)) caps[k] = n;
	}
	return caps;
}

/** Non-interactive mapping (flags/env → choices). Unknown values degrade to
 *  the recommended defaults — a non-TTY bootstrap must never fail on input. */
export function choicesFromNonInteractive(
	raw: Partial<Record<"mode" | "scope" | "adopt" | "runners" | "syncMode", string>>,
): WizardChoices {
	// SAFETY: the cast is guarded by the includes() membership test on the same
	// value — outside the union it falls to the default branch.
	const mode = WIZARD_MODES.includes(raw.mode as WizardMode)
		? (raw.mode as WizardMode)
		: DEFAULT_WIZARD_CHOICES.mode;
	const scope: WizardScope =
		raw.scope === "diff" || raw.scope === "whole-file" ? raw.scope : DEFAULT_WIZARD_CHOICES.scope;
	const adopt =
		raw.adopt === undefined ? DEFAULT_WIZARD_CHOICES.adopt : !/^(false|no|0)$/i.test(raw.adopt);
	const runners = raw.runners
		? raw.runners
				.split(",")
				.map((r) => r.trim())
				.filter((r) => r.length > 0)
		: null;
	const syncMode =
		raw.syncMode === "realtime" || raw.syncMode === "manual"
			? raw.syncMode
			: DEFAULT_WIZARD_CHOICES.syncMode;
	return { runners, mode, scope, caps: {}, adopt, syncMode };
}

/**
 * Every user-facing string the wizard renders, in one exported structure.
 * SINGLE-SOURCE CONTRACT (2026-08-16, operator drift requirement): the
 * terminal runner (setup-wizard-run.ts) renders its prompts FROM this object,
 * and the browser demo generator (scripts/gen-onboarding-demo.mts) bundles
 * this same module — so the demo and the TUI cannot disagree on copy without
 * one of them failing its tests. Add or change wizard text HERE only.
 */
export const WIZARD_COPY = {
	banner: "Interlinked setup — 5 quick decisions",
	bannerHint: "Enter accepts the recommended default at every step.",
	selectHint: "↑/↓ choose · Enter confirm",
	steps: {
		runners: {
			n: 1,
			title: "Agent runners to hook",
			detectedPrefix: "detected: ",
			prompt: (ids: string[]) => `   Hook all detected? [Y] or list ids (${ids.join(",")}): `,
			noneDetected:
				"No agent runners detected — hooks install when one appears (interlinked enable).",
		},
		mode: {
			n: 2,
			title: "Enforcement mode:",
			prompt: (recommended: string) => `   Mode [${recommended}]: `,
		},
		scope: {
			n: 3,
			title: "Review scope:",
			diffLine: "judge only what the agent changes (recommended)",
			wholeFileLine: "judge every touched file in full — stricter, noisier on legacy code",
			prompt: "   Scope [diff]: ",
		},
		caps: {
			n: 4,
			title: "Quality caps + coverage goal (shipped defaults):",
			prompt: "   Accept all? [Y] or overrides like cyclomatic=15,coverage=90: ",
		},
		adopt: {
			n: 5,
			title: "Baselines — your repo as it is today becomes the floor;",
			detail: "interlinked only stops it getting worse (tighten-only ratchets).",
			prompt: "   Seed baselines from current state now? [Y/n]: ",
		},
	},
	planHeader: "Plan",
	applyPrompt: "\nApply? [Y/n]: ",
	aborted: "Aborted — nothing was written.",
	complete: "Setup complete.",
	receiptHeader: "Now enforced — every line names the command that changes it:",
	tourHeader: "What Interlinked runs for you from here:",
	tour: [
		"  every tool call judged live — ~260 checks + 123 guard rules; security rails block, findings warn",
		"  TDD: a new source file asks for its failing companion test first (strict blocks, balanced warns)",
		"  coverage: adopt seeds today's % as the floor; every edit holds-or-raises it toward your goal",
		"  mutation testing: `interlinked mutation` ratchets survivor scores per file; deep-audit lane, not per-edit by default",
		"  `interlinked verify` — the local CI mirror: types, lint, secrets, deps + the default check set",
		"  session end: a ranked stop digest and `interlinked status` scorecard, not a wall of warnings",
		"  agent skills installed per runner teach these gates from inside the agent's own context",
		"  everything local — no server, no account; `interlinked query` reads what it records",
	],
	nextSteps: [
		"Make any edit in your agent — the harness judges it live.",
		"  interlinked status     scorecard (edits judged, findings, blocks)",
		"  interlinked mode       switch enforcement mode any time",
		"  interlinked disable    the exit ramp — restores every settings file",
	],
} as const;

/** Render the decisions as a short confirmation plan — the user sees exactly
 *  what will happen (and which command owns each decision later) before it
 *  does. */
export function describeWizardPlan(choices: WizardChoices): string[] {
	const lines: string[] = [];
	lines.push(
		`  Runners: ${choices.runners ? choices.runners.join(", ") : "all detected"}  (change: interlinked enable --clients …)`,
	);
	lines.push(`  Mode: ${choices.mode}  (change: interlinked mode <name>)`);
	lines.push(
		`  Scope: ${choices.scope === "diff" ? "diff — judge only what the agent changes" : "whole-file — judge every touched file in full"}`,
	);
	const capEntries = Object.entries(choices.caps);
	lines.push(
		capEntries.length === 0
			? "  Caps: shipped defaults  (view: interlinked caps)"
			: `  Caps: ${capEntries.map(([k, v]) => `${k}=${v}`).join(", ")}  (change: interlinked caps set)`,
	);
	lines.push(
		choices.adopt
			? "  Baselines: adopt now — your repo today is the floor; interlinked only stops it getting worse"
			: "  Baselines: skipped  (run later: interlinked adopt)",
	);
	return lines;
}

/** One receipt line per cap: overrides win; coverage renders as a GOAL the
 *  ratchets climb toward (default 100), never as a bound. */
function capReceiptBits(caps: WizardChoices["caps"]): string[] {
	return METRIC_DEFS.map((d) => {
		const value = caps[d.key] ?? d.defaultValue;
		if (d.stricter !== "higher") return `${d.key} ≤ ${value}`;
		return value === 0 ? `${d.key} goal off (ratchet only)` : `${d.key} goal ${value} %`;
	});
}

/**
 * The posture receipt — printed AFTER the wizard applies, one line per thing
 * now enforced, each naming the command that changes it. Discoverability at
 * the moment curiosity strikes, instead of twenty onboarding questions
 * (operator decision 2026-08-17). Pure so the browser demo renders the SAME
 * receipt from the same module.
 */
export function describePostureReceipt(choices: WizardChoices): string[] {
	const preset = getPreset(choices.mode);
	const lines: string[] = [];
	lines.push(`  mode ${choices.mode} — ${preset?.description ?? "user-defined policy"}`);
	for (const p of preset?.posture ?? []) lines.push(`    · ${p}`);
	lines.push("    change: interlinked mode strict|balanced|lenient  (preview first: --diff)");
	lines.push(`  caps: ${capReceiptBits(choices.caps).join(" · ")}`);
	lines.push("    change: interlinked caps set <metric> <value>  ·  meanings: interlinked caps explain");
	lines.push(
		choices.scope === "diff"
			? "  scope: diff — only what the agent changes is judged  (rerun the wizard to widen)"
			: "  scope: whole-file — every touched file judged in full  (rerun the wizard to narrow)",
	);
	lines.push(
		choices.adopt
			? "  baselines: seeded from today's state; ratchets only tighten  (re-seed: interlinked adopt)"
			: "  baselines: NOT seeded — run interlinked adopt before the strict gates bite",
	);
	lines.push(
		choices.adopt
			? "  installs: current deps pre-approved; new packages need interlinked allowlist add <eco> <pkg>"
			: "  installs: fail-closed allowlist — pre-approve current deps: interlinked allowlist snapshot --by you",
	);
	lines.push(
		"  always on: destructive-command, secrets, and install rails; per-check tuning lives in .interlinked/check-policy.json",
	);
	return lines;
}
