// ===========================================
// Lifecycle event handling
// ===========================================
// The `switch (event.hook_event)` dispatcher extracted from `processEvent`
// in server.ts. Handles every non-tool hook event — SessionStart,
// SessionEnd, Stop, UserPromptSubmit, Subagent*, Skill*.
//
// 2026-05 refactor: the original ~400-line switch body was extracted into
// per-event handlers + helpers inside `handleStop` (`buildStopWarnings`,
// `buildVerificationStopWarnings` with 8 sub-checks, `persistSessionTrajectory`,
// `cleanupSessionState`). The dispatcher is now a short switch; each handler
// is independently testable.
//
// `handleLifecycleEvent` returns:
//   - a `HarnessDecision` when the lifecycle branch produced an early
//     return (the original `switch` had `return { … }` arms);
//   - `null` when the original `switch` arm fell through with `break`,
//     i.e. the caller should continue into the Pre/Post evaluation path.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
	autoStripAllScopes,
	defaultStripAuditLogPath,
	describeReason as describeMalformedReason,
} from "../../lib/settings-validator.js";
import type { CohortManager } from "../cohort.js";
import { formatStopNudge, readSessionTokens } from "../commit-cadence.js";
import { scanUserPrompt } from "../content-scanner/prompt-scan.js";
import {
	detectDeadOnArrival,
	formatDeadOnArrivalWarning,
} from "../dead-on-arrival.js";
import { resetProjectSetupWarningsCache } from "../evaluator/pre-tool.js";
import { computeEffectivenessSummary } from "../feedback-effectiveness.js";
import { refreshPriorityIfStale as refreshFilePriorityIfStale } from "../file-priority.js";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "../fixture-leak.js";
import { findRipgrep } from "../grep-accelerator.js";
import { deleteLiveSnapshot } from "../live-snapshot.js";
import { sanitizeSessionId } from "../session-paths.js";
import {
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
	type SessionTracker,
} from "../session-state.js";
import { buildPatternRescanWarnings } from "../stop-rescan.js";
import { buildTurnEndSummary, formatTurnEndWarnings } from "../turn-end.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	countCodeFilesEdited,
	countUiFilesEdited,
	formatBisectNotResetWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
} from "../verification-stop-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Deadline (in ms) to drain pending async analysis work before the Stop
 *  arm completes. Mirrors server.ts's constant. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

/** TDD-cycle state value that signals "test went green earlier this session
 *  and is now red again." Extracted constant so the conditional reads as
 *  intent, not a magic string. */
const TDD_CYCLE_REGRESSION = "regression";

/** Allowed `SkillEnter.source` values forwarded by the CLI / hook. Anything
 *  else degrades to "cli" (the default origin). */
const SKILL_SOURCE_HOOK = "hook";
const SKILL_SOURCE_MANUAL = "manual";

/**
 * Resolve the parent session_id for a SubagentStop event so the subagent's
 * verification signals can be rolled up into the parent's trajectory.
 * Subagent tool calls arrive under the subagent's own session_id, so the
 * parent linkage has to be reconstructed: the cohort records each
 * subagent's `parent_agent` (a name); resolve that name back to a session.
 * Falls through several shapes because runners populate the linkage
 * inconsistently. Returns undefined when no parent session can be found —
 * the caller then simply skips the roll-up (no worse than before).
 */
export function resolveParentSessionId(
	event: HarnessEvent,
	cohort: CohortManager,
	sessions: SessionTracker,
): string | undefined {
	const ti = event.tool_input;
	const subName =
		event.agent_name ||
		(typeof ti?.subagent_id === "string" ? ti.subagent_id : undefined) ||
		(typeof ti?.agent_id === "string" ? ti.agent_id : undefined);
	const parentName =
		(subName ? cohort.getAgent(subName)?.parent_agent : undefined) ??
		event.parent_agent ??
		(typeof ti?.parent_agent_name === "string" ? ti.parent_agent_name : undefined) ??
		(typeof ti?.parent_agent === "string" ? ti.parent_agent : undefined);
	if (!parentName) return undefined;
	// parentName is normally an agent name — map it back to a session_id.
	const byAgent = cohort.getAgent(parentName)?.session_id;
	if (byAgent && sessions.get(byAgent)) return byAgent;
	// Some runners pass the parent session_id directly as the linkage value.
	if (sessions.get(parentName)) return parentName;
	return undefined;
}

/**
 * Run the lifecycle-event `switch`. Returns a `HarnessDecision` for the arms
 * that produced an early return in the original `processEvent`, or `null`
 * when the arm fell through (`break`) and the caller should keep evaluating.
 */
export async function handleLifecycleEvent(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision | null> {
	const { cohort, log } = ctx;
	switch (event.hook_event) {
		case "SessionStart":
			return handleSessionStart(ctx, event);
		case "SessionEnd":
			return handleSessionEnd(ctx, event);
		case "Stop":
			return handleStop(ctx, event, session);
		case "UserPromptSubmit":
			return handleUserPromptSubmit(ctx, event);
		case "SubagentStart":
			cohort.subagentJoined(event);
			log(`Subagent joined: ${event.agent_name || "unnamed"}`);
			return null;
		case "SubagentStop":
			handleSubagentStop(ctx, event);
			return null;
		case "SkillEnter":
			return handleSkillEnter(ctx, event, session);
		case "SkillLeave":
			return handleSkillLeave(ctx, event, session);
		case "SkillList":
			return handleSkillList(ctx, event, session);
		default:
			cohort.recordActivity(event);
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────
// Per-event handlers
// ─────────────────────────────────────────────────────────────────────

/** Cohort join + side-effects: file-priority refresh, trigram-index
 *  refresh, malformed-permission-rule auto-strip. Returns a decision
 *  only when the auto-strip surfaces a warning; otherwise falls through
 *  to `null` so the caller continues normal evaluation. */
async function handleSessionStart(
	ctx: ServerRuntime,
	event: HarnessEvent,
): Promise<HarnessDecision | null> {
	const { cohort, log } = ctx;
	cohort.agentJoined(event);
	log(`Agent joined: ${event.agent_name || event.session_id} (${event.agent_source})`);
	// Recency-weighted check depth (Mythos Phase 4): refresh the
	// per-file priority map from git log if the cache is stale.
	// Cold files (>180 days unchanged) skip advisory checks at
	// PostToolUse via `shouldRunAdvisoryChecks`.
	try {
		const refreshed = refreshFilePriorityIfStale(ctx.cwd);
		if (refreshed.size > 0) {
			ctx.filePriorityMap = refreshed;
			log(`File-priority map refreshed: ${refreshed.size} entries`);
		}
	} catch (err) {
		log(`File-priority refresh failed (non-fatal): ${err}`);
	}
	// Incremental index update on session start (catches git changes between sessions)
	if (ctx.trigramIndex) {
		try {
			const updated = ctx.trigramIndex.incrementalUpdate();
			if (updated > 0) {
				log(`Trigram index refreshed: ${updated} files updated`);
			}
		} catch (err) {
			log(`Trigram index refresh failed (non-fatal): ${err}`);
		}
		// One-time warning if index exists but ripgrep is missing
		if (!findRipgrep()) {
			ctx.logAlways(
				"[interlinked] Trigram index loaded but ripgrep (rg) not found — grep acceleration disabled. Install: brew install ripgrep (macOS), apt install ripgrep (Linux), or cargo install ripgrep",
			);
		}
	}
	// Auto-strip malformed permission rules from .claude/settings*.json
	// (project + user scope), with an audit log so every removed entry
	// is visible. The agent-write path is already blocked at PreToolUse
	// (write-content-guards.ts), but Claude Code's "Always allow" UI
	// writes settings.json internally without firing a tool hook — that
	// path is invisible to PreToolUse, so SessionStart is the only
	// surface where we can clean it. JSONL audit at
	// .interlinked/permission-rule-strips.jsonl.
	try {
		const auditPath = defaultStripAuditLogPath(ctx.cwd);
		const stripResult = autoStripAllScopes(ctx.cwd, auditPath);
		if (stripResult.totalStripped > 0) {
			// Invalidate the project-setup-warning cache so the next
			// PreToolUse re-reads settings.json and stops emitting
			// `[interlinked:setup]` for the entries just stripped.
			// Without this, the daemon serves stale warning text for
			// the rest of its process lifetime even though the file
			// is now clean.
			resetProjectSetupWarningsCache();
			const previews = stripResult.entries.slice(0, 5).map((e) => {
				const file = e.file.replace(/^.+?(\.claude\/.+)$/, "$1");
				return `  - ${file} permissions.${e.bucket}[${e.index}] = ${JSON.stringify(e.rule)} (${describeMalformedReason(e.reason)})`;
			});
			const more =
				stripResult.entries.length > previews.length
					? `\n  ...and ${stripResult.entries.length - previews.length} more`
					: "";
			const relAudit = auditPath.startsWith(`${ctx.cwd}/`)
				? auditPath.slice(ctx.cwd.length + 1)
				: auditPath;
			const warning =
				`[interlinked:permission-strip] Auto-stripped ${stripResult.totalStripped} malformed permission rule(s) from Claude Code settings file(s) (full audit at ${relAudit}):\n${previews.join("\n")}${more}\n` +
				"These rules came from Claude Code's permission UI; the upstream extractor occasionally emits bad parens / empty / missing-Tool() entries. The agent-write path is already blocked at PreToolUse — this strip handles the UI-write path that is invisible to hooks.";
			log(
				`Auto-stripped ${stripResult.totalStripped} malformed permission rule(s); audit at ${auditPath}`,
			);
			return { decision: "allow", warnings: [warning] };
		}
	} catch (err) {
		log(`Permission-rule auto-strip failed (non-fatal): ${err}`);
	}
	return null;
}

/** SessionEnd narrow body — defensive cleanup only.
 *
 * Per docs/design/test-quality-harness-local-first.md §1.1, SessionEnd is
 * wired narrowly and Claude-Code-only. The daemon's per-turn reflection
 * and cleanup already ran on the session's final Stop. The audit-chain
 * reason annotation is written from the hook template's `appendLocal`
 * (which applies chain fields when event_type === "session_end"); the
 * commit-attribution finalization (`reconcileCommits`) runs in the hook
 * template at hooks-template.ts:1023-1025.
 *
 * Edge cases like `/clear` during prompt-input can fire SessionEnd
 * without a final Stop for the in-flight session, so we drop in-memory
 * session state here to avoid leaks. Safe to re-run: each call site
 * below uses an underlying delete/remove primitive that is a no-op when
 * the key is absent (Map.delete and the SessionTracker/Set semantics
 * match), so the prior Stop having already removed the same keys does
 * not cause an error. No reflection, no nudges — those ran on the prior
 * Stop (if any).
 */
function handleSessionEnd(ctx: ServerRuntime, event: HarnessEvent): HarnessDecision {
	const { sessions } = ctx;
	sessions.remove(event.session_id);
	ctx.asyncFindings.clearSession(event.session_id);
	deleteLiveSnapshot(ctx.cwd, event.session_id);
	ctx.classifierSessions.delete(event.session_id);
	ctx.autoCoordStates.delete(event.session_id);
	return { decision: "allow" };
}

/** Stop body — turn-end reflection + trajectory persistence + cleanup.
 *
 * Three internal stages, each its own helper for readability:
 *   1. {@link buildStopWarnings} — turn-end summary + commit-cadence nudge
 *      + verification-stop-checks + dead-on-arrival
 *   2. {@link persistSessionTrajectory} — sanitize session_id + path-traversal
 *      check + write trajectory.json (async; uses fs/promises)
 *   3. {@link cleanupSessionState} — drain async analysis + cohort + reservation
 *      release + in-memory session state removal
 *
 * Stop fires per turn, so cleanup runs every turn (the per-Stop release is
 * the implicit "rebuild on next UserPromptSubmit" pattern). SessionEnd's
 * defensive cleanup mirrors this for the edge case where Stop didn't fire
 * before the session terminated.
 */
async function handleStop(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { log } = ctx;
	const turnSummary = buildTurnEndSummary(session, 0, 0);
	const turnWarnings = formatTurnEndWarnings(turnSummary);
	if (turnWarnings.length > 0) {
		log(`Turn-end patterns: ${turnSummary.turn_patterns.join(", ")}`);
	}
	for (const w of buildStopWarnings(ctx, event, session)) {
		turnWarnings.push(w);
	}
	await persistSessionTrajectory({ ctx, event, session, turnSummary });
	await ctx.asyncAnalysis.drain(ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS);
	cleanupSessionState(ctx, event, session);
	log(`Agent left: ${event.agent_name || event.session_id}`);
	return {
		decision: "allow",
		warnings: turnWarnings.length > 0 ? turnWarnings : undefined,
	};
}

/** UserPromptSubmit — cohort tracking + PII scan with redacted-prompt
 *  rewrite. Never blocks (users can always submit their own prompts);
 *  this is storage hygiene, not a policy gate. */
async function handleUserPromptSubmit(
	ctx: ServerRuntime,
	event: HarnessEvent,
): Promise<HarnessDecision> {
	const { cohort, log } = ctx;
	cohort.recordActivity(event);
	if (ctx.rules.content_scanner?.enabled && ctx.contentScanner) {
		const promptText = event.prompt ?? "";
		const scanResult = await scanUserPrompt(promptText, ctx.rules, ctx.contentScanner);
		if (scanResult) {
			log(
				`Content scanner: UserPromptSubmit — ${scanResult.findings.length} finding(s), redacted for local log`,
			);
			return { decision: "allow", redacted_prompt: scanResult.redacted };
		}
	}
	return { decision: "allow" };
}

/** SubagentStop — cohort tracking + verification-signal rollup into the
 *  parent session so the parent's Stop nudge doesn't false-positive when
 *  the agent delegated testing/verification to a subagent. */
function handleSubagentStop(ctx: ServerRuntime, event: HarnessEvent): void {
	const { cohort, sessions, log } = ctx;
	cohort.subagentLeft(event);
	const parentSessionId = resolveParentSessionId(event, cohort, sessions);
	if (
		parentSessionId &&
		sessions.rollUpVerificationSignals(event.session_id, parentSessionId)
	) {
		log(`Subagent verification rolled up into parent session ${parentSessionId}`);
	}
	log(`Subagent left: ${event.agent_name || "unnamed"}`);
}

/** SkillEnter — record a skill as active in the target session(s). When
 *  `event.session_id` is set the change is scoped; otherwise it broadcasts
 *  to every live session (CLI-driven enable-everywhere). */
function handleSkillEnter(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): HarnessDecision {
	const { sessions, log } = ctx;
	const name = (event.tool_input?.name as string | undefined)?.trim();
	if (!name) {
		return { decision: "allow", warnings: ["SkillEnter: missing tool_input.name"] };
	}
	const ttl = event.tool_input?.ttl_seconds as number | undefined;
	const sourceRaw = event.tool_input?.source as string | undefined;
	const source: "cli" | "hook" | "manual" =
		sourceRaw === SKILL_SOURCE_HOOK || sourceRaw === SKILL_SOURCE_MANUAL
			? sourceRaw
			: "cli";
	const targetSessions = event.session_id ? [session] : sessions.getAll();
	let count = 0;
	for (const target of targetSessions) {
		recordSkillEnter(target, { name, ttl_seconds: ttl, source });
		count++;
	}
	log(`SkillEnter: ${name} (${source}, ${count} session${count === 1 ? "" : "s"})`);
	return { decision: "allow" };
}

/** SkillLeave — drop a skill from the target session(s). Same broadcast
 *  semantics as SkillEnter. */
function handleSkillLeave(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): HarnessDecision {
	const { sessions, log } = ctx;
	const name = (event.tool_input?.name as string | undefined)?.trim();
	if (!name) {
		return { decision: "allow", warnings: ["SkillLeave: missing tool_input.name"] };
	}
	const targetSessions = event.session_id ? [session] : sessions.getAll();
	let removed = 0;
	for (const target of targetSessions) {
		if (recordSkillLeave(target, name)) removed++;
	}
	log(`SkillLeave: ${name} (removed from ${removed} session${removed === 1 ? "" : "s"})`);
	return { decision: "allow" };
}

/** SkillList — serialize active skills across the target session(s) into
 *  `additional_context` for the CLI to parse. `additional_context` is the
 *  only string-typed escape hatch on HarnessDecision; the CLI parses it
 *  as JSON. Acceptable because the caller is `interlinked skill list`,
 *  not an agent hook. */
function handleSkillList(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): HarnessDecision {
	const { sessions } = ctx;
	const targetSessions = event.session_id ? [session] : sessions.getAll();
	const collected = targetSessions.map((target) => ({
		session_id: target.session_id,
		agent_name: target.agent_name,
		skills: getActiveSkills(target),
	}));
	return {
		decision: "allow",
		additional_context: JSON.stringify(collected),
	};
}

// ─────────────────────────────────────────────────────────────────────
// handleStop internal helpers
// ─────────────────────────────────────────────────────────────────────

/** Thin dispatcher: commit-cadence nudge + verification-stop-checks.
 *  Each sub-stage is its own helper so this function stays a flat list
 *  of "produce a warning, maybe push it." */
function buildStopWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string[] {
	const warnings: string[] = [];
	const cadenceWarning = buildCommitCadenceNudge(ctx, event, session);
	if (cadenceWarning !== null) warnings.push(cadenceWarning);
	for (const w of buildVerificationStopWarnings(ctx, event, session)) {
		warnings.push(w);
	}
	// Deterministic pattern rescan over every file the agent touched this
	// turn. Surfaces inline-detector findings that PERSISTED into Stop —
	// either pre-existing in a touched file (per
	// `[[feedback_fix_pre_existing_in_touched_files]]`) or introduced
	// during the turn and not addressed before end. Findings carrying a
	// `// interlinked: defer <check-id>` (or `# ...`) marker are logged
	// but not amplified. Per `[[feedback_safety_continuity]]`, errors in
	// individual detectors are swallowed inside the rescan; this branch
	// never throws.
	const cwd = event.cwd || ctx.cwd;
	for (const w of buildPatternRescanWarnings(session, cwd)) {
		warnings.push(w);
	}
	return warnings;
}

/** Commit-cadence Stop nudge — encourage bundling uncommitted code-file
 *  edits into commits before ending. Doc/plan files are excluded.
 *  Wording escalates by cumulative session token count, read once from
 *  the transcript path the hook script forwarded. Returns null when the
 *  nudge is disabled, already-emitted, or below threshold; otherwise
 *  marks `stop_nudge_emitted` and returns the formatted warning. */
function buildCommitCadenceNudge(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const cadenceCfg = ctx.rules.commit_cadence;
	if (!cadenceCfg?.enabled || !session || session.stop_nudge_emitted) return null;
	const nonDocCount = session.non_doc_files_edited_since_commit?.size ?? 0;
	const docCount = session.doc_files_edited_since_commit ?? 0;
	const tokens = readSessionTokens(event.transcript_path);
	const nudge = formatStopNudge({
		uncommittedNonDocCount: nonDocCount,
		docFilesExcluded: docCount,
		threshold: cadenceCfg.stop_threshold,
		cumulativeTokens: tokens?.total,
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

/** Verification-before-stop nudges — eight independent reflection
 *  warnings keyed off `verification_observed`, `stubs_introduced`,
 *  `tdd_cycles`, `commands_run`, and `files_written` session fields.
 *  All stderr-only; none block. See docs/external-pulse/failproofai.md
 *  §"smarter Stop hooks" for the design rationale and
 *  docs/design/stop-event-checks.md for the tier-2/3 backlog. */
function buildVerificationStopWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string[] {
	const vsc = ctx.rules.verification_stop_checks;
	if (!vsc?.enabled || !session) return [];
	const verificationObserved = session.verification_observed ?? new Set<string>();
	const warnings: string[] = [];
	pushIfNotNull(
		warnings,
		vsc.warn_unverified_code
			? checkUnverifiedCode(ctx, session, verificationObserved)
			: null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_verify_not_run
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
	pushIfNotNull(warnings, checkBisectNotReset(ctx, session));
	pushIfNotNull(warnings, checkDeadOnArrival(ctx, event, session));
	return warnings;
}

function pushIfNotNull(warnings: string[], value: string | null): void {
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
		verificationObserved: Set<string>;
	}) => string | null;
	logTag: string;
}): string | null {
	const { ctx, session, verificationObserved, formatter, logTag } = opts;
	const codeFilesEdited = countCodeFilesEdited(session.files_written);
	const warning = formatter({ codeFilesEdited, verificationObserved });
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

/** Sanitize the session_id, build the trajectory.json path under
 *  `.interlinked/sessions/`, containment-check it, and write the
 *  serialized trajectory + turn-summary + feedback-effectiveness.
 *
 *  Async because the trajectory write is real disk I/O on the daemon's
 *  event loop and shouldn't block other concurrent hook evaluations.
 *  Failure is non-fatal — the catch arm logs and swallows so a transient
 *  write failure doesn't cascade into a missed Stop reply.
 *
 *  SECURITY: event.session_id arrives over the Unix socket as
 *  arbitrary JSON-parsed data. Without sanitization, a payload like
 *  "../../../.config/target" would escape sessDir via path.join (which
 *  does not contain traversal). We both sanitize (whitelist charset +
 *  length cap) and containment-check the resolved path before writing.
 *  The source-text assertions in lifecycle-events.test.ts pin both
 *  halves in place — do NOT remove sanitizeSessionId() or the
 *  resolve()/resolvedDir + sep check.
 */
async function persistSessionTrajectory(opts: {
	ctx: ServerRuntime;
	event: HarnessEvent;
	session: SessionTrajectory;
	turnSummary: ReturnType<typeof buildTurnEndSummary>;
}): Promise<void> {
	const { ctx, event, session, turnSummary } = opts;
	const trajectory = ctx.sessions.serialize(event.session_id);
	if (!trajectory) return;
	try {
		const sessDir = join(ctx.cwd, ".interlinked", "sessions");
		// `mkdir({ recursive: true })` is idempotent — it does not throw
		// when the directory already exists, so a prior `existsSync`
		// gate would be redundant.
		await mkdir(sessDir, { recursive: true });
		const safeId = sanitizeSessionId(event.session_id);
		if (!safeId) {
			throw new Error("invalid session_id: no safe characters");
		}
		const targetPath = join(sessDir, `${safeId}.trajectory.json`);
		const resolvedDir = resolve(sessDir);
		const resolvedTarget = resolve(targetPath);
		if (
			resolvedTarget !== resolvedDir &&
			!resolvedTarget.startsWith(resolvedDir + sep)
		) {
			throw new Error(
				`refusing to write trajectory outside sessions dir: ${resolvedTarget}`,
			);
		}
		await writeFile(
			targetPath,
			JSON.stringify(
				{
					...trajectory,
					turn_summary: turnSummary,
					feedback_effectiveness: computeEffectivenessSummary(session),
				},
				null,
				2,
			),
		);
		ctx.log(`Session trajectory saved: ${event.session_id}`);
	} catch (err) {
		ctx.log(
			`Failed to save trajectory (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Per-Stop cleanup: cohort departure, reservation release, in-memory
 *  session removal, async-findings clear, live-snapshot deletion,
 *  classifier + auto-coord state drop. Safe to re-run — SessionEnd's
 *  narrow body re-runs the same removals as a safety net for the edge
 *  case where Stop didn't fire before the session terminated. */
function cleanupSessionState(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): void {
	const { cohort, sessions, reservations } = ctx;
	cohort.agentLeft(event);
	reservations.releaseAllForAgent(event.agent_name || session.agent_name, cohort);
	sessions.remove(event.session_id);
	ctx.asyncFindings.clearSession(event.session_id);
	// Pair the trajectory.json archive with live-snapshot deletion —
	// once the session is permanently archived, the live snapshot is
	// noise that would otherwise be picked up by the startup sweep.
	deleteLiveSnapshot(ctx.cwd, event.session_id);
	ctx.classifierSessions.delete(event.session_id);
	ctx.autoCoordStates.delete(event.session_id);
}
