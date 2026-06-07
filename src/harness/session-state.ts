// ===========================================
// Session State — Per-session trajectory tracking
// ===========================================

import { resolve as resolvePath } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
// `captureGitBaseline` lives in its own module (session-git-baseline.ts) to
// keep this file under the per-file line cap; re-exported below so existing
// `from "./session-state.js"` importers keep working unchanged.
import { captureGitBaseline } from "./session-git-baseline.js";
export { captureGitBaseline } from "./session-git-baseline.js";
// Sequence-detector input population (recent_line_edits / literal_occurrences)
// lives in session-literals.ts (a line-cap split). recordEvent drives the four
// helpers below; the full set is re-exported for existing importers.
import {
	extractWriteChunks,
	isPostToolUseEvent,
	isSequenceWriteOperation,
	recordLiteralOccurrences,
	recordRecentLineEdit,
} from "./session-literals.js";
export {
	extractNonTrivialLiterals,
	extractWriteChunks,
	isPostToolUseEvent,
	isSequenceWriteOperation,
	recordLiteralOccurrences,
	recordRecentLineEdit,
} from "./session-literals.js";
// Active-skill markers live in session-skills.ts (a line-cap split). recordEvent
// drives gcExpiredSkills; the full set + SkillEnterArgs are re-exported below.
import { gcExpiredSkills } from "./session-skills.js";
export {
	gcExpiredSkills,
	getActiveSkills,
	recordSkillEnter,
	recordSkillLeave,
} from "./session-skills.js";
export type { SkillEnterArgs } from "./session-skills.js";
// Snapshot serialize/hydrate coercion helpers live in session-snapshot-codec.ts
// (also a line-cap split). They are internal to serialize()/hydrate() and were
// never part of this module's public API, so they are imported, not re-exported.
import {
	readActiveSkills,
	readAssertionCountsMap,
	readBoolean,
	readCapturedPlan,
	readConsecutivePattern,
	readFailedFiles,
	readGitSessionBaseline,
	readNumber,
	readNumberArray,
	readNumberMap,
	readNumberRecord,
	readPendingCompletions,
	readSensitivity,
	readString,
	readStringArray,
	readStringMap,
	readStringSet,
	readStubsIntroduced,
	readTaintSources,
	readTddCycles,
	readTestRuns,
	readWarnings,
	serializeCapturedPlan,
} from "./session-snapshot-codec.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";
import {
	classifyBrowserToolName,
	classifyVerificationCommand,
	STUB_INTRODUCED_CAP,
} from "./verification-stop-checks.js";

/** Bumped when the serialized snapshot shape changes incompatibly. Hydrate
 *  refuses snapshots from a higher version (newer harness wrote it) and
 *  best-effort upgrades older shapes. */
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

/** Phase 1 Channel 5 (rollback feasibility) provenance check. Returns true
 *  iff the session has a successful write to this exact file in its trajectory.
 *  Path-shape agnostic: matches whether the caller passes the raw form (as the
 *  runner originally sent it) or the resolved absolute form. Without this, the
 *  rollback channel would either miss legitimate edits (when stored shape !=
 *  lookup shape) or attribute the user's own changes to Interlinked. */
export function isFileTrackedAsWritten(
	session: SessionTrajectory,
	filePath: string,
	cwd?: string,
): boolean {
	if (session.files_written.has(filePath)) return true;
	const baseCwd = cwd ?? process.cwd();
	const absPath = resolvePath(baseCwd, filePath);
	return session.files_written.has(absPath);
}

export class SessionTracker {
	private sessions: Map<string, SessionTrajectory> = new Map();

	get(sessionId: string): SessionTrajectory | undefined {
		return this.sessions.get(sessionId);
	}

	recordEvent(event: HarnessEvent): SessionTrajectory {
		const session = this.getOrCreateSession(event);

		// Update agent name if resolved later (e.g., after register_agent)
		if (event.agent_name && session.agent_name.startsWith("session-")) {
			session.agent_name = event.agent_name;
		}

		trackToolCall(session, event);
		trackErrorOutcome(session, event);
		trackFileOperations(session, event);
		trackCommand(session, event);

		gcExpiredSkills(session);

		return session;
	}

	/**
	 * Look up the session for this event, creating (and registering) a fresh
	 * trajectory on first sight. Defensive: events without a session_id (some
	 * SessionStart variants, malformed probes) get a synthesized fallback id
	 * rather than crashing — a dropped trajectory beats a dead harness that
	 * fails open on the next PreToolUse scan.
	 */
	private getOrCreateSession(event: HarnessEvent): SessionTrajectory {
		const sessionId = event.session_id || `unknown-${Date.now().toString(36)}`;
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const session = createFreshSession(event, sessionId);
		this.sessions.set(sessionId, session);
		return session;
	}

	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/**
	 * Roll the verification-related signals of one session (typically a
	 * subagent's) into another (its parent). Called at SubagentStop so a
	 * parent's Stop nudge doesn't false-positive ("no verification this
	 * session", "no tests run") when the agent delegated testing or
	 * verification to a subagent — exactly the test-runner-subagent pattern
	 * the agentic-engineering-patterns guide recommends.
	 *
	 * Merges `verification_observed` (set union), `test_runs` and
	 * `tdd_cycles` (gap-fill only — the parent's own entry for a file is
	 * newer and authoritative, never clobbered), and `stubs_introduced`
	 * (append, capped). Returns true when both sessions exist and distinct.
	 */
	rollUpVerificationSignals(fromSessionId: string, toSessionId: string): boolean {
		if (fromSessionId === toSessionId) return false;
		const from = this.sessions.get(fromSessionId);
		const to = this.sessions.get(toSessionId);
		if (!from || !to) return false;

		mergeVerificationObserved(from, to);

		// Gap-fill only: a run/cycle the parent already tracks for a file is
		// newer than the subagent's, so never overwrite it.
		for (const [file, run] of from.test_runs) {
			if (!to.test_runs.has(file)) to.test_runs.set(file, { ...run });
		}
		for (const [file, cycle] of from.tdd_cycles) {
			if (!to.tdd_cycles.has(file)) to.tdd_cycles.set(file, { ...cycle });
		}

		appendStubsCapped(from, to);
		return true;
	}

	/**
	 * Roll a subagent's file-tracking state into its parent at SubagentStop.
	 * Parallel to {@link rollUpVerificationSignals}: verification signals and
	 * file-tracking state are independent concerns sharing a call site, so
	 * they get parallel functions rather than one monolithic rollup. The
	 * git-baseline is deliberately NOT rolled up — the parent's baseline is
	 * canonical. Without this rollup, parent agents can't legitimately commit
	 * files their subagents wrote (git-session-scope-gate would refuse).
	 *
	 * Merge semantics:
	 *  - files_written / files_read: set union (parent ∪ subagent).
	 *  - file_write_times: gap-fill (don't clobber parent's newer entries).
	 *  - file_edit_counts: sum (parent + subagent counts).
	 */
	rollUpFileTracking(fromSessionId: string, toSessionId: string): boolean {
		if (fromSessionId === toSessionId) return false;
		const from = this.sessions.get(fromSessionId);
		const to = this.sessions.get(toSessionId);
		if (!from || !to) return false;

		for (const f of from.files_written) to.files_written.add(f);
		for (const f of from.files_read) to.files_read.add(f);

		for (const [file, ts] of from.file_write_times) {
			if (!to.file_write_times.has(file)) to.file_write_times.set(file, ts);
		}

		for (const [file, count] of from.file_edit_counts) {
			to.file_edit_counts.set(file, (to.file_edit_counts.get(file) ?? 0) + count);
		}

		return true;
	}

	/**
	 * Serialize a session trajectory to a JSON-safe snapshot. Used for both
	 * the post-end `<id>.trajectory.json` archive and the in-flight
	 * `<id>.live.json` snapshot — the shape is identical and lossless against
	 * `hydrate()`. The runtime-only `trajectoryDetector` is intentionally
	 * dropped (it's lazily reconstructed on the next event when feature flags
	 * call for it). `step_limit` of `Infinity` is encoded as `null` because
	 * JSON has no Infinity literal; `hydrate()` reverses the mapping.
	 */
	serialize(sessionId: string): JsonObject | null {
		const s = this.sessions.get(sessionId);
		if (!s) return null;
		const endedAt = new Date().toISOString();
		const stepLimit = Number.isFinite(s.step_limit) ? s.step_limit : null;
		return {
			schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
			session_id: s.session_id,
			agent_name: s.agent_name,
			started_at: s.started_at,
			ended_at: endedAt,
			duration_s: Math.round(
				(new Date(endedAt).getTime() - new Date(s.started_at).getTime()) / 1000,
			),
			tool_call_count: s.tool_call_count,
			error_count: s.error_count,
			mcp_tools_used: s.mcp_tools_used,
			local_tools_used: s.local_tools_used,
			sensitivity_level: s.sensitivity_level,
			step_limit: stepLimit,
			consecutive_pattern: s.consecutive_pattern,
			last_coordination_at: s.last_coordination_at,
			last_coordination_ts: s.last_coordination_ts,
			files_read: [...s.files_read],
			files_written: [...s.files_written],
			commands_run: s.commands_run,
			tool_sequence: s.tool_sequence,
			curl_localhost_count: s.curl_localhost_count,
			taint_sources: s.taint_sources,
			injection_detected_steps: s.injection_detected_steps,
			pii_detected_steps: s.pii_detected_steps,
			suggested_permissions: [...s.suggested_permissions],
			acknowledged_checks: [...s.acknowledged_checks],
			fired_reminders: [...s.fired_reminders],
			soft_blocks: [...s.soft_blocks],
			silent_failure_warned: [...s.silent_failure_warned],
			bloat_warned: [...s.bloat_warned],
			file_write_times: Object.fromEntries(s.file_write_times),
			file_read_at: Object.fromEntries(s.file_read_at),
			failed_files: Object.fromEntries(
				[...s.failed_files.entries()].map(([k, v]) => [k, { ...v }]),
			),
			pending_completions: Object.fromEntries(
				[...s.pending_completions.entries()].map(([k, v]) => [
					k,
					{ ...v, resolved_files: [...v.resolved_files] },
				]),
			),
			file_edit_counts: Object.fromEntries(s.file_edit_counts),
			warnings_issued: Object.fromEntries(
				[...s.warnings_issued.entries()].map(([k, v]) => [k, { ...v }]),
			),
			tdd_cycles: Object.fromEntries(
				[...s.tdd_cycles.entries()].map(([k, v]) => [k, { ...v }]),
			),
			consecutive_tool_failures: Object.fromEntries(s.consecutive_tool_failures),
			test_runs: Object.fromEntries(
				[...s.test_runs.entries()].map(([k, v]) => [k, { ...v }]),
			),
			active_skills: s.active_skills
				? Object.fromEntries([...s.active_skills.entries()].map(([k, v]) => [k, { ...v }]))
				: {},
			non_doc_files_edited_since_commit: s.non_doc_files_edited_since_commit
				? [...s.non_doc_files_edited_since_commit]
				: [],
			doc_files_edited_since_commit: s.doc_files_edited_since_commit ?? 0,
			mid_session_nudge_emitted: s.mid_session_nudge_emitted ?? false,
			stop_nudge_emitted: s.stop_nudge_emitted ?? false,
			assertion_counts: Object.fromEntries(
				[...s.assertion_counts.entries()].map(([k, v]) => [k, { ...v }]),
			),
			verification_observed: s.verification_observed ? [...s.verification_observed] : [],
			stubs_introduced: s.stubs_introduced ? s.stubs_introduced.map((e) => ({ ...e })) : [],
			declared_plan: s.declared_plan ? serializeCapturedPlan(s.declared_plan) : null,
			git_session_baseline: s.git_session_baseline
				? {
						head_sha: s.git_session_baseline.head_sha,
						modified: [...s.git_session_baseline.modified],
						staged: [...s.git_session_baseline.staged],
						untracked: [...s.git_session_baseline.untracked],
					}
				: null,
		};
	}

	/**
	 * Reconstruct a SessionTrajectory from a `serialize()` snapshot and add it
	 * to the tracker. Used on harness restart when the next event for an
	 * already-active session arrives — without this, every restart would
	 * silently reset session-relative behavior (acknowledged checks, edit
	 * counts, fired reminders, TDD cycles, ...).
	 *
	 * Defensive: every field is coerced through a reader that falls back to
	 * the same default `recordEvent` uses for a fresh session. Returns null
	 * only on missing `session_id` (the one required field).
	 */
	hydrate(snapshot: JsonObject): SessionTrajectory | null {
		const schemaVersion = readNumber(snapshot.schema_version, 0);
		if (schemaVersion > SESSION_SNAPSHOT_SCHEMA_VERSION) return null;

		const sessionId = readString(snapshot.session_id);
		if (!sessionId) return null;

		const stepLimit =
			snapshot.step_limit === null || snapshot.step_limit === undefined
				? Number.POSITIVE_INFINITY
				: typeof snapshot.step_limit === "number" && Number.isFinite(snapshot.step_limit)
					? snapshot.step_limit
					: Number.POSITIVE_INFINITY;

		const session: SessionTrajectory = {
			session_id: sessionId,
			agent_name: readString(snapshot.agent_name) ?? `session-${sessionId.slice(0, 8)}`,
			started_at: readString(snapshot.started_at) ?? new Date().toISOString(),
			tool_call_count: readNumber(snapshot.tool_call_count, 0),
			error_count: readNumber(snapshot.error_count, 0),
			mcp_tools_used: readNumber(snapshot.mcp_tools_used, 0),
			local_tools_used: readNumber(snapshot.local_tools_used, 0),
			sensitivity_level: readSensitivity(snapshot.sensitivity_level),
			step_limit: stepLimit,
			consecutive_pattern: readConsecutivePattern(snapshot.consecutive_pattern),
			last_coordination_at: readNumber(snapshot.last_coordination_at, 0),
			last_coordination_ts: readNumber(snapshot.last_coordination_ts, Date.now()),
			files_read: readStringSet(snapshot.files_read),
			files_written: readStringSet(snapshot.files_written),
			commands_run: readStringArray(snapshot.commands_run),
			tool_sequence: readStringArray(snapshot.tool_sequence),
			curl_localhost_count: readNumberRecord(snapshot.curl_localhost_count),
			taint_sources: readTaintSources(snapshot.taint_sources),
			injection_detected_steps: readNumberArray(snapshot.injection_detected_steps),
			pii_detected_steps: readNumberArray(snapshot.pii_detected_steps),
			suggested_permissions: readStringSet(snapshot.suggested_permissions),
			acknowledged_checks: readStringSet(snapshot.acknowledged_checks),
			fired_reminders: readStringSet(snapshot.fired_reminders),
			soft_blocks: readStringSet(snapshot.soft_blocks),
			silent_failure_warned: readStringSet(snapshot.silent_failure_warned),
			bloat_warned: readStringSet(snapshot.bloat_warned),
			file_write_times: readStringMap(snapshot.file_write_times),
			file_read_at: readNumberMap(snapshot.file_read_at),
			failed_files: readFailedFiles(snapshot.failed_files),
			pending_completions: readPendingCompletions(snapshot.pending_completions),
			file_edit_counts: readNumberMap(snapshot.file_edit_counts),
			warnings_issued: readWarnings(snapshot.warnings_issued),
			tdd_cycles: readTddCycles(snapshot.tdd_cycles),
			consecutive_tool_failures: readNumberMap(snapshot.consecutive_tool_failures),
			test_runs: readTestRuns(snapshot.test_runs),
			active_skills: readActiveSkills(snapshot.active_skills),
			non_doc_files_edited_since_commit: readStringSet(
				snapshot.non_doc_files_edited_since_commit,
			),
			doc_files_edited_since_commit: readNumber(snapshot.doc_files_edited_since_commit, 0),
			mid_session_nudge_emitted: readBoolean(snapshot.mid_session_nudge_emitted),
			stop_nudge_emitted: readBoolean(snapshot.stop_nudge_emitted),
			assertion_counts: readAssertionCountsMap(snapshot.assertion_counts),
			verification_observed: readStringSet(snapshot.verification_observed),
			stubs_introduced: readStubsIntroduced(snapshot.stubs_introduced),
			declared_plan: readCapturedPlan(snapshot.declared_plan),
			git_session_baseline: readGitSessionBaseline(snapshot.git_session_baseline),
		};

		this.sessions.set(sessionId, session);
		return session;
	}

	getAll(): SessionTrajectory[] {
		return [...this.sessions.values()];
	}

	/** Detect sessions that haven't had events in the given timeout (used for lost agent cleanup) */
	detectStale(timeoutMs: number): SessionTrajectory[] {
		const cutoff = Date.now() - timeoutMs;
		return this.getAll().filter(
			(s) => s.tool_call_count > 0 && new Date(s.started_at).getTime() < cutoff,
		);
	}
}

/**
 * Set-union the subagent's verification_observed signals into the parent.
 * Extracted from rollUpVerificationSignals to keep that orchestrator thin;
 * lazily allocates the parent's set on first use.
 */
function mergeVerificationObserved(from: SessionTrajectory, to: SessionTrajectory): void {
	if (!from.verification_observed || from.verification_observed.size === 0) return;
	if (!to.verification_observed) to.verification_observed = new Set();
	for (const sig of from.verification_observed) to.verification_observed.add(sig);
}

/**
 * Append the subagent's introduced stubs onto the parent, honoring the global
 * STUB_INTRODUCED_CAP. Extracted from rollUpVerificationSignals; lazily
 * allocates the parent's array on first use.
 */
function appendStubsCapped(from: SessionTrajectory, to: SessionTrajectory): void {
	if (!from.stubs_introduced || from.stubs_introduced.length === 0) return;
	if (!to.stubs_introduced) to.stubs_introduced = [];
	for (const stub of from.stubs_introduced) {
		if (to.stubs_introduced.length >= STUB_INTRODUCED_CAP) break;
		to.stubs_introduced.push({ ...stub });
	}
}

/**
 * Build a fresh SessionTrajectory for a not-yet-seen session id. Split out of
 * recordEvent so the orchestrator stays a thin dispatcher; the object literal
 * carries no decision logic beyond its two coalescing defaults.
 */
function createFreshSession(event: HarnessEvent, sessionId: string): SessionTrajectory {
	return {
		session_id: sessionId,
		agent_name: event.agent_name || `session-${sessionId.slice(0, 8)}`,
		started_at: event.timestamp,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: Date.now(),
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		active_skills: new Map(),
		non_doc_files_edited_since_commit: new Set(),
		doc_files_edited_since_commit: 0,
		mid_session_nudge_emitted: false,
		stop_nudge_emitted: false,
		assertion_counts: new Map(),
		verification_observed: new Set(),
		stubs_introduced: [],
		git_session_baseline: captureGitBaseline(event.cwd ?? process.cwd()),
	};
}

/**
 * Per-tool-call bookkeeping: total/MCP/local counts, the bounded tool sequence
 * used for pattern detection, and browser-MCP UI-verification signals. No-op
 * when the event carries no tool_name.
 */
function trackToolCall(session: SessionTrajectory, event: HarnessEvent): void {
	if (!event.tool_name) return;
	session.tool_call_count++;

	// Classify as MCP or local tool
	if (event.tool_name.startsWith("mcp__")) {
		session.mcp_tools_used++;
	} else {
		session.local_tools_used++;
	}

	// Track tool sequence for pattern detection
	const target = extractToolTarget(event);
	session.tool_sequence.push(`${event.tool_name}:${target}`);
	if (session.tool_sequence.length > 20) {
		session.tool_sequence = session.tool_sequence.slice(-20);
	}

	// Verification-before-stop: record browser-MCP interactions as a UI
	// verification signal. Bash-command verification signals are captured in
	// trackCommand.
	const browserKind = classifyBrowserToolName(event.tool_name);
	if (browserKind) {
		if (!session.verification_observed) session.verification_observed = new Set();
		session.verification_observed.add(browserKind);
	}
}

/**
 * Outcome-gated error/recovery counters. Increments error_count and the
 * per-tool consecutive-failure counter on `error`; a `success` for a tool
 * resets that tool's counter.
 *
 * Outcome-gated, not event-name-gated: Claude/Codex/Gemini/Copilot fold tool
 * failures into the regular Post* event carrying tool_outcome === "error", and
 * Cursor's dedicated postToolUseFailure also produces tool_outcome === "error"
 * via the attachOutcome call in the normalizer. The previous event-name gates
 * were inverted for folded failures — error_count never bumped, and
 * consecutive_tool_failures was *cleared* by the very events that should have
 * incremented it. Phase 1 channels (recurrence, triage, recovery) read these
 * counters to make decisions.
 */
function trackErrorOutcome(session: SessionTrajectory, event: HarnessEvent): void {
	if (event.tool_outcome === "error") {
		session.error_count++;
		if (event.tool_name) {
			const prev = session.consecutive_tool_failures.get(event.tool_name) || 0;
			session.consecutive_tool_failures.set(event.tool_name, prev + 1);
		}
	} else if (event.tool_outcome === "success" && event.tool_name) {
		// A successful invocation of this tool resets the consecutive counter.
		session.consecutive_tool_failures.delete(event.tool_name);
	}
}

/**
 * Read/write file-tracking for one event. Provenance gate (Channel 5 rollback
 * feasibility) requires files_written contain only paths we actually wrote
 * successfully — gating on a non-error/non-interrupted outcome prevents a
 * failed Edit attempt from being attributed to us. Path normalization stores
 * BOTH the raw form (preserves existing `.has(rawPath)` consumers in
 * structural-checks / behavioral-checks / suggestion-scorer) AND the resolved
 * absolute form (lets the Channel 5 provenance check do `.has(resolve(cwd, p))`
 * reliably regardless of input shape). Any write (even a failed one) clears
 * acknowledged checks for the file. Assumes a file_path and tool_name present.
 */
function trackReadWrite(
	session: SessionTrajectory,
	event: HarnessEvent,
	filePath: string,
	absPath: string,
): void {
	const toolName = event.tool_name;
	if (isReadOperation(toolName)) {
		session.files_read.add(filePath);
		if (absPath !== filePath) session.files_read.add(absPath);
		session.file_read_at.set(filePath, session.tool_call_count);
	}
	if (isWriteOperation(toolName)) {
		const writeSucceeded = event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
		if (writeSucceeded) {
			session.files_written.add(filePath);
			if (absPath !== filePath) session.files_written.add(absPath);
			session.file_write_times.set(filePath, event.timestamp);
			session.file_edit_counts.set(filePath, (session.file_edit_counts.get(filePath) || 0) + 1);
		}
		// Clear acknowledged checks for this file — a new edit (even a failed
		// one) may introduce genuinely different issues on the next attempt.
		clearAcknowledgedChecksForFile(session, filePath);
	}
}

/**
 * Sequence-detector input population (§3.5 / §3.18 / §3.21). Feeds
 * add_then_revert_loop and magic_literal_cross_file_proliferation; detectors
 * silently no-op when the maps are empty.
 *
 * Post-tool-use only, success-only. The §3.21 add-then-revert detector reasons
 * about *content states the file actually passed through*. A PreToolUse Edit
 * event is an INTENDED edit that may be blocked (tsc overlay, reservation
 * conflict, guard) and never land — recording it would count a state the file
 * never reached. It also double-counts: every successful edit fires both a
 * PreToolUse (outcome undefined) and a PostToolUse (outcome "success") event,
 * so recording on both inflated each file's history with a phantom duplicate.
 * The FP that motivated this gate: a blocked edit leaves the file unchanged,
 * the agent retries successfully, and the blocked attempt got counted as a
 * prior content state — firing "cycled back N times" on clean forward progress
 * with zero reverts. PostToolUse is the only point where the chunk reflects
 * content that genuinely reached disk.
 */
function recordSequenceInputs(
	session: SessionTrajectory,
	event: HarnessEvent,
	filePath: string,
): void {
	if (!isSequenceWriteOperation(event.tool_name) || !isPostToolUseEvent(event)) return;
	const seqWriteSucceeded =
		event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
	if (!seqWriteSucceeded) return;
	for (const chunk of extractWriteChunks(event)) {
		recordRecentLineEdit(session, filePath, chunk);
		recordLiteralOccurrences(session, filePath, chunk);
	}
}

/** Resolve pending completions when the agent reads/edits an affected file. */
function resolvePendingCompletions(session: SessionTrajectory, filePath: string): void {
	for (const [, completion] of session.pending_completions) {
		if (completion.affected_files.includes(filePath)) {
			completion.resolved_files.add(filePath);
		}
	}
}

/**
 * File-operation tracking for one event: read/write state, sequence-detector
 * inputs, and pending-completion resolution. No-op unless the event carries
 * both a file_path and a tool_name.
 */
function trackFileOperations(session: SessionTrajectory, event: HarnessEvent): void {
	const filePath = event.tool_input?.file_path as string | undefined;
	if (!filePath || !event.tool_name) return;
	const eventCwd = event.cwd ?? process.cwd();
	const absPath = resolvePath(eventCwd, filePath);
	trackReadWrite(session, event, filePath, absPath);
	recordSequenceInputs(session, event, filePath);
	resolvePendingCompletions(session, filePath);
}

/**
 * Command tracking for Bash-family tools: append to the bounded commands_run
 * ring and record the first matching verification-intent signal (typecheck /
 * test / lint / build / dev-server). We track *intent to verify* — a failed
 * `bun test` still counts because the agent did engage the verifier. No-op for
 * non-Bash tools or an absent command.
 */
function trackCommand(session: SessionTrajectory, event: HarnessEvent): void {
	const command = event.tool_input?.command as string | undefined;
	if (!command || !isBashTool(event.tool_name)) return;
	session.commands_run.push(command.length > 200 ? command.slice(0, 200) : command);
	if (session.commands_run.length > 100) {
		session.commands_run = session.commands_run.slice(-100);
	}

	const cmdKind = classifyVerificationCommand(command);
	if (cmdKind) {
		if (!session.verification_observed) session.verification_observed = new Set();
		session.verification_observed.add(cmdKind);
	}
}

/** Extract a short target identifier for tool sequence tracking (used in pattern detection) */
function extractToolTarget(event: HarnessEvent): string {
	const input = event.tool_input || {};
	if (input.file_path) return shortenPath(String(input.file_path));
	if (input.path) return shortenPath(String(input.path));
	if (input.command) {
		const cmd = String(input.command);
		// Extract the core command (first word + key args)
		const parts = cmd.split(/\s+/);
		const base = parts[0];
		if (base === "npx" && parts[1]) return `${base} ${parts[1]}`;
		if (base === "npm" && parts[1]) return `${base} ${parts[1]}`;
		if (base === "git" && parts[1]) return `${base} ${parts[1]}`;
		return base.slice(0, 30);
	}
	if (input.url) return String(input.url).slice(0, 40);
	return "";
}

/** Shorten a file path to just filename or last 2 segments */
function shortenPath(filePath: string): string {
	const parts = filePath.split("/").filter(Boolean);
	if (parts.length <= 2) return parts.join("/");
	return parts.slice(-2).join("/");
}

function isReadOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Read", "ReadFile", "read_file", "Glob", "Grep", "grep", "ListFiles"].includes(
		toolName,
	);
}

function isWriteOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"NotebookEdit",
	].includes(toolName);
}

function isBashTool(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Bash", "Shell", "shell", "run_command"].includes(toolName);
}

// ===========================================
// Session-Ack Suppression Helpers
// ===========================================

/**
 * Build the canonical key for the acknowledged_checks set.
 * Format: "${filePath}::${checkName}"
 */
function ackKey(filePath: string, checkName: string): string {
	return `${filePath}::${checkName}`;
}

/**
 * Record that a file+check warning was shown and the user allowed the agent
 * to continue. Subsequent PostToolUse events for the same pair will skip
 * the warning (unless the file is edited again).
 */
export function acknowledgeChecks(
	session: SessionTrajectory,
	filePath: string,
	checkNames: string[],
): void {
	for (const check of checkNames) {
		session.acknowledged_checks.add(ackKey(filePath, check));
	}
}

/**
 * Check whether a file+check pair has already been acknowledged this session.
 */
export function isAcknowledged(
	session: SessionTrajectory,
	filePath: string,
	checkName: string,
): boolean {
	return session.acknowledged_checks.has(ackKey(filePath, checkName));
}

/**
 * Clear all acknowledged checks for a specific file. Called when the file
 * is edited again — a new edit may introduce genuinely different issues.
 */
function clearAcknowledgedChecksForFile(
	session: SessionTrajectory,
	filePath: string,
): void {
	const prefix = `${filePath}::`;
	for (const key of session.acknowledged_checks) {
		if (key.startsWith(prefix)) {
			session.acknowledged_checks.delete(key);
		}
	}
}
