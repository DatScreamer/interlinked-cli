// interlinked-tdd: exempt
// ===========================================
// Local Activity — collection-stream reader + low-level JSONL helpers
// ===========================================
// Extracted from local-activity.ts to keep that module under the per-file
// line cap. Pure leaf cluster: depends only on node:fs/path, collection
// types/path, and the LocalActivityEvent type — never imports back from main.

import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import type { AgentEventRecord, CollectionAction, CollectionRecord } from "./collection/types.js";
import { getCollectionPath } from "./collection/writer.js";
import type { LocalActivityEvent } from "./local-activity-types.js";
import { nonNull } from "./non-null.js";

/** Best human label for a collection action: command / path / pattern / url. */
function summarizeAction(action: CollectionAction | null): string | null {
	if (!action) return null;
	const a = action as {
		command?: unknown;
		path?: unknown;
		pattern?: unknown;
		url?: unknown;
		task?: unknown;
		tool?: unknown;
	};
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	return (
		str(a.command) ??
		str(a.path) ??
		str(a.pattern) ??
		str(a.url) ??
		str(a.task) ??
		str(a.tool) ??
		null
	);
}

/** Display-summary cap for an agent's final message in the activity view.
 *  The FULL message stays on the collection record; this only bounds the
 *  one-line `summary` column. */
const AGENT_SUMMARY_MAX_CHARS = 200;

/** Hook-event label for each agent_event, for the display `hook` column. */
const AGENT_EVENT_HOOKS: Record<AgentEventRecord["event"], string> = {
	subagent_start: "SubagentStart",
	subagent_stop: "SubagentStop",
	task_completed: "TaskCompleted",
};

/** Project one collection.v1 agent_event record to a v5 LocalActivityEvent —
 *  the projection that makes subagent results visible to `interlinked
 *  activity` / `logs` (type filters: subagent_start / subagent_stop /
 *  task_completed). */
function agentEventToActivity(rec: AgentEventRecord): LocalActivityEvent {
	const fullSummary = rec.last_assistant_message ?? rec.task?.task_subject ?? null;
	const summary =
		fullSummary && fullSummary.length > AGENT_SUMMARY_MAX_CHARS
			? fullSummary.slice(0, AGENT_SUMMARY_MAX_CHARS)
			: fullSummary;
	const ev: LocalActivityEvent = {
		schema_version: 5,
		ts: rec.ts,
		agent: rec.agent_name ?? rec.provider ?? "unknown",
		type: rec.event,
		tool: rec.agent_type,
		summary,
		session: rec.session_id,
		hook: AGENT_EVENT_HOOKS[rec.event],
	};
	if (rec.cwd) ev.cwd = rec.cwd;
	if (rec.subagent_id) ev.subagent_id = rec.subagent_id;
	if (rec.parent_agent) ev.parent_agent = rec.parent_agent;
	if (rec.agent_type) ev.agent_type = rec.agent_type;
	if (rec.last_assistant_message) ev.last_assistant_message = rec.last_assistant_message;
	if (rec.agent_transcript_path) ev.agent_transcript_path = rec.agent_transcript_path;
	return ev;
}

/** Project one collection.v1 record to a v5 LocalActivityEvent. */
function collectionToActivity(rec: CollectionRecord): LocalActivityEvent {
	const isPre = rec.phase === "pre";
	// Reconstruct the failed-tool discriminator from the record's `outcome` so a
	// `logs --type tool_use_error` query still surfaces failures once collection.jsonl
	// is canonical (finding 5). A post record with `outcome: "error"` → `tool_use_error`;
	// everything else (including legacy records with no `outcome`) reads as `tool_use`.
	const postType = rec.outcome === "error" ? "tool_use_error" : "tool_use";
	const ev: LocalActivityEvent = {
		schema_version: 5,
		ts: rec.ts,
		agent: rec.agent_name ?? rec.provider ?? "unknown",
		type: isPre ? "tool_use_start" : postType,
		tool: rec.provider_tool,
		summary: summarizeAction(rec.action),
		session: rec.session_id,
		hook: isPre ? "PreToolUse" : "PostToolUse",
	};
	if (rec.cwd) ev.cwd = rec.cwd;
	if (rec.tool_use_id) ev.tool_use_id = rec.tool_use_id;
	return ev;
}

/** Read recent tool activity from collection.jsonl, projected to the v5 display
 *  shape, applying the same since/agent/type/limit filters as readLocalActivity.
 *  Newest-first (mirrors readRecentLines order). */
export function readCollectionActivity(opts?: {
	since?: number | undefined;
	agent?: string | undefined;
	limit?: number | undefined;
	type?: string | undefined;
	cwd?: string | undefined;
}): LocalActivityEvent[] {
	const path = getCollectionPath(opts?.cwd ?? process.cwd());
	if (!existsSync(path)) return [];
	const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
	const scanLineBudget = limit ? Math.max(limit * 20, 500) : 10000;
	const events: LocalActivityEvent[] = [];
	for (const line of readRecentLines(path, scanLineBudget)) {
		try {
			const parsed = JSON.parse(line) as CollectionRecord | AgentEventRecord;
			const ev =
				parsed.kind === "agent_event"
					? agentEventToActivity(parsed)
					: collectionToActivity(parsed);
			if (opts?.since && new Date(ev.ts).getTime() < opts.since) break;
			if (opts?.agent && ev.agent !== opts.agent) continue;
			if (opts?.type && ev.type !== opts.type) continue;
			events.push(ev);
			if (limit && events.length >= limit) break;
		} catch {
			continue;
		}
	}
	return events;
}

export function readRecentLines(path: string, maxLines: number): string[] {
	if (maxLines <= 0) {
		return [];
	}

	const fileSize = statSync(path).size;
	if (fileSize <= 0) {
		return [];
	}

	const fd = openSync(path, "r");
	const chunkSize = 64 * 1024;
	let position = fileSize;
	let carry = "";
	const lines: string[] = [];

	try {
		while (position > 0 && lines.length < maxLines) {
			const readSize = Math.min(chunkSize, position);
			position -= readSize;

			const buffer = Buffer.alloc(readSize);
			readSync(fd, buffer, 0, readSize, position);

			const chunk = buffer.toString("utf-8") + carry;
			const parts = chunk.split("\n");
			carry = parts.shift() || "";

			for (let i = parts.length - 1; i >= 0 && lines.length < maxLines; i--) {
				const line = nonNull(parts[i]).trim();
				if (line) {
					lines.push(line);
				}
			}
		}

		if (carry.trim() && lines.length < maxLines) {
			lines.push(carry.trim());
		}

		return lines;
	} finally {
		closeSync(fd);
	}
}

export function countJsonlLines(path: string): number {
	if (!existsSync(path)) {
		return 0;
	}
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0).length;
	} catch (_err) {
		/* intentional: unreadable jsonl — report 0 lines rather than surface the error */
		return 0;
	}
}
