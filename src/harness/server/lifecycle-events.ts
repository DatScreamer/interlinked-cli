// ===========================================
// Lifecycle event handling
// ===========================================
// The `switch (event.hook_event)` block extracted verbatim from
// `processEvent` in server.ts. Handles every non-tool hook event —
// SessionStart, SessionEnd / Stop, UserPromptSubmit, Subagent*, Skill*.
//
// `handleLifecycleEvent` returns:
//   - a `HarnessDecision` when the lifecycle branch produced an early
//     return (the original `switch` had `return { … }` arms);
//   - `null` when the original `switch` arm fell through with `break`,
//     i.e. the caller should continue into the Pre/Post evaluation path.
//
// Behavior-preserving move: the only change is bare module-level state
// (`rules`, `cohort`, …) becoming `ctx.rules`, `ctx.cohort`, ….

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { findRipgrep } from "../grep-accelerator.js";
import { deleteLiveSnapshot } from "../live-snapshot.js";
import { isErr, tryFn } from "../result.js";
import { sanitizeSessionId } from "../session-paths.js";
import {
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
	type SessionTracker,
} from "../session-state.js";
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

/** Deadline (in ms) to drain pending async analysis work before the
 *  SessionEnd / Stop arm completes. Mirrors server.ts's constant. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

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
	const { cohort, sessions, reservations, log } = ctx;
	switch (event.hook_event) {
		case "SessionStart": {
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
			break;
		}
		case "SessionEnd":
		case "Stop": {
			// Build turn-end summary before cleanup (trajectory-level analysis)
			const turnSummary = buildTurnEndSummary(session, 0, 0);
			const turnWarnings = formatTurnEndWarnings(turnSummary);
			if (turnWarnings.length > 0) {
				log(`Turn-end patterns: ${turnSummary.turn_patterns.join(", ")}`);
			}

			// Commit-cadence Stop nudge — encourage bundling uncommitted code-file
			// edits into commits before ending. Doc/plan files are excluded.
			// Wording escalates by cumulative session token count, read once
			// from the transcript path the hook script forwarded.
			const cadenceCfg = ctx.rules.commit_cadence;
			if (cadenceCfg?.enabled && session && !session.stop_nudge_emitted) {
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
				if (nudge !== null) {
					turnWarnings.push(nudge);
					session.stop_nudge_emitted = true;
					log(
						`Commit-cadence Stop nudge: ${nonDocCount} uncommitted code files, ${docCount} doc files excluded, tokens=${tokens?.total ?? "n/a"}`,
					);
				}
			}

			// Verification-before-stop nudges — three independent reflection
			// warnings keyed off the verification_observed / stubs_introduced
			// session fields populated by session-state.ts (signals) and the
			// post-tool evaluator (stubs). All stderr-only; none block. See
			// docs/external-pulse/failproofai.md §"smarter Stop hooks" for the
			// design rationale and docs/design/stop-event-checks.md for the
			// tier-2/3 backlog.
			const vsc = ctx.rules.verification_stop_checks;
			if (vsc?.enabled && session) {
				const verificationObserved = session.verification_observed ?? new Set<string>();
				if (vsc.warn_unverified_code) {
					const codeFilesEdited = countCodeFilesEdited(session.files_written);
					const warning = formatUnverifiedCodeWarning({ codeFilesEdited, verificationObserved });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(
							`Verify-before-stop: unverified-code (${codeFilesEdited} files, signals=${[...verificationObserved].join(",") || "none"})`,
						);
					}
				}
				if (vsc.warn_verify_not_run) {
					const codeFilesEdited = countCodeFilesEdited(session.files_written);
					const warning = formatVerifyNotRunWarning({ codeFilesEdited, verificationObserved });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(
							`Verify-before-stop: verify-suite-not-run (${codeFilesEdited} files, signals=${[...verificationObserved].join(",") || "none"})`,
						);
					}
				}
				if (vsc.warn_ui_not_interacted) {
					const uiFilesEdited = countUiFilesEdited(session.files_written);
					const warning = formatUiNotInteractedWarning({ uiFilesEdited, verificationObserved });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(`Verify-before-stop: ui-not-interacted (${uiFilesEdited} files)`);
					}
				}
				if (vsc.warn_stubs_introduced) {
					const stubs = session.stubs_introduced ?? [];
					const warning = formatStubsIntroducedWarning({ stubs });
					if (warning !== null) {
						turnWarnings.push(warning);
						log(`Verify-before-stop: stubs-introduced (${stubs.length})`);
					}
				}
				// TDD regression — a test that was green earlier this session
				// is now red, so this session's edits broke working behavior.
				const tddRegressions: Array<{ sourceFile: string }> = [];
				for (const cycle of session.tdd_cycles.values()) {
					if (cycle.state === "regression") {
						tddRegressions.push({ sourceFile: cycle.source_file });
					}
				}
				const regressionWarning = formatTddRegressionWarning({
					regressions: tddRegressions,
				});
				if (regressionWarning !== null) {
					turnWarnings.push(regressionWarning);
					log(`Verify-before-stop: tdd-regression (${tddRegressions.length})`);
				}
				// Unfinished git bisect — a bisect start/op with no reset after
				// it leaves the repo in detached-HEAD bisect state.
				const bisectWarning = formatBisectNotResetWarning({
					commandsRun: session.commands_run,
				});
				if (bisectWarning !== null) {
					turnWarnings.push(bisectWarning);
					log("Verify-before-stop: bisect-not-reset");
				}
				// Dead-on-arrival — a file edited this session whose fresh
				// Supermodel `.graph` shard reports zero dependent files and
				// no callers: nothing imports it or calls into it. Plan 08
				// §3c. Freshness-gated (only E-fresh shards), so a stale or
				// missing shard yields no finding — zero false positives.
				const doaHits = detectDeadOnArrival(session.files_written, event.cwd || ctx.cwd);
				const doaWarning = formatDeadOnArrivalWarning(doaHits, event.cwd || ctx.cwd);
				if (doaWarning !== null) {
					turnWarnings.push(doaWarning);
					log(`Verify-before-stop: dead-on-arrival (${doaHits.length})`);
				}
			}

			// Persist session trajectory + turn summary before cleanup
			const trajectory = sessions.serialize(event.session_id);
			if (trajectory) {
				const saveResult = tryFn(() => {
					const sessDir = join(ctx.cwd, ".interlinked", "sessions");
					if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
					// SECURITY: event.session_id arrives over the Unix socket as
					// arbitrary JSON-parsed data. Without sanitization, a payload
					// like "../../../.config/target" would escape sessDir via
					// path.join (which does not contain traversal). We both
					// sanitize (whitelist charset + length cap) and containment-
					// check the resolved path before writing.
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
					writeFileSync(
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
				});
				if (isErr(saveResult)) {
					log(`Failed to save trajectory (non-fatal): ${saveResult.error.message}`);
				} else {
					log(`Session trajectory saved: ${event.session_id}`);
				}
			}

			// Drain any in-flight async analysis before cleanup
			await ctx.asyncAnalysis.drain(ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS);

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
			log(`Agent left: ${event.agent_name || event.session_id}`);
			return {
				decision: "allow",
				warnings: turnWarnings.length > 0 ? turnWarnings : undefined,
			};
		}
		case "UserPromptSubmit": {
			cohort.recordActivity(event);
			// Scan the prompt for PII. On findings, return a redacted copy so the
			// hook stores the masked version in activity.jsonl instead of the raw.
			// Never blocks — users are always allowed to submit their own prompts;
			// this is storage hygiene, not a policy gate.
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
		case "SubagentStart":
			cohort.subagentJoined(event);
			log(`Subagent joined: ${event.agent_name || "unnamed"}`);
			break;
		case "SubagentStop": {
			cohort.subagentLeft(event);
			// Roll the subagent's verification signals up into the parent
			// session so the parent's Stop nudge doesn't false-positive when
			// the agent delegated testing/verification to a subagent.
			const parentSessionId = resolveParentSessionId(event, cohort, sessions);
			if (
				parentSessionId &&
				sessions.rollUpVerificationSignals(event.session_id, parentSessionId)
			) {
				log(`Subagent verification rolled up into parent session ${parentSessionId}`);
			}
			log(`Subagent left: ${event.agent_name || "unnamed"}`);
			break;
		}
		case "SkillEnter": {
			const name = (event.tool_input?.name as string | undefined)?.trim();
			if (!name) {
				return { decision: "allow", warnings: ["SkillEnter: missing tool_input.name"] };
			}
			const ttl = event.tool_input?.ttl_seconds as number | undefined;
			const sourceRaw = event.tool_input?.source as string | undefined;
			const source: "cli" | "hook" | "manual" =
				sourceRaw === "hook" || sourceRaw === "manual" ? sourceRaw : "cli";
			const targetSessions = event.session_id
				? [session]
				: sessions.getAll();
			let count = 0;
			for (const target of targetSessions) {
				recordSkillEnter(target, { name, ttl_seconds: ttl, source });
				count++;
			}
			log(`SkillEnter: ${name} (${source}, ${count} session${count === 1 ? "" : "s"})`);
			return { decision: "allow" };
		}
		case "SkillLeave": {
			const name = (event.tool_input?.name as string | undefined)?.trim();
			if (!name) {
				return { decision: "allow", warnings: ["SkillLeave: missing tool_input.name"] };
			}
			const targetSessions = event.session_id
				? [session]
				: sessions.getAll();
			let removed = 0;
			for (const target of targetSessions) {
				if (recordSkillLeave(target, name)) removed++;
			}
			log(`SkillLeave: ${name} (removed from ${removed} session${removed === 1 ? "" : "s"})`);
			return { decision: "allow" };
		}
		case "SkillList": {
			// `additional_context` is the only string-typed escape hatch on
			// HarnessDecision; the CLI parses it as JSON. Acceptable because
			// the caller is `interlinked skill list`, not an agent hook.
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
		default:
			cohort.recordActivity(event);
			break;
	}
	// Fell through (a `break` arm): the caller continues into Pre/Post.
	return null;
}
