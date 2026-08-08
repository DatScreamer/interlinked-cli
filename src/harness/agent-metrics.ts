// ===========================================
// Per-subagent transcript metrics
// ===========================================
// A spawned agent's own transcript carries the ONLY record of what that agent
// cost and did: per-assistant-turn `message.usage` (input / output / cache
// read / cache creation tokens), the model it actually ran on (often NOT the
// parent's model), and every tool call it made. None of it reaches the parent:
// Claude Code's SubagentStop payload carries no `usage` field (measured
// 2026-08-07 — 0/1507 stop events had one), so before this module the entire
// cost and shape of a subagent's run was discarded at capture time.
//
// `summarizeAgentTranscript` is a pure function over transcript JSONL text so
// it can be unit-tested without a daemon or a filesystem. It is called once,
// on SubagentStop, from server/agent-event-capture.ts.
//
// The `tool_use_ids` list is the ATTRIBUTION KEY: a subagent's own tool calls
// reach the guard as ordinary PreToolUse/PostToolUse events carrying the
// PARENT session id and no agent marker, so activity.jsonl cannot tell them
// apart. Recording the ids the agent emitted lets any consumer join
// activity/collection rows back to the agent that made them.

// The record shapes live with the other collection.v1 types (lib/collection)
// so the writer and every consumer see one definition; re-exported here
// because this module is where they are produced.
import type { AgentTokenTotals, AgentTranscriptMetrics } from "../lib/collection/types.js";
import type { JsonObject } from "../lib/json-types.js";

export type { AgentTokenTotals, AgentTranscriptMetrics };

/** Cap on the recorded id list — a runaway agent must not write an unbounded
 *  field into collection.jsonl. Counts stay exact when this trips. */
export const MAX_TOOL_USE_IDS = 2000;

const ZERO_TOKENS: AgentTokenTotals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };

/** Empty metrics — returned for an unreadable / empty transcript so callers
 *  never branch on null in the middle of record assembly. */
export function emptyAgentMetrics(): AgentTranscriptMetrics {
	return {
		assistant_turns: 0,
		tool_calls: 0,
		tools: {},
		tool_use_ids: [],
		tool_use_ids_truncated: false,
		models: [],
		tokens: { ...ZERO_TOKENS },
		thinking_blocks: 0,
		thinking_blocks_with_text: 0,
		first_ts: null,
		last_ts: null,
		duration_ms: null,
		transcript_entries: 0,
	};
}

function addUsage(totals: AgentTokenTotals, usage: JsonObject): void {
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	totals.input += n(usage.input_tokens);
	totals.output += n(usage.output_tokens);
	totals.cache_read += n(usage.cache_read_input_tokens);
	totals.cache_creation += n(usage.cache_creation_input_tokens);
}

/** Fold one `tool_use` block: per-tool count plus the capped id list. */
function foldToolUse(block: JsonObject, m: AgentTranscriptMetrics): void {
	m.tool_calls += 1;
	const name = typeof block.name === "string" && block.name ? block.name : "unknown";
	m.tools[name] = (m.tools[name] ?? 0) + 1;
	if (typeof block.id !== "string" || !block.id) return;
	if (m.tool_use_ids.length < MAX_TOOL_USE_IDS) m.tool_use_ids.push(block.id);
	else m.tool_use_ids_truncated = true;
}

/** Fold one `thinking` block, tracking text-bearing ones separately. */
function foldThinking(block: JsonObject, m: AgentTranscriptMetrics): void {
	m.thinking_blocks += 1;
	if (typeof block.thinking === "string" && block.thinking.trim()) m.thinking_blocks_with_text += 1;
}

/** Fold one assistant content block into the running metrics. */
function foldContentBlock(block: JsonObject, m: AgentTranscriptMetrics): void {
	if (block.type === "tool_use") foldToolUse(block, m);
	else if (block.type === "thinking") foldThinking(block, m);
}

/** Fold one assistant transcript entry (usage, model, content blocks). */
function foldAssistantEntry(message: JsonObject, m: AgentTranscriptMetrics): void {
	const usage = message.usage;
	if (usage && typeof usage === "object" && !Array.isArray(usage)) {
		m.assistant_turns += 1;
		// SAFETY: guarded above as a non-array object; addUsage type-checks every field.
		addUsage(m.tokens, usage as JsonObject);
	}
	const model = message.model;
	if (typeof model === "string" && model && !m.models.includes(model)) m.models.push(model);
	const content = message.content;
	if (!Array.isArray(content)) return;
	for (const raw of content) {
		// SAFETY: transcript content is untyped JSON; foldContentBlock guards every read.
		if (raw && typeof raw === "object") foldContentBlock(raw as JsonObject, m);
	}
}

/** Track the transcript's time span; entries are chronological but a tail read
 *  may start anywhere, so take min/max rather than first/last seen. */
function foldTimestamp(ts: unknown, m: AgentTranscriptMetrics): void {
	if (typeof ts !== "string" || !ts) return;
	if (m.first_ts === null || ts < m.first_ts) m.first_ts = ts;
	if (m.last_ts === null || ts > m.last_ts) m.last_ts = ts;
}

function spanMs(first: string | null, last: string | null): number | null {
	if (first === null || last === null || first === last) return null;
	const a = Date.parse(first);
	const b = Date.parse(last);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.max(0, b - a);
}

/**
 * Summarize one agent transcript (JSONL text) into cost + activity metrics.
 * Pure and total: malformed lines are skipped, an empty input yields
 * `emptyAgentMetrics()`. Never throws.
 */
export function summarizeAgentTranscript(jsonlText: string): AgentTranscriptMetrics {
	const m = emptyAgentMetrics();
	for (const line of jsonlText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: JsonObject;
		try {
			// SAFETY: transcript line is untyped JSON; every field read below is guarded.
			entry = JSON.parse(trimmed) as JsonObject;
		} catch (err) {
			void err; // truncated / non-JSON line — skip it
			continue;
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		m.transcript_entries += 1;
		foldTimestamp(entry.timestamp, m);
		const message = entry.message;
		if (entry.type === "assistant" && message && typeof message === "object" && !Array.isArray(message)) {
			// SAFETY: guarded above as a non-array object; every field read inside is type-checked.
			foldAssistantEntry(message as JsonObject, m);
		}
	}
	m.duration_ms = spanMs(m.first_ts, m.last_ts);
	return m;
}
