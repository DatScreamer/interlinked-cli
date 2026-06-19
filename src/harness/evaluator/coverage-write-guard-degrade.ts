// interlinked-tdd: exempt
// ===========================================
// Per-edit coverage gate — fail-open warning / degrade / defer helpers
// ===========================================
// Extracted VERBATIM from coverage-write-guard.ts to keep that module under the
// per-file line cap. These are the leaf decision-builders the gate uses to ALLOW
// while staying loud (every uncovered-but-allowed write emits an agent-visible
// `[interlinked:coverage]` warning) plus the budget-defer obligation recorder.
// No behavior changed — same text, same control flow.

import {
	type CoverageObligation,
	recordCoverageObligation,
} from "../coverage-obligation-ledger.js";
import type { CoverageLanguage } from "../coverage-runner.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

/**
 * Build an ALLOW decision that carries a single agent-visible coverage warning,
 * and ALSO mirror that exact line to the daemon's stderr (belt and suspenders:
 * the daemon log keeps a record even where the runner doesn't surface allow-time
 * warnings). The `[interlinked:coverage]` prefix is what the agent sees — the
 * Claude Code adapter routes an allow-decision's `warnings` into
 * `hookSpecificOutput.additionalContext` at PreToolUse, so this text reaches the
 * model on the same turn. Fail-open: the decision is `allow`, never a block.
 */
export function allowWithCoverageWarning(warning: string): HarnessDecision {
	process.stderr.write(`${warning}\n`);
	return { decision: "allow", warnings: [warning] };
}

/**
 * Loud-degrade: ALLOW (fail-open) but emit an AGENT-VISIBLE warning so a write
 * that wasn't coverage-checked never passes silently. Returns an allow-decision
 * carrying the `[interlinked:coverage]` warning (not bare null), which the
 * pipeline propagates to the agent. The daemon-stderr line is kept too.
 */
export function loudDegrade(relPath: string, why: string): HarnessDecision {
	return allowWithCoverageWarning(
		`[interlinked:coverage] WARNING: per-edit coverage gate degraded for ${relPath} ` +
			`(${why}) — allowing the edit (fail-open). This edit was NOT coverage-checked.`,
	);
}

/**
 * The fail-LOUD path for "the gate is ON for this language but the runner could
 * not establish a result" — no runner, an `ok:false` run, or a `testsPassed`/report
 * the runner could not produce. The single most common real cause is a MISSING
 * COVERAGE PROVIDER (`@vitest/coverage-v8` / `pytest-cov`), so we name it. Allows
 * the edit (fail-open — "can't measure" is not "deny") but NEVER silently: it
 * returns an allow-decision carrying an AGENT-VISIBLE warning (not bare null) so
 * the operator is told to install the provider; the daemon-stderr line is kept too.
 */
export function loudRunnerUnavailable(
	relPath: string,
	language: CoverageLanguage,
	why: string,
): HarnessDecision {
	const provider = language === "python" ? "pytest-cov" : "@vitest/coverage-v8";
	return allowWithCoverageWarning(
		`[interlinked:coverage] WARNING: coverage/red-green/CRAP gate is ON for ${language} ` +
			`but could not run for ${relPath} (${why}) — install the coverage provider ` +
			`(${provider} for js/ts, pytest-cov for python) to enforce; this edit was NOT ` +
			"coverage-checked.",
	);
}

/** Record a deferred coverage obligation and allow (budget exceeded). */
export function deferForBudget(
	projectRoot: string,
	relPath: string,
	event: HarnessEvent,
	estimateMs: number,
	budgetMs: number,
): null {
	const obligation: CoverageObligation = {
		kind: "coverage",
		file: relPath,
		reason: "budget_exceeded",
		estimated_suite_ms: estimateMs,
		budget_ms: budgetMs,
		session_id: event.session_id,
		timestamp: new Date(Date.now()).toISOString(),
	};
	recordCoverageObligation(projectRoot, obligation);
	return null;
}
