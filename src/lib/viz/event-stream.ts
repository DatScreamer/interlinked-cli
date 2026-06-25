// ===========================================
// Viz Event Stream — live activity tail for the dashboard
// ===========================================
// Turns the harness's append-only `activity.jsonl` (the v5 family-keyed log
// written on every tool call) into a compact stream of viz events the browser
// can render. RAM-safe: the tailer reads only the bytes appended since its last
// offset — it never loads the multi-hundred-MB log.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { readRecentLines } from "../local-activity-collection.js";

export interface VizEvent {
	ts: string;
	type: string;
	tool?: string;
	file?: string;
	decision?: string;
	rule_id?: string;
	severity?: string;
	summary?: string;
}

export interface ActivityTailer {
	stop: () => void;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	if (typeof v !== "object" || v === null) return null;
	// SAFETY: a non-null typeof-"object" value is an indexable record at runtime.
	return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string): string | undefined {
	const v = o[key];
	return typeof v === "string" ? v : undefined;
}

function extractFile(r: Record<string, unknown>): string | undefined {
	const ti = asRecord(r.tool_input);
	if (ti) {
		const f = str(ti, "file_path") ?? str(ti, "path") ?? str(ti, "notebook_path");
		if (f) return f;
	}
	const fm = r.files_modified;
	if (Array.isArray(fm) && fm.length > 0 && typeof fm[0] === "string") return fm[0];
	return undefined;
}

/** Parse one v5 activity JSONL line into a compact event, or null if unusable. */
export function mapActivityLine(line: string): VizEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (err) {
		void err; /* a partial/corrupt line is skipped, not fatal */
		return null;
	}
	const r = asRecord(parsed);
	if (!r) return null;
	const ts = str(r, "ts");
	const type = str(r, "type");
	if (!ts || !type) return null;

	const ev: VizEvent = { ts, type };
	const tool = str(r, "tool");
	if (tool) ev.tool = tool;
	const file = extractFile(r);
	if (file) ev.file = file;
	const decision = str(r, "guard_decision");
	if (decision) ev.decision = decision;
	const ruleId = str(r, "guard_rule_id");
	if (ruleId) ev.rule_id = ruleId;
	const severity = str(r, "guard_severity");
	if (severity) ev.severity = severity;
	const summary = str(r, "summary");
	if (summary) ev.summary = summary;
	return ev;
}

/** Frame an event as an SSE `data:` line. Serializes either stream's event shape. */
export function formatSse(ev: VizEvent | CheckEvent): string {
	return `data: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Read the raw lines appended to `path` since `fromOffset`. Returns the new
 * lines plus the offset to resume from. If the file shrank (rotation) the
 * offset resets to the new EOF without re-reading; a missing file is a no-op.
 */
export function readAppendedLines(path: string, fromOffset: number): { lines: string[]; offset: number } {
	let size: number;
	try {
		size = statSync(path).size;
	} catch (err) {
		void err; /* file gone — nothing to read */
		return { lines: [], offset: fromOffset };
	}
	if (size <= fromOffset) return { lines: [], offset: size };

	const fd = openSync(path, "r");
	try {
		const len = size - fromOffset;
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, fromOffset);
		const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
		return { lines, offset: size };
	} finally {
		closeSync(fd);
	}
}

/** Read the most recent `max` events (chronological order) to seed a new client. */
export function seedRecentEvents(path: string, max: number): VizEvent[] {
	if (!existsSync(path)) return [];
	const lines = readRecentLines(path, max); // newest-first
	const events: VizEvent[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const ev = mapActivityLine(lines[i] ?? "");
		if (ev) events.push(ev);
	}
	return events;
}

/**
 * Poll `path` for appended events and deliver each via `onEvent`. Starts at the
 * current EOF so only NEW activity streams (seed the backlog separately). The
 * interval is unref'd so it never keeps the process alive on its own.
 */
export function createActivityTailer(
	path: string,
	onEvent: (ev: VizEvent) => void,
	intervalMs = 1000,
): ActivityTailer {
	let offset = existsSync(path) ? statSync(path).size : 0;
	const iv = setInterval(() => {
		const result = readAppendedLines(path, offset);
		offset = result.offset;
		for (const line of result.lines) {
			const ev = mapActivityLine(line);
			if (ev) onEvent(ev);
		}
	}, intervalMs);
	if (typeof iv.unref === "function") iv.unref();
	return { stop: () => clearInterval(iv) };
}

// ===========================================
// Check-results tail — per-tool-call gate decisions for the dashboard
// ===========================================
// A sibling of the activity tail above, over the harness's append-only
// `check-results.jsonl` (written by another worker on every guarded tool call).
// Same RAM-safe byte-offset reader; same seed/tailer shape. The row schema is
// fixed by the writer — `mapCheckLine` honors it verbatim and is defensive about
// partial/foreign lines (returns null rather than throwing).

/** One check fired against a tool call (severity + how it was decided). */
export interface CheckSummary {
	id: string;
	severity: string;
	determinism: "proven" | "heuristic";
	phase?: string;
}

/** A per-tool-call gate decision: which checks ran and whether the call was allowed. */
export interface CheckEvent {
	ts: string;
	tool_use_id: string;
	tool?: string;
	file?: string;
	decision: "allow" | "block";
	ran?: number;
	checks: CheckSummary[];
}

export interface ChecksTailer {
	stop: () => void;
}

function num(o: Record<string, unknown>, key: string): number | undefined {
	const v = o[key];
	return typeof v === "number" ? v : undefined;
}

/** Narrow an arbitrary string to the closed `decision` domain, or null. */
function asDecision(v: string | undefined): "allow" | "block" | null {
	return v === "allow" || v === "block" ? v : null;
}

/** Narrow an arbitrary string to the closed `determinism` domain, or null. */
function asDeterminism(v: string | undefined): "proven" | "heuristic" | null {
	return v === "proven" || v === "heuristic" ? v : null;
}

/** Project one raw check entry into a typed summary, or null if it's unusable. */
function mapCheck(raw: unknown): CheckSummary | null {
	const o = asRecord(raw);
	if (!o) return null;
	const id = str(o, "id");
	const severity = str(o, "severity");
	const determinism = asDeterminism(str(o, "determinism"));
	if (!id || !severity || !determinism) return null;
	const summary: CheckSummary = { id, severity, determinism };
	const phase = str(o, "phase");
	if (phase) summary.phase = phase;
	return summary;
}

/** Map the `checks` array (skipping malformed entries), defaulting absent/non-array to []. */
function mapChecks(raw: unknown): CheckSummary[] {
	if (!Array.isArray(raw)) return [];
	const out: CheckSummary[] = [];
	for (const entry of raw) {
		const c = mapCheck(entry);
		if (c) out.push(c);
	}
	return out;
}

/** Parse one check-results JSONL line into a typed CheckEvent, or null if unusable. */
export function mapCheckLine(line: string): CheckEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (err) {
		void err; /* a partial/corrupt line is skipped, not fatal */
		return null;
	}
	const r = asRecord(parsed);
	if (!r) return null;
	const ts = str(r, "ts");
	const toolUseId = str(r, "tool_use_id");
	const decision = asDecision(str(r, "decision"));
	if (!ts || !toolUseId || !decision) return null;

	const ev: CheckEvent = { ts, tool_use_id: toolUseId, decision, checks: mapChecks(r.checks) };
	const tool = str(r, "tool");
	if (tool) ev.tool = tool;
	const file = str(r, "file");
	if (file) ev.file = file;
	const ran = num(r, "ran");
	if (ran !== undefined) ev.ran = ran;
	return ev;
}

/** Read the most recent `max` check rows (chronological order) to seed a new client. */
export function seedRecentChecks(path: string, max: number): CheckEvent[] {
	if (!existsSync(path)) return [];
	const lines = readRecentLines(path, max); // newest-first
	const events: CheckEvent[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const ev = mapCheckLine(lines[i] ?? "");
		if (ev) events.push(ev);
	}
	return events;
}

/**
 * Poll `path` for appended check rows and deliver each via `onEvent`. Mirrors
 * `createActivityTailer`: starts at the current EOF (seed the backlog
 * separately) and unref's its interval so it never keeps the process alive.
 */
export function createChecksTailer(
	path: string,
	onEvent: (ev: CheckEvent) => void,
	intervalMs = 1000,
): ChecksTailer {
	let offset = existsSync(path) ? statSync(path).size : 0;
	const iv = setInterval(() => {
		const result = readAppendedLines(path, offset);
		offset = result.offset;
		for (const line of result.lines) {
			const ev = mapCheckLine(line);
			if (ev) onEvent(ev);
		}
	}, intervalMs);
	if (typeof iv.unref === "function") iv.unref();
	return { stop: () => clearInterval(iv) };
}
