// ===========================================
// Legacy activity.jsonl mirror (daemon dual-write)
// ===========================================
// Maps a `HarnessEvent` (the daemon's normalized wire event) to the legacy v5
// `LocalActivityEvent` and appends it to activity.jsonl. The canonical stream
// is collection.jsonl (server/collection-writer.ts); this mirror keeps the CLI
// reader commands (status / activity / logs / sync) working, which still read
// activity.jsonl. Mirrors the dual-write the old self-contained .mjs hook did
// before the thin hook-entry.js + daemon path took over.
//
// Best-effort and tool-events-only (parity with the collection writer): a
// failure here never breaks the pipeline, and non-tool lifecycle events map to
// null (they are recorded by other daemon branches).

import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../lib/config.js";
import type { JsonObject } from "../../lib/json-types.js";
import { appendActivityRecordOnly, type LocalActivityEvent } from "../../lib/local-activity.js";
import { extractNewThinking, latestTranscriptModel, resolveTranscriptPath } from "../thinking-capture.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

/** Partition the hook event into a v5 activity `type`, or null for non-tool
 *  events. Same partition the collection writer uses for `event_type`. */
function activityType(hookEvent: string): string | null {
	if (hookEvent === "PreToolUse" || hookEvent === "BeforeTool") return "tool_use_start";
	if (hookEvent === "PostToolUseFailure") return "tool_use_error";
	if (hookEvent === "PostToolUse" || hookEvent === "AfterTool") return "tool_use";
	return null;
}

/** A short human label for the activity feed: the command for shell tools, the
 *  path for file tools, the pattern for search tools, else the tool name. */
function summarize(toolName: string | undefined, input: JsonObject | undefined): string | null {
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	const command = input ? str(input.command) : null;
	if (command) return command.slice(0, 200);
	const path = input ? (str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)) : null;
	if (path) return path;
	const pattern = input ? (str(input.pattern) ?? str(input.query)) : null;
	if (pattern) return pattern.slice(0, 200);
	return toolName ?? null;
}

// Workspace/project keys come from config; cache per-cwd so the hot path does no
// repeat config I/O. `resolveConfig` returns defaults for a missing config and
// does not throw, so no guard is needed here.
const keyCache = new Map<string, { workspace: string; project: string }>();
function projectKeys(cwd: string): { workspace: string; project: string } {
	const cached = keyCache.get(cwd);
	if (cached) return cached;
	const cfg = resolveConfig(cwd);
	const keys = {
		workspace: cfg.default_workspace_key ?? cfg.workspace_id ?? "main",
		project: cfg.default_project ?? "main",
	};
	keyCache.set(cwd, keys);
	return keys;
}

/** Map a tool `HarnessEvent` to a v5 `LocalActivityEvent`, or null for non-tool
 *  events. Pure (modulo the cached config lookup). */
export function mapEventToActivityRecord(
	event: HarnessEvent,
	fallbackCwd: string,
): LocalActivityEvent | null {
	const type = activityType(event.hook_event);
	if (!type) return null;
	const cwd = event.cwd ?? fallbackCwd;
	const keys = projectKeys(cwd);
	const rec: LocalActivityEvent = {
		schema_version: 5,
		ts: event.timestamp,
		agent: event.agent_name ?? event.agent_source ?? "unknown",
		workspace_key: keys.workspace,
		project_key: keys.project,
		type,
		tool: event.tool_name ?? null,
		summary: summarize(event.tool_name, event.tool_input),
		session: event.session_id,
		hook: event.hook_event,
		tool_input: event.tool_input ?? {},
		cwd,
	};
	if (event.tool_use_id) rec.tool_use_id = event.tool_use_id;
	return rec;
}

/** Append the legacy activity.jsonl mirror for a tool event. Best-effort: any
 *  failure is swallowed so the daemon pipeline never breaks on the mirror. */
export function writeActivityRecord(event: HarnessEvent, fallbackCwd: string): void {
	try {
		const rec = mapEventToActivityRecord(event, fallbackCwd);
		if (!rec) return;
		// Live thinking capture: on a tool_use_start, attach the reasoning that
		// preceded this tool call. The thin hook-entry path never replicated the
		// old .mjs's extractNewThinking — this restores it daemon-side (the June-1
		// regression). Scrubbed inside extractNewThinking; best-effort.
		if (rec.type === "tool_use_start") {
			const cwd = event.cwd ?? fallbackCwd;
			const tp = resolveTranscriptPath(event.transcript_path, event.session_id, cwd, homedir());
			if (tp) {
				const thinking = extractNewThinking(tp, join(cwd, ".interlinked", "thinking-cursor.json"));
				if (thinking) rec.thinking = thinking;
				const model = latestTranscriptModel(tp);
				if (model) rec.model = model;
			}
		}
		appendActivityRecordOnly(rec, event.cwd ?? fallbackCwd);
	} catch {
		// Best-effort legacy mirror — a failed activity.jsonl write must never
		// break the daemon pipeline; collection.jsonl is the canonical record.
		return;
	}
}

/** Map a guard DECISION (not the event) to a v5 guard_* activity record.
 *  block/ask becomes guard_block; an allow carrying warnings becomes guard_warn.
 *  A bare allow with no warnings returns null and is NOT recorded: it is
 *  derivable from a tool_use_start having no paired guard_block, and recording
 *  one per call would double the log 1:1 with tool_use_start. Pure (modulo the
 *  cached config lookup) -- mirrors mapEventToActivityRecord. */
export function mapDecisionToGuardRecord(
	event: HarnessEvent,
	decision: HarnessDecision,
	fallbackCwd: string,
): LocalActivityEvent | null {
	const isBlock = decision.decision === "block" || decision.decision === "ask";
	const hasWarnings = (decision.warnings?.length ?? 0) > 0;
	if (!isBlock && !hasWarnings) return null;
	const cwd = event.cwd ?? fallbackCwd;
	const keys = projectKeys(cwd);
	const rec: LocalActivityEvent = {
		schema_version: 5,
		ts: event.timestamp,
		agent: event.agent_name ?? event.agent_source ?? "unknown",
		workspace_key: keys.workspace,
		project_key: keys.project,
		type: isBlock ? "guard_block" : "guard_warn",
		tool: event.tool_name ?? null,
		summary: (decision.reason ?? decision.warnings?.join("; ") ?? "guard").slice(0, 500),
		session: event.session_id,
		hook: event.hook_event,
		cwd,
		guard_decision: decision.decision,
		guard_rule_id: decision.rule_id ?? null,
		guard_severity: decision.severity ?? null,
		guard_category: decision.category ?? null,
		guard_reason: decision.reason ?? null,
		guard_warnings: decision.warnings ?? null,
	};
	if (event.tool_use_id) rec.tool_use_id = event.tool_use_id;
	if (typeof decision.checks_timing_ms === "number") rec.guard_harness_ms = decision.checks_timing_ms;
	return rec;
}

/** Append the legacy activity.jsonl guard_* record for a guard decision.
 *  Best-effort: any failure is swallowed so the daemon pipeline never breaks.
 *  collection.jsonl deliberately drops guard_* (lib/collection/builder.ts), so
 *  activity.jsonl is the ONLY local sink -- this restores the 2026-06-01 writer
 *  regression where the .mjs to daemon port dropped appendGuardDecision and
 *  guard decisions stopped being recorded even though blocking kept working. */
export function writeGuardDecisionRecord(
	event: HarnessEvent,
	decision: HarnessDecision,
	fallbackCwd: string,
): void {
	try {
		const rec = mapDecisionToGuardRecord(event, decision, fallbackCwd);
		if (!rec) return;
		appendActivityRecordOnly(rec, event.cwd ?? fallbackCwd);
	} catch {
		// Best-effort -- a failed guard-telemetry write must never break the
		// daemon pipeline (feedback_safety_continuity).
		return;
	}
}
