// ===========================================
// Session State — Per-session trajectory tracking
// ===========================================

import { resolve as resolvePath } from "node:path";

import type { JsonObject } from "../lib/json-types.js";
import type {
	ActiveSkillRecord,
	AssertionCounts,
	FailedFileEntry,
	HarnessEvent,
	PendingCompletion,
	SensitivityLevel,
	SessionTrajectory,
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
