// ===========================================
// Session State — Per-session trajectory tracking
// ===========================================

import type { JsonObject } from "../lib/json-types.js";
import type { ActiveSkillRecord, HarnessEvent, SessionTrajectory } from "./types.js";

const DEFAULT_SKILL_TTL_MS = 30 * 60 * 1000;
const MAX_SKILL_TTL_MS = 4 * 60 * 60 * 1000;
const MIN_SKILL_TTL_MS = 60 * 1000;

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
		}

		// Track errors
		if (event.hook_event === "PostToolUseFailure") {
			session.error_count++;
			if (event.tool_name) {
				const prev = session.consecutive_tool_failures.get(event.tool_name) || 0;
				session.consecutive_tool_failures.set(event.tool_name, prev + 1);
			}
		} else if (event.hook_event === "PostToolUse" && event.tool_name) {
			// Any success for this tool resets the consecutive counter.
			session.consecutive_tool_failures.delete(event.tool_name);
		}

		// Track file operations
		const filePath = event.tool_input?.file_path as string | undefined;
		if (filePath && event.tool_name) {
			if (isReadOperation(event.tool_name)) {
				session.files_read.add(filePath);
				session.file_read_at.set(filePath, session.tool_call_count);
			}
			if (isWriteOperation(event.tool_name)) {
				session.files_written.add(filePath);
				session.file_write_times.set(filePath, event.timestamp);
				session.file_edit_counts.set(
					filePath,
					(session.file_edit_counts.get(filePath) || 0) + 1,
				);
				// Clear acknowledged checks for this file — a new edit may
				// introduce genuinely different issues.
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
		}

		gcExpiredSkills(session);

		return session;
	}

	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** Serialize a session trajectory to a plain JSON-safe object */
	serialize(sessionId: string): JsonObject | null {
		const s = this.sessions.get(sessionId);
		if (!s) return null;
		const endedAt = new Date().toISOString();
		return {
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
			files_read: [...s.files_read],
			files_written: [...s.files_written],
			commands_run: s.commands_run,
			tool_sequence: s.tool_sequence,
			curl_localhost_count: s.curl_localhost_count,
			taint_sources: s.taint_sources,
			suggested_permissions: [...s.suggested_permissions],
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
			acknowledged_checks: [...s.acknowledged_checks],
			file_edit_counts: Object.fromEntries(s.file_edit_counts),
			warnings_issued: Object.fromEntries(
				[...s.warnings_issued.entries()].map(([k, v]) => [k, { ...v }]),
			),
			tdd_cycles: Object.fromEntries(
				[...s.tdd_cycles.entries()].map(([k, v]) => [k, { ...v }]),
			),
		};
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
