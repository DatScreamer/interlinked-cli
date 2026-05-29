// ===========================================
// Shared Activity Utils
// ===========================================
// Common types and helpers used by activity, explain, and status commands.
// Centralizes parseDuration and formatActivitySummary across surfaces.

import { truncate } from "./formatter.js";
import type { EventAttribution, TokenUsage } from "./local-activity.js";

// ===========================================
// Types
// ===========================================

/**
 * Normalized activity event shape used across commands.
 * Accommodates both local (JSONL) and server (API) field names.
 */
export interface ActivityEvent {
	id?: number;
	agent_name?: string;
	agent?: string;
	event_type?: string;
	type?: string;
	tool_name?: string | null;
	tool?: string | null;
	tool_input_summary?: string | null;
	summary?: string | null;
	occurred_at?: string;
	ts?: string;
	timestamp?: string;
	created_at?: string;
	duration_ms?: number;
	_source?: string;

	// v2 fields. schema_version is the LOG-FORMAT version (shared across record
	// families); the record family is keyed on `type`, not this number.
	// Historical: 2, 3 (guard), 4 (activity); 5 unified.
	schema_version?: 2 | 3 | 4 | 5;
	trace_id?: string;
	parent_agent?: string;
	subagent_id?: string;
	tokens?: TokenUsage;
	files_modified?: string[];
	attribution?: EventAttribution;
	checkpoint_id?: string;
	scrubbed?: boolean;
	[key: string]: unknown;
}

// ===========================================
// Helpers
// ===========================================

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: s (seconds), m (minutes), h (hours), d (days).
 * Throws if format is unrecognized.
 */
export function parseDuration(s: string): number {
	const normalized = s.trim().toLowerCase();
	const match = normalized.match(/^(\d+)\s*(s|m|h|d)$/);
	if (!match) {
		throw new Error(`Invalid duration "${s}". Expected format like 30m, 1h, 15s, or 2d.`);
	}
	const [, num, unit] = match;
	const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
	return Number.parseInt(num, 10) * multipliers[unit];
}

/** Token-count threshold at/above which we render in "k tok" (thousands) form. */
const K_TOKEN_THRESHOLD = 1000;

/**
 * Format a compact token count suffix.
 */
function tokenSuffix(tokens?: TokenUsage): string {
	if (!tokens) return "";
	const total = (tokens.input || 0) + (tokens.output || 0);
	if (total === 0) return "";
	if (total >= K_TOKEN_THRESHOLD) return ` (${(total / K_TOKEN_THRESHOLD).toFixed(1)}k tok)`;
	return ` (${total} tok)`;
}

/**
 * Format an activity event into a human-readable one-line summary.
 * Creates contextual descriptions for common tools (Read, Write, Edit, Bash, etc.).
 * Includes token counts when present.
 */
export function formatActivitySummary(e: ActivityEvent): string {
	if (e.event_type === "session_end" || e.type === "session_end") {
		return "Session ended";
	}
	if (e.event_type === "session_start" || e.type === "session_start") {
		return "Session started";
	}

	const tool = e.tool_name || e.tool || "unknown tool";
	const input = e.tool_input_summary || e.summary || "";
	const tok = tokenSuffix(e.tokens);

	switch (tool) {
		case "Read":
		case "ReadFile":
		case "read_file":
			return `Read ${input}${tok}`;
		case "Write":
		case "WriteFile":
		case "write_file":
			return `Wrote ${input}${tok}`;
		case "Edit":
		case "EditFile":
		case "edit_file":
			return `Edited ${input}${tok}`;
		case "Bash":
		case "Shell":
		case "run_command":
			return `Ran: ${truncate(input, 60)}${tok}`;
		case "Grep":
		case "grep":
			return `Searched: ${truncate(input, 60)}${tok}`;
		default:
			return input ? `${tool}: ${truncate(input, 50)}${tok}` : `Used ${tool}${tok}`;
	}
}
