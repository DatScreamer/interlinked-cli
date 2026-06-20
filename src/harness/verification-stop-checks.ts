// ===========================================
// Verification-Before-Stop — Stop-time reflection nudges
// ===========================================
//
// Companion to commit-cadence.ts. Three reflection nudges that fire at
// Stop / SessionEnd when the agent claims done without having verified
// the work it did. All deterministic; all warnings (stderr), never blocks
// — same "lever held in reserve" stance as the commit-cadence nudge.
//
//   1. Unverified code:    code files edited, no tsc/test/lint/build
//   2. UI not interacted:  UI files edited, no dev-server / browser MCP
//   3. Stubs introduced:   TODO/FIXME/throw-not-implemented/.skip pushed
//                          into Write/Edit content during the session
//
// Signal capture happens at event time (session-state.ts records
// verification_observed; evaluator/post-tool.ts records stubs_introduced
// from tool_input). This file is mostly the formatters + the
// classification predicates the recorders need. The one exception is the
// deferred-coverage reader (`readDeferredCoverageObligations`), a small
// total/never-throws JSONL read of the coverage-obligation ledger — the
// same detector-plus-formatter split fixture-leak.ts uses (a detector that
// touches the filesystem next to a pure formatter), kept here so the Stop
// branch's gating in lifecycle-stop-warnings.ts can mock one module.

import { basename } from "node:path";
import { nonNull } from "../lib/non-null.js";
import {
	type CoverageObligation,
	readOpenCoverageObligations,
} from "./coverage-obligation-ledger.js";
// Predicates, stub scan, and the file-count + doc-fact helpers live in the
// sibling so this file stays under the per-file line cap. Re-exported here so
// the module's public surface (and its tests) is unchanged.
import type { VerificationSignal } from "./verification-stop-checks-predicates.js";
export {
	classifyBrowserToolName,
	classifyVerificationCommand,
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	formatDocMarkerDriftWarning,
	isCodeFile,
	isDocFactSourceFile,
	isUiFile,
	scanForStubs,
	STUB_INTRODUCED_CAP,
} from "./verification-stop-checks-predicates.js";
export type {
	FormatDocMarkerDriftOpts,
	StubKind,
	StubMatch,
	VerificationSignal,
} from "./verification-stop-checks-predicates.js";

// ---------------------------------------------------------------------------
// Stop-event formatter functions
// ---------------------------------------------------------------------------

export interface FormatUnverifiedCodeOpts {
	/** Distinct code files written this session. */
	codeFilesEdited: number;
	/** Verification signals observed this session. */
	verificationObserved: ReadonlySet<string>;
}

/** The verify-suite signal — extracted as a named constant so the
 *  filter expression below reads as intent rather than a literal lookup. */
const VERIFY_SUITE_SIGNAL: VerificationSignal = "verify-suite";

/** Individual-tool correctness signals — the per-tool axes that
 *  collectively form the suite. Used as the "did the agent run anything
 *  at all" predicate for the partial-verification nudge below. */
const INDIVIDUAL_CORRECTNESS_SIGNALS: readonly VerificationSignal[] = [
	"typecheck",
	"test",
	"lint",
	"build",
];

/** Correctness-grade signals — any one satisfies the unverified-code check.
 *  `verify-suite` is the strongest signal (covers tsc + biome + lint +
 *  secrets + SAST + docs:check at once), but a standalone tsc/test/lint/
 *  build still satisfies the check on its own — the nudge fires only
 *  when none of these were observed. */
const CORRECTNESS_SIGNALS: readonly string[] = [
	...INDIVIDUAL_CORRECTNESS_SIGNALS,
	VERIFY_SUITE_SIGNAL,
];

/**
 * Public — Stop-time nudge when the session has code-file edits but
 * the agent never ran a typechecker / tests / linter / build. Returns
 * null when satisfied (no warning needed).
 *
 * Wording is deliberately reflective ("before stopping, run …") rather
 * than imperative — this is a stderr nudge, not a force-retry deny.
 */
export function formatUnverifiedCodeWarning(opts: FormatUnverifiedCodeOpts): string | null {
	if (opts.codeFilesEdited === 0) return null;
	if (CORRECTNESS_SIGNALS.some((k) => opts.verificationObserved.has(k))) return null;
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.codeFilesEdited} code file edit(s) ` +
		"and no verification this session — no tsc / test / lint / build invocation observed. " +
		"Before stopping, run the project's typecheck or tests " +
		"(e.g., `npx tsc --noEmit`, `bun run test`, or the project's verify command) " +
		"to confirm the edits actually compile and pass. Don't claim done on unverified work."
	);
}

export interface FormatVerifyNotRunOpts {
	/** Distinct code files written this session. */
	codeFilesEdited: number;
	/** Verification signals observed this session. */
	verificationObserved: ReadonlySet<string>;
}

/**
 * Public — Stop-time nudge when code files were edited and the agent
 * ran *some* verification (tsc, tests, lint, build) but never
 * `interlinked verify` specifically. The verify suite is broader than
 * any individual tool — it also runs docs:check, dep-audit, semgrep,
 * and the gen-marker validators that bit us in commit 5452fac. A
 * passing tsc + npm test does not prove the verify suite is green.
 *
 * Returns null when:
 *   - No code files were edited (nothing to verify), OR
 *   - `verify-suite` is already in `verificationObserved` (satisfied), OR
 *   - No correctness signals at all were observed (the broader
 *     `warn_unverified_code` nudge handles that case; this one would
 *     just add noise on top).
 */
export function formatVerifyNotRunWarning(opts: FormatVerifyNotRunOpts): string | null {
	if (opts.codeFilesEdited === 0) return null;
	if (opts.verificationObserved.has(VERIFY_SUITE_SIGNAL)) return null;
	// Don't double-nudge: if nothing was verified, let
	// formatUnverifiedCodeWarning carry the message. This nudge fires
	// only on the partial-verification case (some individual tool ran
	// but not the suite).
	if (!INDIVIDUAL_CORRECTNESS_SIGNALS.some((s) => opts.verificationObserved.has(s))) {
		return null;
	}
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.codeFilesEdited} code file edit(s) ` +
		"and partial verification — individual checks ran but `interlinked verify` did not. " +
		"The verify suite is the canonical local mirror of CI (tsc + biome + lint + secrets + " +
		"SAST + docs:check + dep-audit aggregated). Run `interlinked verify` before stopping to " +
		"confirm the full pipeline is clean — a green tsc doesn't catch docs drift, secrets, or " +
		"the lint/SAST findings verify aggregates."
	);
}

export interface FormatUiNotInteractedOpts {
	/** Distinct UI files written this session. */
	uiFilesEdited: number;
	/** Verification signals observed this session. */
	verificationObserved: ReadonlySet<string>;
}

/**
 * Public — Stop-time nudge when UI files were edited but no
 * dev-server / browser-MCP interaction was observed this session.
 *
 * Per `feedback_landing_test_before_push.md`: type-checking is not
 * feature-checking. UI work needs a browser load to verify behavior.
 */
export function formatUiNotInteractedWarning(opts: FormatUiNotInteractedOpts): string | null {
	if (opts.uiFilesEdited === 0) return null;
	if (
		opts.verificationObserved.has("browser") ||
		opts.verificationObserved.has("dev-server")
	) {
		return null;
	}
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.uiFilesEdited} UI file edit(s) ` +
		"(.tsx / .jsx / .html / .css / .vue / .svelte / .astro) and no browser interaction this session " +
		"— neither a dev server (wrangler dev / vite / npm run dev) nor a chrome-devtools / playwright MCP " +
		"call was observed. Type-checking is not feature-checking: load the page and verify what you built " +
		"before claiming done."
	);
}

export interface FormatStubsIntroducedOpts {
	stubs: ReadonlyArray<{ file: string; kind: string; snippet: string }>;
	maxShown?: number;
}

/**
 * Public — Stop-time nudge summarizing stubs / TODOs / disabled-tests /
 * not-implemented throws the agent introduced via Write/Edit content
 * during the session. Returns null when nothing was tracked.
 *
 * Shows the first `maxShown` (default 5) by file basename + kind +
 * line snippet, followed by an "...and N more" suffix when applicable.
 */
export function formatStubsIntroducedWarning(opts: FormatStubsIntroducedOpts): string | null {
	if (opts.stubs.length === 0) return null;
	const max = opts.maxShown ?? 5;
	const shown = opts.stubs.slice(0, max);
	const lines = shown.map((s) => `  - ${basename(s.file)} [${s.kind}]: ${s.snippet}`);
	const more = opts.stubs.length > max ? `\n  ...and ${opts.stubs.length - max} more` : "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.stubs.length} stub / TODO / disabled-test ` +
		`addition(s) introduced this session:\n${lines.join("\n")}${more}\n` +
		"If these are deliberate scaffolding, document the follow-up in a TODO list or issue. " +
		"If they're forgotten work, finish them before stopping."
	);
}

// ---------------------------------------------------------------------------
// TDD regression + git-bisect Stop nudges
// ---------------------------------------------------------------------------

/**
 * Public — Stop-time nudge when one or more tracked TDD cycles ended the
 * session in the `regression` state: a test that passed earlier this
 * session is now failing. A green→red transition is strong evidence the
 * session's edits broke previously-working behavior. Returns null when
 * there are no regressions.
 */
export function formatTddRegressionWarning(opts: {
	regressions: ReadonlyArray<{ sourceFile: string }>;
	maxShown?: number;
}): string | null {
	if (opts.regressions.length === 0) return null;
	const max = opts.maxShown ?? 5;
	const shown = opts.regressions.slice(0, max);
	const lines = shown.map((r) => `  - ${basename(r.sourceFile)}`);
	const more =
		opts.regressions.length > max
			? `\n  ...and ${opts.regressions.length - max} more`
			: "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.regressions.length} test ` +
		"regression(s) — a test that was passing earlier this session is now failing:\n" +
		`${lines.join("\n")}${more}\n` +
		"A green→red transition means this session's edits broke previously-working " +
		"behavior. Re-run the test(s) and fix the regression before stopping."
	);
}

export interface FormatUnresolvedRedOpts {
	/** Non-test checks (typecheck/build/lint) observed red and never cleared
	 *  to green this session. `detail` is an optional command snippet. */
	redChecks: ReadonlyArray<{ kind: string; detail?: string | undefined }>;
	/** Source files whose tests went red this session and stayed red (the
	 *  stayed-red case — the green→red `regression` case is handled
	 *  separately by `formatTddRegressionWarning`). */
	redTests: ReadonlyArray<{ sourceFile: string }>;
	maxShown?: number;
}

/**
 * Public — Stop-time reflection nudge when the session OBSERVED a check or
 * test go red and ended without it going green again. Two inputs:
 *   - `redChecks`: non-test verification (tsc / build / lint) that failed
 *     and was never seen passing afterward (from `observed_checks`).
 *   - `redTests`: TDD cycles still in the `red` state at Stop — a test that
 *     failed and never went green (NOT the green→red regression, which the
 *     companion `formatTddRegressionWarning` already covers).
 *
 * Returns null when BOTH lists are empty. Lists up to `maxShown` (default 5)
 * entries combined, with an "...and N more" suffix.
 *
 * Deliberately reflective, never a block: the wording explicitly grants the
 * legitimate "you may have meant to leave it red" case (a known-failing test
 * left red on purpose, an in-progress refactor). It is a stderr nudge — a
 * reminder to confirm the red was intentional, not a demand to fix it.
 */
export function formatUnresolvedRedWarning(opts: FormatUnresolvedRedOpts): string | null {
	const total = opts.redChecks.length + opts.redTests.length;
	if (total === 0) return null;
	const max = opts.maxShown ?? 5;
	const items: string[] = [];
	for (const c of opts.redChecks) {
		items.push(c.detail ? `${c.kind} (${c.detail})` : c.kind);
	}
	for (const t of opts.redTests) {
		items.push(`test: ${basename(t.sourceFile)}`);
	}
	const shown = items.slice(0, max);
	const lines = shown.map((s) => `  - ${s}`);
	const more = items.length > max ? `\n  ...and ${items.length - max} more` : "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${total} check/test that went red ` +
		"this session and never went green again:\n" +
		`${lines.join("\n")}${more}\n` +
		"If you meant to leave it red — a known-failing test, an in-progress refactor, a " +
		"deliberately-pending check — that's fine; this is just a reminder to confirm the red " +
		"was intentional. Otherwise, re-run it and get it green before stopping."
	);
}

// ---------------------------------------------------------------------------
// Deferred-coverage obligations — Stop nudge
// ---------------------------------------------------------------------------
// The per-edit coverage gate (evaluator/coverage-write-guard.ts) defers instead
// of running the suite when the rolling runtime estimate exceeds the budget; it
// appends one obligation row per deferred edit to
// `.interlinked/coverage-obligations.jsonl` (coverage-obligation-ledger.ts) and
// allows. Those obligations are NEVER enforced per-edit — only the commit gate
// enforces them. A session that ends with deferred obligations and no commit has
// claimed-done coverage that nothing ever checked. This reader + formatter surface
// that at Stop, as a reflection nudge (never a block), the sibling of the
// observed-RED nudge (formatUnresolvedRedWarning): RED is "you saw it fail",
// deferred-coverage is "you never even ran it".

/**
 * Public — the OPEN deferred coverage obligations for `sessionId`: the
 * chronological net of obligations against discharges over the append-only
 * ledger, deduped by file (an edit deferred three times records three rows but
 * is one file with unmet coverage). Thin delegation to the ledger's
 * `readOpenCoverageObligations` — the netting moved there when the discharge
 * loop closed (finding 2026-06), so the Stop nudge and the PostToolUse
 * discharge pass read the SAME definition of "still open".
 *
 * Both promised relief paths now actually record discharges: the commit gate
 * on a clean pass, and an observed GREEN coverage-suite run for the files the
 * fresh report measured (`coverage-discharge.ts`). Discharges count from ANY
 * session — a measurement is a fact about the file, not the session.
 */
export function readDeferredCoverageObligations(
	projectRoot: string,
	sessionId: string,
): CoverageObligation[] {
	return readOpenCoverageObligations(projectRoot, sessionId);
}

export interface FormatDeferredCoverageOpts {
	/** The session's unmet deferred coverage obligations (already deduped by
	 *  file by {@link readDeferredCoverageObligations}). */
	obligations: ReadonlyArray<CoverageObligation>;
	maxShown?: number;
}

/**
 * Public — Stop-time reflection nudge when the session deferred one or more
 * per-edit coverage checks (the budget-gate path) that were never enforced.
 * Lists up to `maxShown` (default 5) files by basename, with an "...and N more"
 * suffix. Returns null when there are no obligations.
 *
 * Sibling of {@link formatUnresolvedRedWarning}: that one fires on a check the
 * agent OBSERVED go red; this one fires on a coverage check the agent never ran
 * at all (deferred to the commit gate). Deliberately reflective, NEVER a block —
 * the relief valve is real: running the suite + coverage, or committing (the
 * commit gate enforces the obligations), both discharge it.
 */
export function formatDeferredCoverageWarning(opts: FormatDeferredCoverageOpts): string | null {
	if (opts.obligations.length === 0) return null;
	const max = opts.maxShown ?? 5;
	const shown = opts.obligations.slice(0, max);
	const lines = shown.map((o) => `  - ${basename(o.file)}`);
	const more =
		opts.obligations.length > max
			? `\n  ...and ${opts.obligations.length - max} more`
			: "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.obligations.length} deferred ` +
		"coverage check(s) this session that were never enforced — the per-edit coverage gate " +
		"deferred them (suite runtime over budget) and only the commit gate enforces them:\n" +
		`${lines.join("\n")}${more}\n` +
		"Run the full suite with coverage (a green run discharges the obligations its report " +
		"measures), or commit (the commit gate enforces the deferred obligations), before " +
		"claiming done. This is a reminder, not a block — a deferred check is unverified " +
		"coverage, not a known failure."
	);
}

/** A `git bisect` sub-command that puts the repo INTO bisect state (or keeps
 *  it there). `reset` is deliberately excluded — it is the exit. */
const BISECT_OP_RE = /\bgit\s+bisect\s+(?:start|good|bad|new|old|skip|run)\b/;
/** `git bisect reset` — the command that restores HEAD and ends a bisect. */
const BISECT_RESET_RE = /\bgit\s+bisect\s+reset\b/;

/**
 * Public — Stop-time nudge when the session ran `git bisect start` (or any
 * bisect step) without a later `git bisect reset`. An unfinished bisect
 * leaves the working tree on an old commit in detached-HEAD state, which is
 * a confusing place to stop. Returns null when there is no bisect activity,
 * or a reset followed the last bisect step.
 */
export function formatBisectNotResetWarning(opts: {
	commandsRun: ReadonlyArray<string>;
}): string | null {
	let lastOp = -1;
	let lastReset = -1;
	for (let i = 0; i < opts.commandsRun.length; i++) {
		const c = nonNull(opts.commandsRun[i]);
		if (BISECT_OP_RE.test(c)) lastOp = i;
		if (BISECT_RESET_RE.test(c)) lastReset = i;
	}
	if (lastOp === -1 || lastReset > lastOp) return null;
	return (
		"[interlinked:verify-before-stop] Stopping with an unfinished git bisect — a " +
		"`git bisect start/good/bad/run` ran this session with no `git bisect reset` " +
		"after it. The working tree is likely still on an old commit in detached-HEAD " +
		"bisect state. Run `git bisect reset` to restore HEAD before stopping."
	);
}
