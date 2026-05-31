// ===========================================
// Session State — Per-session trajectory tracking
// ===========================================

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

/** Timeout for the SessionStart git-baseline snapshot. Both `git rev-parse HEAD`
 *  and `git status --porcelain` should complete in milliseconds on a normal
 *  repo; the timeout is defensive against hung git (lock contention, NFS, etc.). */
const GIT_BASELINE_TIMEOUT_MS = 2000;

/** Capture the git working-tree state at session start: HEAD sha + porcelain-
 *  classified sets of modified/staged/untracked paths. Tolerates non-git dirs
 *  (returns empty baseline). Cached for the lifetime of the session — never
 *  re-snapshotted. Exported for direct testing. */
export function captureGitBaseline(cwd: string): {
	modified: Set<string>;
	staged: Set<string>;
	untracked: Set<string>;
	head_sha: string;
} {
	const empty = {
		modified: new Set<string>(),
		staged: new Set<string>(),
		untracked: new Set<string>(),
		head_sha: "",
	};
	let headSha = "";
	try {
		headSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_BASELINE_TIMEOUT_MS,
		}).trim();
	} catch {
		headSha = "";
	}

	let porcelain = "";
	try {
		porcelain = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_BASELINE_TIMEOUT_MS,
		});
	} catch {
		return empty;
	}

	const modified = new Set<string>();
	const staged = new Set<string>();
	const untracked = new Set<string>();
	const entries = porcelain.split("\0").filter((e) => e.length > 0);
	for (let i = 0; i < entries.length; i++) {
		const raw = entries[i];
		if (raw.length < 3) continue;
		const indexStatus = raw[0];
		const worktreeStatus = raw[1];
		const path = raw.slice(3);
		if (indexStatus === "R" || indexStatus === "C") {
			i++; // skip the old-path entry of a rename/copy
		}
		if (indexStatus === "?" && worktreeStatus === "?") {
			untracked.add(path);
			continue;
		}
		if (indexStatus === "!" && worktreeStatus === "!") continue;
		if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
			staged.add(path);
		}
		if (worktreeStatus !== " " && worktreeStatus !== "?" && worktreeStatus !== "!") {
			modified.add(path);
		}
	}
	return { modified, staged, untracked, head_sha: headSha };
}

import type { JsonObject } from "../lib/json-types.js";
import type {
	CapturedPlan,
	PlanSource,
	PlanStep,
	PlanStepStatus,
} from "./types/plan.js";
import type {
	ActiveSkillRecord,
	AssertionCounts,
	FailedFileEntry,
	HarnessEvent,
	PendingCompletion,
	SensitivityLevel,
	SessionTrajectory,
	TaintProvenance,
	TaintSource,
	TddCycle,
	WarningRecord,
} from "./types.js";
import {
	classifyBrowserToolName,
	classifyVerificationCommand,
	STUB_INTRODUCED_CAP,
} from "./verification-stop-checks.js";

/** Bumped when the serialized snapshot shape changes incompatibly. Hydrate
 *  refuses snapshots from a higher version (newer harness wrote it) and
 *  best-effort upgrades older shapes. */
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

const SENSITIVITY_LEVELS: ReadonlySet<SensitivityLevel> = new Set([
	"Public",
	"Internal",
	"Confidential",
	"HighlyConfidential",
]);

const DEFAULT_SKILL_TTL_MS = 30 * 60 * 1000;
const MAX_SKILL_TTL_MS = 4 * 60 * 60 * 1000;
const MIN_SKILL_TTL_MS = 60 * 1000;

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
		// Defensive: some event shapes arrive without a session_id (e.g., certain
		// SessionStart variants, malformed probes). Synthesize a fallback id
		// instead of crashing — a dropped session trajectory is better than a
		// dead harness that fails open on the next PreToolUse scan.
		const sessionId = event.session_id || `unknown-${Date.now().toString(36)}`;
		let session = this.sessions.get(sessionId);

		if (!session) {
			session = {
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
			this.sessions.set(event.session_id, session);
		}

		// Update agent name if resolved later (e.g., after register_agent)
		if (event.agent_name && session.agent_name.startsWith("session-")) {
			session.agent_name = event.agent_name;
		}

		// Track tool calls
		if (event.tool_name) {
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

			// Verification-before-stop: record browser-MCP interactions as
			// a UI verification signal. Bash-command verification signals are
			// captured below in the command-tracking block.
			const browserKind = classifyBrowserToolName(event.tool_name);
			if (browserKind) {
				if (!session.verification_observed) session.verification_observed = new Set();
				session.verification_observed.add(browserKind);
			}
		}

		// Track errors. Outcome-gated, not event-name-gated: Claude/Codex/
		// Gemini/Copilot fold tool failures into the regular Post* event
		// carrying tool_outcome === "error", and Cursor's dedicated
		// postToolUseFailure also produces tool_outcome === "error" via the
		// attachOutcome call in the normalizer. The previous event-name gates
		// were inverted for folded failures — error_count never bumped, and
		// consecutive_tool_failures was *cleared* by the very events that
		// should have incremented it. Phase 1 channels (recurrence, triage,
		// recovery) read these counters to make decisions.
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

		// Track file operations. Provenance gate (Channel 5 rollback feasibility)
		// requires that files_written contains only paths we actually wrote
		// successfully — gating on tool_outcome === "success" prevents a failed
		// Edit attempt from being attributed to us. Path normalization stores
		// BOTH the raw form (preserves existing `.has(rawPath)` consumers in
		// structural-checks / behavioral-checks / suggestion-scorer) AND the
		// resolved absolute form (lets the new Channel 5 provenance check do
		// `.has(resolve(cwd, p))` reliably regardless of input shape).
		const filePath = event.tool_input?.file_path as string | undefined;
		const eventCwd = event.cwd ?? process.cwd();
		if (filePath && event.tool_name) {
			const absPath = resolvePath(eventCwd, filePath);
			if (isReadOperation(event.tool_name)) {
				session.files_read.add(filePath);
				if (absPath !== filePath) session.files_read.add(absPath);
				session.file_read_at.set(filePath, session.tool_call_count);
			}
			if (isWriteOperation(event.tool_name)) {
				const writeSucceeded = event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
				if (writeSucceeded) {
					session.files_written.add(filePath);
					if (absPath !== filePath) session.files_written.add(absPath);
					session.file_write_times.set(filePath, event.timestamp);
					session.file_edit_counts.set(
						filePath,
						(session.file_edit_counts.get(filePath) || 0) + 1,
					);
				}
				// Clear acknowledged checks for this file — a new edit (even
				// a failed one) may introduce genuinely different issues on
				// the next attempt.
				clearAcknowledgedChecksForFile(session, filePath);
			}
			// Sequence-detector input population (§3.5 / §3.18 / §3.21).
			// Feeds add_then_revert_loop and magic_literal_cross_file_proliferation.
			// Lives next to the write-tracking block so the same outcome gate,
			// file_path resolution, and tool_name classifier already in scope
			// drive it; detectors silently no-op when the maps are empty.
			//
			// Post-tool-use only, success-only. The §3.21 add-then-revert
			// detector reasons about *content states the file actually passed
			// through*. A PreToolUse Edit event is an INTENDED edit that may be
			// blocked (tsc overlay, reservation conflict, guard) and never land
			// — recording it would count a state the file never reached. It
			// also double-counts: every successful edit fires both a PreToolUse
			// (outcome undefined) and a PostToolUse (outcome "success") event,
			// so recording on both inflated each file's history with a phantom
			// duplicate. The FP that motivated this gate: a blocked edit leaves
			// the file unchanged, the agent retries successfully, and the
			// blocked attempt got counted as a prior content state — firing
			// "cycled back N times" on clean forward progress with zero reverts.
			// PostToolUse is the only point where the chunk reflects content
			// that genuinely reached disk.
			if (isSequenceWriteOperation(event.tool_name) && isPostToolUseEvent(event)) {
				const seqWriteSucceeded =
					event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
				if (seqWriteSucceeded) {
					for (const chunk of extractWriteChunks(event)) {
						recordRecentLineEdit(session, filePath, chunk);
						recordLiteralOccurrences(session, filePath, chunk);
					}
				}
			}

			// Resolve pending completions when agent reads/edits affected files
			for (const [, completion] of session.pending_completions) {
				if (completion.affected_files.includes(filePath)) {
					completion.resolved_files.add(filePath);
				}
			}
		}

		// Track commands
		const command = event.tool_input?.command as string | undefined;
		if (command && isBashTool(event.tool_name)) {
			session.commands_run.push(command.length > 200 ? command.slice(0, 200) : command);
			if (session.commands_run.length > 100) {
				session.commands_run = session.commands_run.slice(-100);
			}

			// Verification-before-stop: classify the command for verification
			// signals (typecheck / test / lint / build / dev-server) and record
			// the first matching kind. We track *intent to verify* — a failed
			// `bun test` still counts because the agent did engage the verifier.
			const cmdKind = classifyVerificationCommand(command);
			if (cmdKind) {
				if (!session.verification_observed) session.verification_observed = new Set();
				session.verification_observed.add(cmdKind);
			}
		}

		gcExpiredSkills(session);

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

		if (from.verification_observed && from.verification_observed.size > 0) {
			if (!to.verification_observed) to.verification_observed = new Set();
			for (const sig of from.verification_observed) to.verification_observed.add(sig);
		}

		// Gap-fill only: a run/cycle the parent already tracks for a file is
		// newer than the subagent's, so never overwrite it.
		for (const [file, run] of from.test_runs) {
			if (!to.test_runs.has(file)) to.test_runs.set(file, { ...run });
		}
		for (const [file, cycle] of from.tdd_cycles) {
			if (!to.tdd_cycles.has(file)) to.tdd_cycles.set(file, { ...cycle });
		}

		if (from.stubs_introduced && from.stubs_introduced.length > 0) {
			if (!to.stubs_introduced) to.stubs_introduced = [];
			for (const stub of from.stubs_introduced) {
				if (to.stubs_introduced.length >= STUB_INTRODUCED_CAP) break;
				to.stubs_introduced.push({ ...stub });
			}
		}
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
// Sequence-detector input population
// ===========================================
// Populates `session.recent_line_edits`, `session.literal_occurrences` from
// successful Write / Edit / MultiEdit events so the §3.21 add-then-revert
// and §3.18 magic-literal-cross-file detectors have non-empty input.
// Best-effort: bounded ring buffer + per-edit literal cap so a runaway
// agent can't blow the trajectory's memory footprint. The detectors read
// these maps directly; recent_user_urls is populated separately from
// `lifecycle-events.ts::handleUserPromptSubmit`.

/** Per-file ring buffer ceiling for `recent_line_edits`. The §3.21
 *  detector only needs enough history to detect non-consecutive re-appearance
 *  of a content hash; 20 entries comfortably covers a thrashing loop. */
const RECENT_LINE_EDITS_PER_FILE_CAP = 20;

/** Max distinct literals extracted from a single edit. Bounds the work the
 *  literal scanner does per-event so a one-shot blob-write can't pin the
 *  CPU or memory-balloon the session trajectory. */
const LITERAL_OCCURRENCES_PER_EDIT_CAP = 50;

/** Lower-edge of the boring-number range. -1, 0, 1, 2, ... 256 — the
 *  range every codebase uses for status flags / array sizes / bit shifts;
 *  excluding them keeps the cross-file detector targeting *meaningful*
 *  literals. Matches the spec literal range. */
const TRIVIAL_NUMBER_LO = -1;
const TRIVIAL_NUMBER_HI = 256;

/** HTTP status-code window. 100..599 are response codes spread across
 *  effectively every web codebase; treating them as magic constants
 *  would drown the detector. */
const HTTP_STATUS_LO = 100;
const HTTP_STATUS_HI = 599;

/** True for post-tool-use events across the supported runners (Claude Code
 *  "PostToolUse"/"PostToolUseFailure", Gemini CLI "AfterTool"). The §3.21
 *  add-then-revert population gate uses this to skip PreToolUse Edit events,
 *  which represent INTENDED edits that may be blocked and never land on disk.
 *  Mirrors `isPostToolUse` in server-tool-helpers.ts; kept local so
 *  session-state has no dependency on the server module. */
function isPostToolUseEvent(event: HarnessEvent): boolean {
	return (
		event.hook_event === "PostToolUse" ||
		event.hook_event === "AfterTool" ||
		event.hook_event === "PostToolUseFailure"
	);
}

/** Tools whose successful invocation produces a content chunk we feed to
 *  the §3.21 / §3.18 sequence detectors. Superset of `isWriteOperation`
 *  because that one excludes MultiEdit (no `file_path`/`content` pair on
 *  the top-level input) but the sequence-input scanner *does* unpack the
 *  per-edit `new_string`. Read-only — every other tool short-circuits. */
function isSequenceWriteOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"MultiEdit",
		"NotebookEdit",
	].includes(toolName);
}

/** Shape of a single MultiEdit edit entry's `new_string` slot. */
interface MultiEditEntry {
	new_string?: unknown;
}

/** Extract every content chunk this event introduced. Write → one chunk
 *  from `tool_input.content`; Edit → `tool_input.new_string`; MultiEdit →
 *  one chunk per `tool_input.edits[i].new_string`. Returns [] when none of
 *  the recognized fields is present, so the call site can iterate without
 *  guard logic. */
function extractWriteChunks(event: HarnessEvent): string[] {
	const input = event.tool_input ?? {};
	const chunks: string[] = [];
	const content = input.content;
	if (typeof content === "string") chunks.push(content);
	const newString = input.new_string;
	if (typeof newString === "string") chunks.push(newString);
	const edits = input.edits;
	if (Array.isArray(edits)) {
		for (const e of edits) {
			if (e && typeof e === "object") {
				const ns = (e as MultiEditEntry).new_string;
				if (typeof ns === "string") chunks.push(ns);
			}
		}
	}
	return chunks;
}

/** Push one ring-buffer entry for the file. content_hash is sha256 over the
 *  raw chunk; `range.end` is the chunk's line-count (the spec's
 *  simplification: Write/Edit don't expose precise line ranges, so we treat
 *  each edit as touching its full new content). Drops the oldest entry on
 *  overflow so the buffer stays bounded.
 *
 *  No-op suppression: if the new chunk hashes identically to the file's
 *  immediately-preceding recorded chunk, the edit re-applied content the file
 *  already held — not a state transition. Skipping it keeps the §3.21
 *  add-then-revert detector's history a sequence of *distinct* states, so the
 *  detector counts only genuine A→B→A oscillation rather than consecutive
 *  re-applies of the same content (idempotent writes, no-op edits). An
 *  A→B→A pattern is unaffected: the trailing A differs from the preceding B. */
function recordRecentLineEdit(
	session: SessionTrajectory,
	filePath: string,
	chunk: string,
): void {
	if (!session.recent_line_edits) session.recent_line_edits = new Map();
	const lines = chunk.split("\n").length;
	const contentHash = createHash("sha256").update(chunk).digest("hex");
	const existing = session.recent_line_edits.get(filePath);
	if (existing) {
		// Drop a re-apply of the exact same content as the last recorded edit.
		const last = existing[existing.length - 1];
		if (last && last.content_hash === contentHash) return;
		existing.push({ range: { start: 0, end: lines }, content_hash: contentHash, at_step: session.tool_call_count });
		while (existing.length > RECENT_LINE_EDITS_PER_FILE_CAP) {
			existing.shift();
		}
	} else {
		session.recent_line_edits.set(filePath, [
			{ range: { start: 0, end: lines }, content_hash: contentHash, at_step: session.tool_call_count },
		]);
	}
}

/** Scan the chunk for non-trivial literals and add this file's path to
 *  each literal's occurrence set. Per-event count is capped to keep a
 *  large generated blob from creating thousands of map entries. */
function recordLiteralOccurrences(
	session: SessionTrajectory,
	filePath: string,
	chunk: string,
): void {
	if (!session.literal_occurrences) session.literal_occurrences = new Map();
	let count = 0;
	for (const literal of extractNonTrivialLiterals(chunk)) {
		if (count >= LITERAL_OCCURRENCES_PER_EDIT_CAP) break;
		const hash = createHash("sha256").update(literal).digest("hex");
		const existing = session.literal_occurrences.get(hash);
		if (existing) {
			existing.add(filePath);
		} else {
			session.literal_occurrences.set(hash, new Set([filePath]));
		}
		count++;
	}
}

/** Yield every literal worth tracking. String literals ≥8 chars (skips
 *  short tokens like punctuation strings) and integer literals outside
 *  the boring -1..256 range AND outside the HTTP status 100..599 window.
 *  Pure, dependency-free — exported only for the dedicated unit tests
 *  that pin the rule set. */
export function extractNonTrivialLiterals(chunk: string): string[] {
	const out: string[] = [];
	// String literals: capture the delimiter, then anything that isn't a
	// matching delimiter or newline. 8..200 char body bounds.
	const stringRe = /(["'`])((?:(?!\1)[^\n]){8,200})\1/g;
	let m: RegExpExecArray | null;
	m = stringRe.exec(chunk);
	while (m !== null) {
		const body = m[2];
		if (body !== undefined) out.push(body);
		m = stringRe.exec(chunk);
	}
	// Integer literals (3+ digits) outside the boring and HTTP-status ranges.
	const numberRe = /\b(\d{3,})\b/g;
	let n: RegExpExecArray | null;
	n = numberRe.exec(chunk);
	while (n !== null) {
		const raw = n[1];
		if (raw !== undefined) {
			const value = Number.parseInt(raw, 10);
			const trivial = value >= TRIVIAL_NUMBER_LO && value <= TRIVIAL_NUMBER_HI;
			const httpStatus = value >= HTTP_STATUS_LO && value <= HTTP_STATUS_HI;
			if (!trivial && !httpStatus) out.push(raw);
		}
		n = numberRe.exec(chunk);
	}
	return out;
}

// ===========================================
// Snapshot hydration helpers
// ===========================================
// Defensive coercion for fields read off `<id>.live.json`. We never trust
// the on-disk shape: a file from an older harness version, a half-written
// snapshot, or a hand-edited file should never crash the daemon — it should
// resolve to the same default `recordEvent` would use for a fresh session.

function readString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readBoolean(v: unknown): boolean {
	return v === true;
}

function readStringSet(v: unknown): Set<string> {
	if (!Array.isArray(v)) return new Set();
	const out = new Set<string>();
	for (const item of v) {
		if (typeof item === "string") out.add(item);
	}
	return out;
}

function readStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

function readNumberArray(v: unknown): number[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

function readStubsIntroduced(
	v: unknown,
): Array<{ file: string; kind: string; snippet: string }> {
	if (!Array.isArray(v)) return [];
	const out: Array<{ file: string; kind: string; snippet: string }> = [];
	for (const e of v) {
		if (!e || typeof e !== "object") continue;
		const r = e as Record<string, unknown>;
		if (typeof r.file !== "string" || typeof r.kind !== "string" || typeof r.snippet !== "string") {
			continue;
		}
		out.push({ file: r.file, kind: r.kind, snippet: r.snippet });
	}
	return out;
}

function readStringMap(v: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!isPlainObject(v)) return out;
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === "string") out.set(k, val);
	}
	return out;
}

function readNumberMap(v: unknown): Map<string, number> {
	const out = new Map<string, number>();
	if (!isPlainObject(v)) return out;
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === "number" && Number.isFinite(val)) out.set(k, val);
	}
	return out;
}

function readNumberRecord(v: unknown): Record<number, number> {
	const out: Record<number, number> = {};
	if (!isPlainObject(v)) return out;
	for (const [k, val] of Object.entries(v)) {
		const port = Number.parseInt(k, 10);
		if (Number.isFinite(port) && typeof val === "number" && Number.isFinite(val)) {
			out[port] = val;
		}
	}
	return out;
}

function readSensitivity(v: unknown): SensitivityLevel {
	if (typeof v === "string" && SENSITIVITY_LEVELS.has(v as SensitivityLevel)) {
		return v as SensitivityLevel;
	}
	return "Public";
}

function readConsecutivePattern(v: unknown): { pattern: string; count: number } | null {
	if (!isPlainObject(v)) return null;
	const pattern = readString(v.pattern);
	const count = readNumber(v.count, 0);
	return pattern ? { pattern, count } : null;
}

const TAINT_PROVENANCE_VALUES: ReadonlySet<TaintProvenance> = new Set<TaintProvenance>([
	"fetched_external",
	"mcp_remote",
	"document_content",
	"user_provided",
	"local_read",
]);

/** Coerce an unknown to a TaintProvenance, defaulting to "local_read" for
 *  older snapshots (pre-provenance field) and any malformed value. */
function readProvenance(v: unknown): TaintProvenance {
	if (typeof v === "string" && TAINT_PROVENANCE_VALUES.has(v as TaintProvenance)) {
		return v as TaintProvenance;
	}
	return "local_read";
}

function readTaintSources(v: unknown): TaintSource[] {
	if (!Array.isArray(v)) return [];
	const out: TaintSource[] = [];
	for (const item of v) {
		if (!isPlainObject(item)) continue;
		const file = readString(item.file);
		if (!file) continue;
		out.push({
			file,
			level: readSensitivity(item.level),
			at_step: readNumber(item.at_step, 0),
			provenance: readProvenance(item.provenance),
		});
	}
	return out;
}

function readFailedFiles(v: unknown): Map<string, FailedFileEntry> {
	const out = new Map<string, FailedFileEntry>();
	if (!isPlainObject(v)) return out;
	for (const [file, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		out.set(file, {
			failure_count: readNumber(raw.failure_count, 0),
			checks: readStringArray(raw.checks),
			recorded_at: readString(raw.recorded_at) ?? new Date().toISOString(),
			tool_call_count: readNumber(raw.tool_call_count, 0),
		});
	}
	return out;
}

function readPendingCompletions(v: unknown): Map<string, PendingCompletion> {
	const out = new Map<string, PendingCompletion>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const sourceFile = readString(raw.source_file);
		if (!sourceFile) continue;
		out.set(key, {
			source_file: sourceFile,
			affected_files: readStringArray(raw.affected_files),
			resolved_files: readStringSet(raw.resolved_files),
			recorded_at_tool_call: readNumber(raw.recorded_at_tool_call, 0),
			description: readString(raw.description) ?? "",
		});
	}
	return out;
}

function readWarnings(v: unknown): Map<string, WarningRecord> {
	const out = new Map<string, WarningRecord>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const checkName = readString(raw.check_name);
		if (!checkName) continue;
		out.set(key, {
			check_name: checkName,
			issue_count: readNumber(raw.issue_count, 0),
			first_issued_at: readNumber(raw.first_issued_at, 0),
			last_issued_at: readNumber(raw.last_issued_at, 0),
			resolved: readBoolean(raw.resolved),
		});
	}
	return out;
}

const TDD_STATES = new Set(["no_test", "red", "green", "regression"]);

function readTddCycles(v: unknown): Map<string, TddCycle> {
	const out = new Map<string, TddCycle>();
	if (!isPlainObject(v)) return out;
	for (const [key, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const sourceFile = readString(raw.source_file);
		if (!sourceFile) continue;
		const stateStr = typeof raw.state === "string" ? raw.state : "no_test";
		const state = (TDD_STATES.has(stateStr) ? stateStr : "no_test") as TddCycle["state"];
		const prevStr = typeof raw.previous_state === "string" ? raw.previous_state : undefined;
		const previous_state =
			prevStr && TDD_STATES.has(prevStr) ? (prevStr as TddCycle["state"]) : undefined;
		out.set(key, {
			source_file: sourceFile,
			test_file: typeof raw.test_file === "string" ? raw.test_file : null,
			state,
			test_written_at: typeof raw.test_written_at === "number" ? raw.test_written_at : undefined,
			red_at: typeof raw.red_at === "number" ? raw.red_at : undefined,
			green_at: typeof raw.green_at === "number" ? raw.green_at : undefined,
			impl_edits_before_test: readNumber(raw.impl_edits_before_test, 0),
			previous_state,
		});
	}
	return out;
}

function readTestRuns(
	v: unknown,
): Map<string, { status: "pass" | "fail"; at_step: number }> {
	const out = new Map<string, { status: "pass" | "fail"; at_step: number }>();
	if (!isPlainObject(v)) return out;
	for (const [file, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		const status = raw.status === "pass" || raw.status === "fail" ? raw.status : null;
		if (!status) continue;
		out.set(file, { status, at_step: readNumber(raw.at_step, 0) });
	}
	return out;
}

function readAssertionCountsMap(v: unknown): Map<string, AssertionCounts> {
	const out = new Map<string, AssertionCounts>();
	if (!isPlainObject(v)) return out;
	for (const [file, raw] of Object.entries(v)) {
		if (!isPlainObject(raw)) continue;
		out.set(file, {
			blocks: readNumber(raw.blocks, 0),
			assertions: readNumber(raw.assertions, 0),
		});
	}
	return out;
}

function readGitSessionBaseline(v: unknown):
	| {
			modified: Set<string>;
			staged: Set<string>;
			untracked: Set<string>;
			head_sha: string;
		}
	| undefined {
	if (!isPlainObject(v)) return undefined;
	return {
		head_sha: readString(v.head_sha) ?? "",
		modified: readStringSet(v.modified),
		staged: readStringSet(v.staged),
		untracked: readStringSet(v.untracked),
	};
}

function readActiveSkills(v: unknown): Map<string, ActiveSkillRecord> | undefined {
	if (!isPlainObject(v)) return undefined;
	const entries = Object.entries(v);
	if (entries.length === 0) return undefined;
	const out = new Map<string, ActiveSkillRecord>();
	for (const [name, raw] of entries) {
		if (!isPlainObject(raw)) continue;
		const recordName = readString(raw.name) ?? name;
		const source = raw.source === "cli" || raw.source === "hook" || raw.source === "manual"
			? raw.source
			: "cli";
		out.set(name, {
			name: recordName,
			entered_at: readNumber(raw.entered_at, 0),
			expires_at: readNumber(raw.expires_at, 0),
			source,
		});
	}
	return out;
}

function isPlainObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
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
	session: import("./types.js").SessionTrajectory,
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
	session: import("./types.js").SessionTrajectory,
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
	session: import("./types.js").SessionTrajectory,
	filePath: string,
): void {
	const prefix = `${filePath}::`;
	for (const key of session.acknowledged_checks) {
		if (key.startsWith(prefix)) {
			session.acknowledged_checks.delete(key);
		}
	}
}

// ===========================================
// Active-Skill Markers
// ===========================================
// Per-session markers populated by `interlinked skill enter <name>` and
// agent-native skill-lifecycle hooks. Read by the active_when predicate
// evaluator to scope distilled rules. See harness-active-when-scoping.md.

export interface SkillEnterArgs {
	name: string;
	/** Override default TTL (30 min). Clamped to [60s, 4h]. */
	ttl_seconds?: number;
	/** "cli" = explicit `interlinked skill enter`; "hook" = agent-native event; "manual" = enable-side toggle. */
	source?: ActiveSkillRecord["source"];
}

/** Record that a skill is now active for this session. Replaces any existing
 *  marker for the same name (re-entering refreshes the TTL). */
export function recordSkillEnter(
	session: SessionTrajectory,
	args: SkillEnterArgs,
): ActiveSkillRecord {
	if (!session.active_skills) session.active_skills = new Map();
	const requestedSec = args.ttl_seconds ?? DEFAULT_SKILL_TTL_MS / 1000;
	const ttlMs = Math.min(MAX_SKILL_TTL_MS, Math.max(MIN_SKILL_TTL_MS, requestedSec * 1000));
	const now = Date.now();
	const record: ActiveSkillRecord = {
		name: args.name,
		entered_at: now,
		expires_at: now + ttlMs,
		source: args.source ?? "cli",
	};
	session.active_skills.set(args.name, record);
	return record;
}

/** Remove a skill marker. Returns true if a marker existed. */
export function recordSkillLeave(session: SessionTrajectory, name: string): boolean {
	if (!session.active_skills) return false;
	return session.active_skills.delete(name);
}

/** Drop expired markers in-place. Called on every event so stale markers
 *  don't leak past their TTL even if no `skill_leave` arrived. */
export function gcExpiredSkills(session: SessionTrajectory): number {
	if (!session.active_skills || session.active_skills.size === 0) return 0;
	const now = Date.now();
	let removed = 0;
	for (const [name, record] of session.active_skills) {
		if (record.expires_at <= now) {
			session.active_skills.delete(name);
			removed++;
		}
	}
	return removed;
}

/** Snapshot of currently-active skills (post-GC) for read-only consumers. */
export function getActiveSkills(session: SessionTrajectory): ActiveSkillRecord[] {
	gcExpiredSkills(session);
	if (!session.active_skills) return [];
	return [...session.active_skills.values()];
}

// ===========================================
// Declared-plan serialize / hydrate
// ===========================================
// `session.declared_plan` is the latest `CapturedPlan` produced by
// plan-capture.ts. Round-trip support so a daemon restart doesn't drop
// the most-recent plan — item #6 (plan-drift) reads this field at Stop.

const PLAN_SOURCES: ReadonlySet<PlanSource> = new Set([
	"TaskCreate",
	"ExitPlanMode",
	"structured_userprompt",
]);

const PLAN_STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set([
	"pending",
	"executed",
	"skipped",
]);

/** Convert a CapturedPlan to a JSON-safe object. The plan shape is
 *  already plain JSON (no Maps, Sets, dates), so this is a deep copy
 *  that documents the shape in one place. */
function serializeCapturedPlan(plan: CapturedPlan): JsonObject {
	return {
		session_id: plan.session_id,
		agent_name: plan.agent_name,
		created_at_iso: plan.created_at_iso,
		created_at_step: plan.created_at_step,
		source: plan.source,
		steps: plan.steps.map((s) => ({
			intent: s.intent,
			tool_hint: s.tool_hint ?? null,
			target_hint: s.target_hint ?? null,
			status: s.status,
		})),
	};
}

/** Defensive read of the serialized plan. Returns undefined for null,
 *  missing, or malformed shapes so older snapshots (predating this
 *  field) hydrate cleanly. Unknown step statuses default to "pending";
 *  unknown sources default to "TaskCreate" so we never crash. */
function readCapturedPlan(v: unknown): CapturedPlan | undefined {
	if (!isPlainObject(v)) return undefined;
	const sessionId = readString(v.session_id);
	const agentName = readString(v.agent_name);
	const createdAtIso = readString(v.created_at_iso);
	if (!sessionId || !agentName || !createdAtIso) return undefined;
	const sourceRaw = typeof v.source === "string" ? v.source : "";
	const source = PLAN_SOURCES.has(sourceRaw as PlanSource)
		? (sourceRaw as PlanSource)
		: "TaskCreate";
	const stepsRaw = Array.isArray(v.steps) ? v.steps : [];
	const steps: PlanStep[] = [];
	for (const raw of stepsRaw) {
		if (!isPlainObject(raw)) continue;
		const intent = readString(raw.intent);
		if (!intent) continue;
		const statusRaw = typeof raw.status === "string" ? raw.status : "pending";
		const status = PLAN_STEP_STATUSES.has(statusRaw as PlanStepStatus)
			? (statusRaw as PlanStepStatus)
			: "pending";
		const step: PlanStep = { intent, status };
		const toolHint = readString(raw.tool_hint);
		if (toolHint) step.tool_hint = toolHint;
		const targetHint = readString(raw.target_hint);
		if (targetHint) step.target_hint = targetHint;
		steps.push(step);
	}
	return {
		session_id: sessionId,
		agent_name: agentName,
		created_at_iso: createdAtIso,
		created_at_step: readNumber(v.created_at_step, 0),
		source,
		steps,
	};
}
