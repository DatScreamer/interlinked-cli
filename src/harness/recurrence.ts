// ===========================================
// Recurrence Aggregation
// ===========================================
// Small JSONL-backed primitive for grouping repeated harness findings and
// user-reported misses into actionable recurrence rows.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RecurrenceKind =
	| "harness_caught"
	| "harness_missed"
	| "codebase_existing"
	| "outcome_marker"
	| "tool_failure";

/** Phase 1 FP-telemetry additions (see docs/plans/11-phase1-...md). */
export type RecurrencePhase = "pre_block" | "pre_warn" | "post";
export type RecurrenceSeverity = "error" | "warning";
/**
 * Outcome of a prior fire — emitted later in the session lifecycle, not at
 * fire time. Phase 2's FP-rate aggregator uses these as the FP-candidate set
 * (`agent_fixed` is the implicit positive). Storage shape is `outcome_marker`
 * events that cross-reference the original fire by (check_id, file,
 * session_id, fire_ts).
 */
export type OutcomeSignal =
	| "agent_fixed"
	| "agent_suppressed"
	| "user_overrode"
	| "check_reverted";

export interface RecurrenceEvent {
	ts: string;
	kind: RecurrenceKind;
	check_id?: string | undefined;
	agent_source?: string | undefined;
	session_id?: string | undefined;
	file?: string | undefined;
	message?: string | undefined;
	signature?: string | undefined;
	/** Phase the originating check declared. Optional for backwards compat
	 *  with rows written before Phase 1 of the rollout. */
	phase?: RecurrencePhase | undefined;
	/** Severity at the originating check. Optional for backwards compat. */
	severity?: RecurrenceSeverity | undefined;
	/** Set on `outcome_marker` rows; identifies what happened to the fire. */
	outcome_signal?: OutcomeSignal | undefined;
	/** Free-text one-liner explaining the outcome (e.g., the suppression
	 *  directive text + justification). */
	outcome_reason?: string | undefined;
	/** Set on `outcome_marker` rows; the `ts` of the original fire being
	 *  marked. Lets the aggregator pair markers to fires deterministically. */
	fire_ts?: string | undefined;
}

export interface Recurrence {
	kind: RecurrenceKind;
	signature: string;
	check_id?: string | undefined;
	count: number;
	first_seen: string;
	last_seen: string;
	distinct_sessions: number;
	distinct_files: number;
	agent_sources: string[];
	sample_files: string[];
}

export interface RecurrenceFilters {
	kind?: RecurrenceKind;
	since?: string;
	agent_source?: string;
	check_id?: string;
}

export interface RecurrenceAction {
	kind: "ratchet" | "scaffold_rule" | "cleanup_pr";
	headline: string;
	detail: string;
}

const RECURRENCES_FILE = "recurrences.jsonl";
const INTERLINKED_DIR = ".interlinked";
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

const DURATION_UNITS_MS: Record<string, number> = {
	s: MS_PER_SECOND,
	m: SECONDS_PER_MINUTE * MS_PER_SECOND,
	h: MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
	d: HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
	w: DAYS_PER_WEEK * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
};

export function deriveSignature(event: RecurrenceEvent): string {
	if (event.kind === "harness_caught") {
		return `harness_caught:${event.check_id ?? "unknown"}:${event.agent_source ?? "unknown"}`;
	}
	if (event.kind === "codebase_existing") {
		return `codebase_existing:${event.check_id ?? "unknown"}`;
	}
	if (event.kind === "tool_failure") {
		// Phase 1 Channel 1 — tool-failure pattern grouping. Pre-built signature
		// from the harness handler is `tool_failure:<tool>:<error_class>:<message-prefix>`;
		// we forward the carrier `signature` if set, falling back to a coarser
		// `<tool>:<message-prefix>` so old rows still aggregate.
		if (event.signature) return event.signature;
		const messagePrefix = (event.message ?? "untagged").slice(0, 30);
		return `tool_failure:${event.check_id ?? "unknown"}:${messagePrefix}`;
	}
	return `harness_missed:${event.signature ?? event.message ?? "untagged"}`;
}

export function aggregateRecurrences(
	events: readonly RecurrenceEvent[],
	filters: RecurrenceFilters = {},
): Recurrence[] {
	const filtered = events.filter((event) => matchesFilters(event, filters));
	const buckets = new Map<
		string,
		{
			kind: RecurrenceKind;
			signature: string;
			check_id?: string | undefined;
			count: number;
			first_seen: string;
			last_seen: string;
			sessions: Set<string>;
			files: Set<string>;
			agent_sources: Set<string>;
			fileEvents: Array<{ file: string; ts: string }>;
		}
	>();

	for (const event of filtered) {
		const signature = deriveSignature(event);
		const row =
			buckets.get(signature) ??
			{
				kind: event.kind,
				signature,
				check_id: event.check_id,
				count: 0,
				first_seen: event.ts,
				last_seen: event.ts,
				sessions: new Set<string>(),
				files: new Set<string>(),
				agent_sources: new Set<string>(),
				fileEvents: [],
			};

		row.count++;
		if (new Date(event.ts).getTime() < new Date(row.first_seen).getTime()) {
			row.first_seen = event.ts;
		}
		if (new Date(event.ts).getTime() > new Date(row.last_seen).getTime()) {
			row.last_seen = event.ts;
		}
		if (event.session_id) row.sessions.add(event.session_id);
		if (event.file) {
			row.files.add(event.file);
			row.fileEvents.push({ file: event.file, ts: event.ts });
		}
		if (event.agent_source) row.agent_sources.add(event.agent_source);
		buckets.set(signature, row);
	}

	return [...buckets.values()]
		.map((row): Recurrence => ({
			kind: row.kind,
			signature: row.signature,
			check_id: row.check_id,
			count: row.count,
			first_seen: row.first_seen,
			last_seen: row.last_seen,
			distinct_sessions: row.sessions.size,
			distinct_files: row.files.size,
			agent_sources: [...row.agent_sources].sort(),
			sample_files: recentUniqueFiles(row.fileEvents),
		}))
		.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

export function parseDurationMs(input: string): number | null {
	const match = /^\s*(\d+)\s*([smhdw])\s*$/i.exec(input);
	if (!match) return null;
	const amount = Number(match[1]);
	const unitMs = DURATION_UNITS_MS[match[2].toLowerCase()];
	if (!Number.isFinite(amount) || !unitMs) return null;
	return amount * unitMs;
}

export function resolveSinceCutoff(
	input: string | undefined,
	now: Date = new Date(),
): string | null {
	if (!input) return null;
	const duration = parseDurationMs(input);
	if (duration !== null) return new Date(now.getTime() - duration).toISOString();
	const parsed = new Date(input);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

export function proposeAction(row: Recurrence): RecurrenceAction {
	if (row.kind === "harness_missed") {
		return {
			kind: "scaffold_rule",
			headline: `Scaffold a new rule for ${row.signature.replace(/^harness_missed:/, "")}`,
			detail:
				"Create a deterministic rule or quality check for this repeated user-reported miss, then add regression tests from the sample files.",
		};
	}
	if (row.kind === "codebase_existing") {
		return {
			kind: "cleanup_pr",
			headline: `Open cleanup PR for ${row.distinct_files} file(s) with ${row.check_id ?? row.signature}`,
			detail: `Fix existing findings across sample files: ${row.sample_files.join(", ") || "none recorded"}.`,
		};
	}
	return {
		kind: "ratchet",
		headline: `Ratchet recurring ${row.check_id ?? row.signature} findings`,
		detail:
			"Promote or tune the recurring check in guard-rules.local.json so repeated agent mistakes become harder to reintroduce.",
	};
}

export function recurrencesPath(cwd: string): string {
	return join(cwd, INTERLINKED_DIR, RECURRENCES_FILE);
}

export function recordRecurrenceEvent(event: RecurrenceEvent, cwd: string): void {
	const path = recurrencesPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
}

export function loadRecurrenceEvents(cwd: string): RecurrenceEvent[] {
	const path = recurrencesPath(cwd);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf-8").split("\n");
	const out: RecurrenceEvent[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecurrenceEvent(parsed)) out.push(parsed);
		} catch (_err) {
			/* intentional: JSONL may be torn if a process died mid-write — skip bad lines */
			void _err;
		}
	}
	return out;
}

function matchesFilters(event: RecurrenceEvent, filters: RecurrenceFilters): boolean {
	if (filters.kind && event.kind !== filters.kind) return false;
	if (filters.agent_source && event.agent_source !== filters.agent_source) return false;
	if (filters.check_id && event.check_id !== filters.check_id) return false;
	if (filters.since && new Date(event.ts).getTime() < new Date(filters.since).getTime()) {
		return false;
	}
	return true;
}

function recentUniqueFiles(events: Array<{ file: string; ts: string }>): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	const sorted = [...events].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
	for (const event of sorted) {
		if (seen.has(event.file)) continue;
		seen.add(event.file);
		files.push(event.file);
	}
	return files;
}

// ===========================================
// Wiring helpers — convert callsite signals into recurrence events
// ===========================================

/** Record a harness_caught recurrence from a check failure observed by
 *  the harness (PostToolUse quality / structural check). Single-line
 *  callsite for `server.ts` so the wiring is grep-able. Storage failures
 *  are swallowed here — this is on the PostToolUse hot path, where an
 *  observability write must never abort the hook response. CLI callers
 *  that *want* to surface storage failures use `recordRecurrenceEvent`
 *  or `recordHarnessMissed` directly. */
export function recordHarnessCaught(opts: {
	check_id: string;
	agent_source: string;
	session_id: string;
	file: string;
	message?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
	phase?: RecurrencePhase | undefined;
	severity?: RecurrenceSeverity | undefined;
}): void {
	try {
		recordRecurrenceEvent(
			{
				ts: opts.ts ?? new Date().toISOString(),
				kind: "harness_caught",
				check_id: opts.check_id,
				agent_source: opts.agent_source,
				session_id: opts.session_id,
				file: opts.file,
				message: opts.message,
				phase: opts.phase,
				severity: opts.severity,
			},
			opts.cwd ?? process.cwd(),
		);
	} catch (e) {
		void e;
	}
}

/** Phase 1 Channel 1 — tool-failure recurrence. Single grep-able callsite for
 *  the harness handler in `server.ts` to record a tool failure under the
 *  recurrence substrate so `interlinked recurrence list --kind tool_failure`
 *  can aggregate "this exact failure happened N times in M sessions". The
 *  harness builds the signature `tool_failure:<tool>:<error_class>:<message-prefix>`
 *  and passes it in directly; we don't try to re-derive it here because
 *  triage classification (Channel 2) is what produces the error_class. Storage
 *  failures swallowed for the same reason as `recordHarnessCaught` — this
 *  fires on the PostToolUse hot path. */
export function recordToolFailure(opts: {
	tool_name: string;
	signature: string;
	agent_source: string;
	session_id: string;
	file?: string | undefined;
	message?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
}): void {
	try {
		recordRecurrenceEvent(
			{
				ts: opts.ts ?? new Date().toISOString(),
				kind: "tool_failure",
				check_id: opts.tool_name,
				agent_source: opts.agent_source,
				session_id: opts.session_id,
				file: opts.file,
				signature: opts.signature,
				message: opts.message,
			},
			opts.cwd ?? process.cwd(),
		);
	} catch (e) {
		void e;
	}
}

/**
 * Public API surface for Phase 2's FP-rate aggregator. Mark an outcome for
 * a prior `harness_caught` fire — idempotent on (check_id, file, session_id,
 * fire_ts). The aggregator dedupes when multiple paths emit (e.g., agent
 * fixes a finding *and* suppresses an adjacent one). Storage failures
 * swallowed for the same reason as `recordHarnessCaught`.
 *
 * Phase 1 commits to emission only — the producer paths (fix-detection,
 * suppression-detection, user-override hook) land in Phase 2. This export
 * intentionally has no in-tree consumers yet; do not remove. */
export function markOutcome(opts: {
	check_id: string;
	file: string;
	session_id: string;
	signal: OutcomeSignal;
	reason?: string | undefined;
	fire_ts?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
}): void {
	try {
		recordRecurrenceEvent(
			{
				ts: opts.ts ?? new Date().toISOString(),
				kind: "outcome_marker",
				check_id: opts.check_id,
				session_id: opts.session_id,
				file: opts.file,
				outcome_signal: opts.signal,
				outcome_reason: opts.reason,
				fire_ts: opts.fire_ts,
			},
			opts.cwd ?? process.cwd(),
		);
	} catch (e) {
		void e;
	}
}

/** Record a harness_missed recurrence — a pattern that recurred without
 *  any rule firing. v1 surface is manual: the user runs `interlinked
 *  recurrence flag <signature>` after noticing a repeated mistake the
 *  harness didn't catch. v2 will detect from git-history heuristics
 *  (e.g., "same function reverted N times in M sessions"); the v2 hook
 *  lands here, calling this function once per detected pattern. */
export function recordHarnessMissed(opts: {
	signature: string;
	check_id?: string | undefined;
	file?: string | undefined;
	message?: string | undefined;
	cwd?: string | undefined;
	ts?: string | undefined;
}): void {
	recordRecurrenceEvent(
		{
			ts: opts.ts ?? new Date().toISOString(),
			kind: "harness_missed",
			check_id: opts.check_id,
			file: opts.file,
			signature: opts.signature,
			message: opts.message,
		},
		opts.cwd ?? process.cwd(),
	);
}

function isRecurrenceEvent(value: unknown): value is RecurrenceEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Partial<RecurrenceEvent>;
	return (
		typeof event.ts === "string" &&
		(event.kind === "harness_caught" ||
			event.kind === "harness_missed" ||
			event.kind === "codebase_existing" ||
			event.kind === "outcome_marker" ||
			event.kind === "tool_failure")
	);
}
