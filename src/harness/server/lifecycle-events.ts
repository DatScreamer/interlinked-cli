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
// 2026-06 refactor: stop verification helpers extracted to
// lifecycle-stop-warnings.ts; buildStopWarnings and its wiring imports
// remain here so source-text regression tests continue to pass.
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
import { scanUserPrompt } from "../content-scanner/prompt-scan.js";
import { buildEditMechanicsStopNudge } from "../edit-mechanics-stop.js";
import { resetProjectSetupWarningsCache } from "../evaluator/pre-tool.js";
import { computeEffectivenessSummary } from "../feedback-effectiveness.js";
import { refreshPriorityIfStale as refreshFilePriorityIfStale } from "../file-priority.js";
import { findRipgrep } from "../grep-accelerator.js";
import { deleteLiveSnapshot } from "../live-snapshot.js";
import {
	maybeCaptureFromPreToolUse,
	maybeCaptureFromUserPromptSubmit,
} from "../plan-capture.js";
import {
	detectPlanDrift,
	formatPlanDriftWarning,
} from "../plan-drift.js";
import { recordHarnessMissed } from "../recurrence.js";
import { runSessionEndScratchpadArchive } from "../scratchpad-archive.js";
import {
	formatSequenceFinding,
	runSequenceDetectorsForPhase,
} from "../sequence-checks/index.js";
import { sanitizeSessionId } from "../session-paths.js";
import {
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
	type SessionTracker,
} from "../session-state.js";
import { buildPatternRescanWarnings } from "../stop-rescan.js";
import { clearArchive } from "../trajectory/fingerprint-archive.js";
import { buildTurnEndSummary, formatTurnEndWarnings } from "../turn-end.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { captureAgentEvent } from "./agent-event-capture.js";
import {
	handleSkillEnter,
	handleSkillLeave,
	handleSkillList,
	handleSubagentStop,
} from "./lifecycle-events-handlers.js";
import * as lifecyclePersist from "./lifecycle-persist.js";
import {
	buildCommitCadenceNudge,
	buildVerificationStopWarnings,
} from "./lifecycle-stop-warnings.js";
import type { ServerRuntime } from "./runtime-context.js";
import { runSessionEndJobs, runSessionEndResourcePlan } from "./session-end-batch.js";
import { writeSessionEndEvidence } from "./session-end-evidence.js";
import { runSessionEndHeavyJobs } from "./session-end-heavy-jobs.js";
import { readHeavyReports } from "./session-start-heavy-reports.js";

// Re-exported so `import { resolveParentSessionId } from "./lifecycle-events.js"`
// keeps working for existing consumers/tests after the helper move.
export { resolveParentSessionId } from "./lifecycle-events-handlers.js";

/** Deadline (in ms) to drain pending async analysis work before the Stop
 *  arm completes. Mirrors server.ts's constant. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

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
	// Plan capture (PB&J item #2) — fires BEFORE the switch to observe
	// TaskCreate / ExitPlanMode on PreToolUse without intercepting the
	// pipeline. Best-effort, never blocks.
	if (event.hook_event === "PreToolUse") {
		const cfg = ctx.rules.plan_capture;
		const enabled = cfg?.enabled !== false;
		const captured = await maybeCaptureFromPreToolUse({
			event,
			session,
			cwd: ctx.cwd,
			enabled,
			log: ctx.log,
		});
		if (captured) {
			ctx.log(
				`Plan capture: ${captured.source} → ${captured.steps.length} step(s) (session ${captured.session_id})`,
			);
		}
	}
	switch (event.hook_event) {
		case "SessionStart":
			return handleSessionStart(ctx, event);
		case "SessionEnd":
			return handleSessionEnd(ctx, event);
		case "Stop":
			return handleStop(ctx, event, session);
		case "UserPromptSubmit":
			return handleUserPromptSubmit(ctx, event, session);
		case "SubagentStart":
			cohort.subagentJoined(event);
			captureAgentEvent(event, ctx.cwd, log);
			log(`Subagent joined: ${event.agent_name || "unnamed"}`);
			return null;
		case "SubagentStop":
			handleSubagentStop(ctx, event);
			// Durable capture: the subagent's RESULT (last_assistant_message /
			// transcript tail) → collection.jsonl, + its transcript → timeline.
			// Without this, a spawned agent's answer exists nowhere under
			// .interlinked/ (background results fire no other hook).
			captureAgentEvent(event, ctx.cwd, log);
			return null;
		case "TaskCompleted":
			cohort.recordActivity(event);
			captureAgentEvent(event, ctx.cwd, log);
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
	// Surface any completed SessionEnd heavy-job reports (fuzz-smoke failures,
	// bench regressions) as SessionStart context — never a mid-session surprise.
	// Fuzz failures are also recorded as a harness_missed recurrence.
	const heavyWarnings = readHeavyReports(ctx.cwd, (failed, files) => {
		recordHarnessMissed({
			signature: "fuzz_smoke_failure",
			check_id: "fuzz_smoke",
			message: `${failed} property/fuzz assertion(s) failed under elevated numRuns: ${files.join(", ")}`,
			cwd: ctx.cwd,
		});
	});
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
			return { decision: "allow", warnings: [...heavyWarnings, warning] };
		}
	} catch (err) {
		log(`Permission-rule auto-strip failed (non-fatal): ${err}`);
	}
	return heavyWarnings.length > 0 ? { decision: "allow", warnings: heavyWarnings } : null;
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
	// Archive the session scratchpad before the OS purges it (scratchpad-
	// governance Phase 1). Never-throw by contract; bounded by config caps.
	runSessionEndScratchpadArchive({
		cwd: ctx.cwd,
		sessionId: event.session_id,
		rules: ctx.rules,
		log: ctx.log,
	});
	// Good-citizen resource plan + fire-and-forget background jobs (job 4:
	// recurrence scan). Compute BEFORE state removal so the cohort count is
	// accurate; the jobs self-skip when the governor defers or env opts out.
	const resourcePlan = runSessionEndResourcePlan(ctx, event);
	if (resourcePlan) {
		runSessionEndJobs(ctx, resourcePlan);
		runSessionEndHeavyJobs(ctx, event, resourcePlan); // fuzz-smoke + bench (run-if-exists)
	}
	// Evidence bundle (job 5): honest closeout from the session's observed
	// signals — written BEFORE removal, while the counts are still present.
	const endedSession = sessions.get(event.session_id);
	if (endedSession) writeSessionEndEvidence(ctx.cwd, endedSession);
	sessions.remove(event.session_id);
	ctx.asyncFindings.clearSession(event.session_id);
	clearArchive(ctx.cwd, event.session_id);
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
	// Plan-drift reflection (PB&J item #6) — compare session.declared_plan
	// against the actual tool_sequence; advisory-only, never blocks.
	const driftReport = detectPlanDrift(session);
	if (driftReport) {
		const driftWarning = formatPlanDriftWarning({ report: driftReport });
		if (driftWarning) turnWarnings.push(driftWarning);
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
	session?: SessionTrajectory,
): Promise<HarnessDecision> {
	const { cohort, log } = ctx;
	cohort.recordActivity(event);
	// Plan capture (PB&J item #2) — structured `## Plan` parser, behind a
	// config flag (default off — false-positive risk). Best-effort.
	if (session) {
		const planCfg = ctx.rules.plan_capture;
		const planCaptured = await maybeCaptureFromUserPromptSubmit({
			event,
			session,
			cwd: ctx.cwd,
			enabled: planCfg?.enabled !== false,
			parseUserPrompt: planCfg?.parse_userprompt === true,
			log: ctx.log,
		});
		if (planCaptured) {
			log(
				`Plan capture (user-prompt): ${planCaptured.steps.length} step(s) (session ${planCaptured.session_id})`,
			);
		}
	}
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

// ─────────────────────────────────────────────────────────────────────
// handleStop internal helpers
// ─────────────────────────────────────────────────────────────────────

/** Thin dispatcher: commit-cadence nudge + verification-stop-checks.
 *  Each sub-stage is its own helper so this function stays a flat list
 *  of "produce a warning, maybe push it." Heavy check helpers live in
 *  lifecycle-stop-warnings.ts; this dispatcher and its wiring imports
 *  stay here so source-text regression tests pin the Stop→rescan wiring. */
function buildStopWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string[] {
	const warnings: string[] = [];
	const cadenceWarning = buildCommitCadenceNudge(ctx, event, session);
	if (cadenceWarning !== null) warnings.push(cadenceWarning);
	// LG-5 edit-mechanics reflection — doomed-anchor/rescue/staleness summary.
	const editMechanicsWarning = buildEditMechanicsStopNudge(session);
	if (editMechanicsWarning !== null) warnings.push(editMechanicsWarning);
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
	// Stop-phase sequence detectors — multi-event quality + cross-agent +
	// install-then-execute shapes. Sibling family to `buildPatternRescanWarnings`
	// (which rescans per-file content); these run over the trajectory state.
	// No-op until detectors register with `default_enabled: true`.
	const stopFindings = runSequenceDetectorsForPhase({
		phase: "stop",
		trajectory: session,
		candidate: event,
	});
	for (const f of stopFindings) warnings.push(formatSequenceFinding(f));
	return warnings;
}

// persistSessionTrajectory + cleanupSessionState moved VERBATIM to
// lifecycle-persist.ts (line-cap decomposition, 2026-07-17); the source-text
// security pins moved to lifecycle-persist.test.ts. Local bindings preserved
// so handleStop's call sites stay byte-stable.
const { persistSessionTrajectory, cleanupSessionState } = lifecyclePersist;
