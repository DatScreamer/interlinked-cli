// ===========================================
// Agent Trace Export/Import
// ===========================================
// Exports local activity to a standard trace format and imports back.

import { parseDuration } from "./activity-utils.js";
import type { JsonObject } from "./json-types.js";
import {
	appendLocalActivity,
	type LocalActivityEvent,
	readLocalActivity,
} from "./local-activity.js";

// ===========================================
// Types
// ===========================================

interface TraceSpan {
	trace_id: string;
	span_id: string;
	name: string;
	timestamp: string;
	duration_ms?: number;
	attributes: JsonObject;
}

interface TraceDocument {
	format: "interlinked-trace";
	version: 1;
	exported_at: string;
	spans: TraceSpan[];
}

// ===========================================
// Export
// ===========================================

/**
 * Export local activity events as trace spans.
 */
export function exportTrace(opts?: {
	since?: string;
	agent?: string;
	format?: "json" | "jsonl";
	cwd?: string;
}): string {
	const sinceMs = opts?.since ? Date.now() - parseDuration(opts.since) : undefined;

	const events = readLocalActivity({
		since: sinceMs,
		agent: opts?.agent,
		limit: 10000,
		cwd: opts?.cwd,
	});

	const spans: TraceSpan[] = events.map((e, i) => ({
		trace_id: e.session || `trace-${e.ts?.slice(0, 10) || "unknown"}`,
		span_id: `span-${i}-${e.ts?.replace(/\D/g, "").slice(0, 14) || i}`,
		name: e.type || "unknown",
		timestamp: e.ts,
		duration_ms: e.duration_ms || undefined,
		attributes: {
			agent: e.agent,
			tool: e.tool || undefined,
			summary: e.summary || undefined,
			hook: e.hook || undefined,
			...(e.tokens ? { tokens: e.tokens } : {}),
			...(e.parent_agent ? { parent_agent: e.parent_agent } : {}),
			...(e.subagent_id ? { subagent_id: e.subagent_id } : {}),
		},
	}));

	if (opts?.format === "jsonl") {
		return `${spans.map((s) => JSON.stringify(s)).join("\n")}\n`;
	}

	const doc: TraceDocument = {
		format: "interlinked-trace",
		version: 1,
		exported_at: new Date().toISOString(),
		spans,
	};

	return JSON.stringify(doc, null, 2);
}

// ===========================================
// Import
// ===========================================

export interface ImportTraceResult {
	imported: number;
	skipped: number;
}

/**
 * Import trace spans into the local activity log.
 * Deduplicates by timestamp + agent + type.
 */
export function importTrace(data: string, cwd?: string): ImportTraceResult {
	let spans: TraceSpan[] = [];

	// Try JSON document first
	try {
		const doc = JSON.parse(data);
		if (doc.format === "interlinked-trace" && Array.isArray(doc.spans)) {
			spans = doc.spans;
		} else if (Array.isArray(doc)) {
			spans = doc;
		}
	} catch (_err) {
		/* intentional: input isn't a JSON document — fall back to JSONL line-by-line parsing */
		const lines = data.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				spans.push(JSON.parse(line));
			} catch (_lineErr) {
				/* intentional: skip a malformed JSONL line rather than fail the whole import */
			}
		}
	}

	if (spans.length === 0) {
		return { imported: 0, skipped: 0 };
	}

	// Read existing events for dedup
	const existing = readLocalActivity({ limit: 50000, cwd });
	const existingKeys = new Set(existing.map((e) => `${e.ts}|${e.agent}|${e.type}`));

	let imported = 0;
	let skipped = 0;

	for (const span of spans) {
		const event: LocalActivityEvent = {
			ts: span.timestamp,
			agent: (span.attributes.agent as string) || "unknown",
			type: span.name,
			tool: (span.attributes.tool as string) || null,
			summary: (span.attributes.summary as string) || null,
			session: span.trace_id || null,
		};

		const key = `${event.ts}|${event.agent}|${event.type}`;
		if (existingKeys.has(key)) {
			skipped++;
			continue;
		}

		appendLocalActivity(event, cwd);
		existingKeys.add(key);
		imported++;
	}

	return { imported, skipped };
}
