// ===========================================
// Stop-event verification warning helpers
// ===========================================
// Extracted from lifecycle-events.ts (2026-06 refactor).
// Contains buildCommitCadenceNudge, buildVerificationStopWarnings,
// pushIfNotNull, and all check* helper functions.
// The main lifecycle-events.ts owns buildStopWarnings (which wires
// buildPatternRescanWarnings, the sequence detectors, and calls into
// this module) — keeping test source-text assertions intact.

import { formatStopNudge, readSessionTokens } from "../commit-cadence.js";
import {
	detectDeadOnArrival,
	formatDeadOnArrivalWarning,
} from "../dead-on-arrival.js";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "../fixture-leak.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	countVerifyCommands,
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatDocMarkerDriftWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
	readDeferredCoverageObligations,
} from "../verification-stop-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

/** TDD-cycle state value that signals "test went green earlier this session
 *  and is now red again." Extracted constant so the conditional reads as
 *  intent, not a magic string. */
const TDD_CYCLE_REGRESSION = "regression";

/** TDD-cycle state value for a test that failed and has not (yet) gone
 *  green — the "stayed red" case the unresolved-red nudge surfaces.
 *  Distinct from `regression` (green→red), which `checkTddRegression`
 *  owns, so the two nudges never double-fire on the same cycle. */
const TDD_CYCLE_RED = "red";

/** Observed-check status value for a non-test check (tsc/build/lint) that
 *  ended the session red. */
const OBSERVED_CHECK_RED = "red";

/** Commit-cadence Stop nudge — encourage bundling uncommitted code-file
 *  edits into commits before ending. Doc/plan files are excluded.
 *  Wording escalates by cumulative session token count, read once from
 *  the transcript path the hook script forwarded. Returns null when the
 *  nudge is disabled, already-emitted, or below threshold; otherwise
 *  marks `stop_nudge_emitted` and returns the formatted warning. */
export function buildCommitCadenceNudge(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const cadenceCfg = ctx.rules.commit_cadence;
	if (!cadenceCfg?.enabled || !session || session.stop_nudge_emitted) return null;
	const nonDocCount = session.non_doc_files_edited_since_commit?.size ?? 0;
	const docCount = session.doc_files_edited_since_commit ?? 0;
	const tokens = readSessionTokens(event.transcript_path);
	const cumulativeTokens = tokens?.total;
	const nudge = formatStopNudge({
		uncommittedNonDocCount: nonDocCount,
		docFilesExcluded: docCount,
		threshold: cadenceCfg.stop_threshold,
		...(cumulativeTokens !== undefined ? { cumulativeTokens } : {}),
		tokenBandLow: cadenceCfg.token_band_low,
		tokenBandHigh: cadenceCfg.token_band_high,
	});
	if (nudge === null) return null;
	session.stop_nudge_emitted = true;
	ctx.log(
		`Commit-cadence Stop nudge: ${nonDocCount} uncommitted code files, ${docCount} doc files excluded, tokens=${tokens?.total ?? "n/a"}`,
	);
	return nudge;
}

/** Verification-before-stop nudges — eleven independent reflection
 *  warnings keyed off `verification_observed`, `observed_checks`,
 *  `stubs_introduced`, `tdd_cycles`, `commands_run`, and `files_written`
 *  session fields, plus the deferred coverage-obligation ledger read by
 *  `session_id`. All stderr-only; none block. See
 *  docs/external-pulse/failproofai.md §"smarter Stop hooks" for the design
 *  rationale and docs/design/stop-event-checks.md for the tier-2/3 backlog. */
export function buildVerificationStopWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string[] {
	const vsc = ctx.rules.verification_stop_checks;
	if (!vsc?.enabled || !session) return [];
	const verificationObserved = session.verification_observed ?? new Set<string>();
	const warnings: string[] = [];
	const unverifiedCode = vsc.warn_unverified_code
		? checkUnverifiedCode(ctx, session, verificationObserved)
		: null;
	pushIfNotNull(warnings, unverifiedCode);
	// Single-nudge invariant: verify-not-run ("ran individual tools but not the
	// full suite") and unverified-code ("cadence far below floor") are both
	// [interlinked:verify-before-stop] lines; when the stronger unverified-code
	// nudge already fired, emitting both double-nudges the same concern. Defer.
	pushIfNotNull(
		warnings,
		vsc.warn_verify_not_run && unverifiedCode === null
			? checkVerifyNotRun(ctx, session, verificationObserved)
			: null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_ui_not_interacted
			? checkUiNotInteracted(ctx, session, verificationObserved)
			: null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_stubs_introduced ? checkStubsIntroduced(ctx, session) : null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_fixture_leaks ? checkFixtureLeaks(ctx, event) : null,
	);
	pushIfNotNull(warnings, checkTddRegression(ctx, session));
	pushIfNotNull(
		warnings,
		vsc.warn_unresolved_red ? checkUnresolvedRed(ctx, session) : null,
	);
	pushIfNotNull(
		warnings,
		ctx.rules.per_edit_coverage?.enabled ? checkDeferredCoverage(ctx, session) : null,
	);
	pushIfNotNull(warnings, checkBisectNotReset(ctx, session));
	pushIfNotNull(warnings, checkDeadOnArrival(ctx, event, session));
	pushIfNotNull(warnings, checkDocMarkerDrift(ctx, session));
	return warnings;
}

export function pushIfNotNull(warnings: string[], value: string | null): void {
	if (value !== null) warnings.push(value);
}

/** Shared shape for the two code-file-verification warnings: count
 *  changed code files, ask the supplied formatter whether that warrants
 *  a warning, log under the given tag. Two callers differ only in their
 *  formatter and log-tag — extracted so a bug fixed in one doesn't
 *  silently survive in the other. */
function checkCodeFileVerification(opts: {
	ctx: ServerRuntime;
	session: SessionTrajectory;
	verificationObserved: Set<string>;
	formatter: (input: {
		codeFilesEdited: number;
		verifyCommandCount: number;
		verificationObserved: Set<string>;
	}) => string | null;
	logTag: string;
}): string | null {
	const { ctx, session, verificationObserved, formatter, logTag } = opts;
	const codeFilesEdited = countCodeFilesEdited(session.files_written);
	// Raw count of correctness-grade verify commands (tsc/test/lint/build/suite)
	// — the numerator of the cadence ratio the unverified-code nudge gates on.
	// `formatVerifyNotRunWarning` ignores it; only the ratio nudge reads it.
	const verifyCommandCount = countVerifyCommands(session.commands_run);
	const warning = formatter({ codeFilesEdited, verifyCommandCount, verificationObserved });
	if (warning === null) return null;
	ctx.log(
		`Verify-before-stop: ${logTag} (${codeFilesEdited} files, signals=${[...verificationObserved].join(",") || "none"})`,
	);
	return warning;
}

/** "Agent edited code without running tsc / lint / tests in this session." */
function checkUnverifiedCode(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	verificationObserved: Set<string>,
): string | null {
	return checkCodeFileVerification({
		ctx,
		session,
		verificationObserved,
		formatter: formatUnverifiedCodeWarning,
		logTag: "unverified-code",
	});
}

/** "Agent edited code without running `interlinked verify`." */
function checkVerifyNotRun(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	verificationObserved: Set<string>,
): string | null {
	return checkCodeFileVerification({
		ctx,
		session,
		verificationObserved,
		formatter: formatVerifyNotRunWarning,
		logTag: "verify-suite-not-run",
	});
}

/** "Agent edited UI files without browser-MCP / dev-server interaction." */
function checkUiNotInteracted(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	verificationObserved: Set<string>,
): string | null {
	const uiFilesEdited = countUiFilesEdited(session.files_written);
	const warning = formatUiNotInteractedWarning({ uiFilesEdited, verificationObserved });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: ui-not-interacted (${uiFilesEdited} files)`);
	return warning;
}

/** Agent left incomplete-work markers in source — unresolved task tokens,
 *  disabled tests, or throw-not-implemented stubs. */
function checkStubsIntroduced(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const stubs = session.stubs_introduced ?? [];
	const warning = formatStubsIntroducedWarning({ stubs });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: stubs-introduced (${stubs.length})`);
	return warning;
}

/** Fixture leaks — untracked src/**\/_*.ts whose basename appears in a
 *  writeFixture()-shaped call in a tracked test file. The test's afterAll
 *  cleanup didn't run (killed mid-test, helper threw, runner panicked).
 *  Deterministic; no session state. */
function checkFixtureLeaks(ctx: ServerRuntime, event: HarnessEvent): string | null {
	const leaks = detectFixtureLeaks(event.cwd || ctx.cwd);
	const warning = formatFixtureLeakWarning({ leaks });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: fixture-leaks (${leaks.length})`);
	return warning;
}

/** TDD regression — a test that was green earlier this session is now red,
 *  so this session's edits broke working behavior. */
function checkTddRegression(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const tddRegressions: Array<{ sourceFile: string }> = [];
	for (const cycle of session.tdd_cycles.values()) {
		if (cycle.state === TDD_CYCLE_REGRESSION) {
			tddRegressions.push({ sourceFile: cycle.source_file });
		}
	}
	const warning = formatTddRegressionWarning({ regressions: tddRegressions });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: tdd-regression (${tddRegressions.length})`);
	return warning;
}

/** A TDD cycle that ended the session in the stayed-red case: state `red`
 *  (NOT `regression` — that's `checkTddRegression`'s) and the red has not
 *  been cleared by a later green (`green_at` absent, or it predates the
 *  current `red_at`). */
function isStayedRedCycle(cycle: {
	state: string;
	red_at?: number | undefined;
	green_at?: number | undefined;
}): boolean {
	if (cycle.state !== TDD_CYCLE_RED) return false;
	return cycle.green_at === undefined || cycle.green_at < (cycle.red_at ?? 0);
}

/** Unresolved-red reflection nudge — a check or test went red this session
 *  and the session ended without it going green again. redChecks come from
 *  `observed_checks` (non-test tsc/build/lint); redTests are stayed-red TDD
 *  cycles (the green→red regression case is excluded — `checkTddRegression`
 *  covers it). Reflection only; never blocks. */
function checkUnresolvedRed(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const redChecks: Array<{ kind: string; detail?: string | undefined }> = [];
	for (const observed of (session.observed_checks ?? new Map()).values()) {
		if (observed.status === OBSERVED_CHECK_RED) {
			redChecks.push({ kind: observed.kind, detail: observed.detail });
		}
	}
	const redTests: Array<{ sourceFile: string }> = [];
	for (const cycle of session.tdd_cycles.values()) {
		if (isStayedRedCycle(cycle)) redTests.push({ sourceFile: cycle.source_file });
	}
	const warning = formatUnresolvedRedWarning({ redChecks, redTests });
	if (warning === null) return null;
	ctx.log(
		`Verify-before-stop: unresolved-red (${redChecks.length} checks, ${redTests.length} tests)`,
	);
	return warning;
}

/** Deferred-coverage reflection nudge — the session deferred one or more
 *  per-edit coverage checks (the budget-gate path in coverage-write-guard.ts)
 *  that were NEVER enforced; only the commit gate enforces them. Sibling of
 *  `checkUnresolvedRed`: RED is "you saw it fail", deferred is "you never ran
 *  it". The ledger is append-only with no resolution marker, so every row
 *  recorded for THIS session counts as unmet (the formatter says so). Reads the
 *  ledger by `session_id` so another session's obligations never leak in.
 *  Gated by the caller on `per_edit_coverage.enabled` (the producer flag — no
 *  obligations exist unless per-edit coverage is on). Reflection only; never
 *  blocks. */
function checkDeferredCoverage(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const obligations = readDeferredCoverageObligations(ctx.cwd, session.session_id);
	const warning = formatDeferredCoverageWarning({ obligations });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: deferred-coverage (${obligations.length} unmet)`);
	return warning;
}

/** Unfinished git bisect — a bisect start/op with no reset after it leaves
 *  the repo in detached-HEAD bisect state. */
function checkBisectNotReset(
	ctx: ServerRuntime,
	session: SessionTrajectory,
): string | null {
	const warning = formatBisectNotResetWarning({ commandsRun: session.commands_run });
	if (warning === null) return null;
	ctx.log("Verify-before-stop: bisect-not-reset");
	return warning;
}

/** Dead-on-arrival — a file edited this session whose fresh Supermodel
 *  `.graph` shard reports zero dependent files and no callers. Plan 08
 *  §3c. Freshness-gated (only E-fresh shards), so a stale or missing
 *  shard yields no finding — zero false positives. */
function checkDeadOnArrival(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const cwd = event.cwd || ctx.cwd;
	const doaHits = detectDeadOnArrival(session.files_written, cwd);
	const warning = formatDeadOnArrivalWarning(doaHits, cwd);
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: dead-on-arrival (${doaHits.length})`);
	return warning;
}

/** Doc-fact drift — a gen-marker source (a built-in rule family, the runner
 *  registry, or the modes type) was edited this session but docs:build /
 *  docs:check / `interlinked verify` wasn't run, so the landing/README
 *  `<!-- gen:* -->` counters may have drifted. CI's docs:check and the
 *  pre-push gate block on this; surface it at Stop instead of at push. */
function checkDocMarkerDrift(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const docSourcesEdited = countDocFactSourcesEdited(session.files_written);
	const warning = formatDocMarkerDriftWarning({
		docSourcesEdited,
		commandsRun: session.commands_run,
	});
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: doc-marker-drift (${docSourcesEdited} source files)`);
	return warning;
}
