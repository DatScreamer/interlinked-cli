// ===========================================
// Active-When Predicate Evaluator
// ===========================================
//
// Decides whether a rule's runtime scope condition is satisfied. Rules
// without `active_when` are always-on (current behavior). Rules with
// `active_when` are dormant unless every listed axis holds.
//
// Five axes, AND-ed:
//   - skill: at least one named skill is in `session.active_skills` and unexpired
//   - phase: a typed phase predicate matches (ship/review/...; TDD is excluded
//            here — owned by native primitives, see /enforce SKILL.md §2d)
//   - after_command: a regex matches one of the last N entries in commands_run
//   - file_scope: an extra file_path regex matches (AND-ed beyond rule.patterns)
//   - overlay / agent_source: the call's agent_source is in the listed set
//
// Wired into evaluator/pre-tool.ts and evaluator/post-tool.ts before pattern
// evaluation so dormant rules short-circuit without spending regex cycles.
// See docs/design/harness-active-when-scoping.md.

import type {
	ActiveWhen,
	AfterCommandSpec,
	GuardRule,
	HarnessEvent,
	PhaseSpec,
	SessionTrajectory,
} from "../types.js";

/** Default after-command window size when the spec omits it. */
const DEFAULT_AFTER_COMMAND_WINDOW = 10;

/** Regex cache shared across rule evaluations. Patterns come from
 *  admin-authored or distiller-emitted configs; caching avoids recompiling
 *  on every PreToolUse. */
const _activeWhenRegexCache = new Map<string, RegExp>();

function getCachedRegex(pattern: string, flags = "i"): RegExp {
	const key = `${pattern}\0${flags}`;
	let re = _activeWhenRegexCache.get(key);
	if (!re) {
		// Reason: pattern comes from trusted configs, not user/agent input.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		re = new RegExp(pattern, flags);
		_activeWhenRegexCache.set(key, re);
	}
	re.lastIndex = 0;
	return re;
}

/** Public API — return true when the rule's scope condition is satisfied
 *  (or absent). Callers AND this with their existing trigger/tool/role
 *  filters to decide whether to evaluate the rule's patterns. */
export function evaluateActiveWhen(
	rule: GuardRule,
	session: SessionTrajectory | undefined,
	event: HarnessEvent,
): boolean {
	if (!rule.active_when) return true;
	const aw = rule.active_when;

	if (aw.skill !== undefined && !evaluateSkillAxis(aw.skill, session)) return false;
	if (aw.phase && !evaluatePhaseAxis(aw.phase, session, event)) return false;
	if (aw.after_command && !evaluateAfterCommandAxis(aw.after_command, session)) return false;
	if (aw.file_scope && !evaluateFileScopeAxis(aw.file_scope, event)) return false;
	if (aw.overlay !== undefined && !evaluateOverlayAxis(aw.overlay, event)) return false;
	if (aw.agent_source !== undefined && !evaluateAgentSourceAxis(aw.agent_source, event)) {
		return false;
	}
	if (aw.predicate) {
		// Generic escape-hatch predicates are not implemented in v1. Fail
		// safely: a rule referencing an unknown predicate stays dormant
		// rather than firing on every call. The /enforce skill mandates
		// that distilled rules using `predicate` also set action="ask",
		// so a dormant predicate degrades to "no-op", which is correct.
		return false;
	}

	return true;
}

function evaluateSkillAxis(
	required: string | string[],
	session: SessionTrajectory | undefined,
): boolean {
	const active = session?.active_skills;
	if (!active || active.size === 0) return false;
	const wanted = Array.isArray(required) ? required : [required];
	const now = Date.now();
	for (const name of wanted) {
		const rec = active.get(name);
		if (rec && rec.expires_at > now) return true;
	}
	return false;
}

function evaluatePhaseAxis(
	_phase: PhaseSpec,
	_session: SessionTrajectory | undefined,
	_event: HarnessEvent,
): boolean {
	// Phase state machines for ship / review / etc. don't exist yet, and
	// `tdd_state` is harness-internal-only (TDD enforcement is owned by
	// native primitives — see skills/enforce/SKILL.md §2d skip list, which
	// drops TDD-themed skills before the distiller can emit phase rules).
	// Conservative: any phase-axis rule stays dormant in v1. When a phase
	// state machine lands, this dispatch reads from
	// `session.<phase_namespace>` and matches `_phase.name` / `_phase.value`.
	return false;
}

function evaluateAfterCommandAxis(
	spec: AfterCommandSpec,
	session: SessionTrajectory | undefined,
): boolean {
	const commands = session?.commands_run;
	if (!commands || commands.length === 0) return false;
	const window = spec.window_steps ?? DEFAULT_AFTER_COMMAND_WINDOW;
	const slice = window > 0 ? commands.slice(-window) : commands;
	const re = getCachedRegex(spec.pattern);
	for (const cmd of slice) {
		if (re.test(cmd)) return true;
	}
	return false;
}

function evaluateFileScopeAxis(pattern: string, event: HarnessEvent): boolean {
	const filePath =
		(event.tool_input?.file_path as string | undefined) ||
		(event.tool_input?.path as string | undefined) ||
		"";
	if (!filePath) return false;
	return getCachedRegex(pattern).test(filePath);
}

function evaluateOverlayAxis(required: string | string[], event: HarnessEvent): boolean {
	// Until a separate overlay-tracking mechanism lands, the overlay axis
	// is treated as a synonym for agent_source — the model-overlay file
	// (e.g., model-overlays/claude.md) maps directly to a runtime agent.
	const wanted = Array.isArray(required) ? required : [required];
	return wanted.includes(event.agent_source);
}

function evaluateAgentSourceAxis(
	required: GuardRule["applies_to_roles"] extends infer _U ? string | string[] : never,
	event: HarnessEvent,
): boolean {
	const wanted = Array.isArray(required) ? required : [required];
	return wanted.includes(event.agent_source);
}

/** Public API — exposed for tests and the future conflict detector that
 *  needs to determine whether two rules' scopes can intersect at runtime. */
export function describeActiveWhen(aw: ActiveWhen | undefined): string {
	if (!aw) return "always-on";
	const parts: string[] = [];
	if (aw.skill !== undefined) {
		const list = Array.isArray(aw.skill) ? aw.skill : [aw.skill];
		parts.push(`skill∈{${list.join(",")}}`);
	}
	if (aw.phase) parts.push(`phase=${aw.phase.name}:${aw.phase.value}`);
	if (aw.after_command) {
		parts.push(`after_command~/${aw.after_command.pattern}/`);
	}
	if (aw.file_scope) parts.push(`file_scope~/${aw.file_scope}/`);
	if (aw.overlay !== undefined) {
		const list = Array.isArray(aw.overlay) ? aw.overlay : [aw.overlay];
		parts.push(`overlay∈{${list.join(",")}}`);
	}
	if (aw.agent_source !== undefined) {
		const list = Array.isArray(aw.agent_source) ? aw.agent_source : [aw.agent_source];
		parts.push(`agent_source∈{${list.join(",")}}`);
	}
	if (aw.predicate) parts.push(`predicate=${aw.predicate.name}`);
	return parts.length === 0 ? "always-on" : parts.join(" ∧ ");
}
