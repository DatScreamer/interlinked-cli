// ===========================================
// Per-edit cyclomatic pulse — ambient PostToolUse complexity telemetry
// ===========================================
// Closes the "metrics are pull-only" gap: every per-tool-call surface (the
// strict cyclomatic gate, the coverage/CRAP gates) only speaks when a
// threshold is crossed, so the numbers otherwise exist solely behind
// `interlinked metrics`. This module pushes the cyclomatic profile of every
// edited code file back to the agent as ONE non-blocking PostToolUse context
// line — absolute values plus the edit's delta — making complexity ambient
// telemetry rather than pull-only.
//
// Cost model: the gate (complexity-write-guard.ts) ALREADY parses both the
// before- and after-content of every gated Write/Edit and discards the
// entries unless a function crossed the cap. PreToolUse stashes those
// already-paid parses via the gate's observer (keyed by session + absolute
// path, with the projected after-content's sha256); PostToolUse consumes the
// stash only when the on-disk bytes match that hash — a mismatch (user denied
// the call, a later gate blocked it, a racing writer won) discards the
// snapshot rather than reporting a state that never landed. On a stash miss
// for a governed code file it falls back to ONE on-disk parse and reports
// absolutes without the delta. Steady-state marginal cost per edit is a file
// read + hash; no extra AST parse.
//
// Population matches the gate exactly: cappable hand-written code files in a
// language with a cyclomatic analyzer (tests / generated / non-code skipped).
// Names are phrasing only, never decisions — anonymous "(callback)" entries
// contribute to ΣCC but are not name-matched across before/after.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { isCappableFile } from "../large-file-policy.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { HarnessEvent } from "../types.js";
import { DEFAULT_MAX_CYCLOMATIC, selectAnalyzer } from "./complexity-write-guard.js";
import { isFileWrite } from "./tool-classifiers.js";

/** Stash capacity — bounds daemon memory; oldest-first eviction. */
export const MAX_STASH_ENTRIES = 256;
/** Most files profiled per event (an apply_patch can carry many sections). */
export const MAX_FILES_PER_EVENT = 4;
/** Most per-name deltas spelled out on one pulse line. */
const MAX_NAMED_DELTAS = 3;
/** Most over-cap functions listed on one pulse line. */
const MAX_OVER_CAP_LISTED = 3;
/** AST name for anonymous functions — not matchable across before/after
 *  (mirrors complexity-write-guard's ANON_FN). */
const ANON_FN = "(callback)";

/** One stashed pre-edit analysis, awaiting its PostToolUse. */
export interface PulseSnapshot {
	beforeFns: FunctionComplexityEntry[];
	afterFns: FunctionComplexityEntry[];
	/** sha256 of the projected after-content — consumed only on an exact match. */
	afterHash: string;
}

const stash = new Map<string, PulseSnapshot>();

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function stashKey(sessionId: string, absPath: string): string {
	return `${sessionId}\u0000${absPath}`;
}

/**
 * PreToolUse side: capture the gate's already-computed before/after entries
 * for one analyzed file (wired as the gate's observer in pre-tool-phases.ts).
 * Re-recording a key refreshes it; the oldest snapshot is evicted past the cap.
 */
export function recordComplexityPulse(
	sessionId: string,
	absPath: string,
	beforeFns: FunctionComplexityEntry[],
	afterFns: FunctionComplexityEntry[],
	afterContent: string,
): void {
	const key = stashKey(sessionId, absPath);
	stash.delete(key); // re-insert at the tail so eviction stays oldest-first
	stash.set(key, { beforeFns, afterFns, afterHash: sha256(afterContent) });
	if (stash.size > MAX_STASH_ENTRIES) {
		const oldest = stash.keys().next().value;
		if (oldest !== undefined) stash.delete(oldest);
	}
}

/**
 * PostToolUse side: consume (delete-on-read) the stashed snapshot, but only
 * when the on-disk content matches the projected after-content. A mismatch
 * means the write the snapshot describes never landed — the snapshot is
 * dropped, never reported.
 */
export function consumeComplexityPulse(
	sessionId: string,
	absPath: string,
	diskContent: string,
): PulseSnapshot | null {
	const key = stashKey(sessionId, absPath);
	const snap = stash.get(key);
	if (!snap) return null;
	stash.delete(key);
	return snap.afterHash === sha256(diskContent) ? snap : null;
}

/** Test-only: clear the stash so suites are order-independent. */
export function __resetComplexityPulseForTesting(): void {
	stash.clear();
}

function sumCC(fns: readonly FunctionComplexityEntry[]): number {
	let total = 0;
	for (const f of fns) total += f.cyclomatic;
	return total;
}

/** name → max cyclomatic among same-named functions (anonymous skipped). */
function nameMaxMap(fns: readonly FunctionComplexityEntry[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const f of fns) {
		if (f.name === ANON_FN) continue;
		m.set(f.name, Math.max(m.get(f.name) ?? 0, f.cyclomatic));
	}
	return m;
}

function signed(n: number): string {
	return n > 0 ? `+${n}` : String(n);
}

interface NamedDelta {
	label: string;
	magnitude: number;
}

/** Best-effort per-name deltas (phrasing only): changed / new / removed, by
 *  max-CC per name, sorted by |Δ| descending. */
function namedDeltas(
	before: readonly FunctionComplexityEntry[],
	after: readonly FunctionComplexityEntry[],
): NamedDelta[] {
	const beforeMap = nameMaxMap(before);
	const afterMap = nameMaxMap(after);
	const out: NamedDelta[] = [];
	for (const [name, cc] of afterMap) {
		const prior = beforeMap.get(name);
		if (prior === undefined) out.push({ label: `${name} new=${cc}`, magnitude: cc });
		else if (prior !== cc)
			out.push({ label: `${name} ${prior}→${cc}`, magnitude: Math.abs(cc - prior) });
	}
	for (const [name, cc] of beforeMap) {
		if (!afterMap.has(name)) out.push({ label: `${name} removed (was ${cc})`, magnitude: cc });
	}
	out.sort((a, b) => b.magnitude - a.magnitude);
	return out;
}

/**
 * The one-line pulse, or null when there is nothing to say (no functions on
 * either side). `beforeFns === null` means no pre-edit snapshot was available
 * (stash miss) — absolutes only, no Δ.
 */
export function formatComplexityPulse(
	displayPath: string,
	beforeFns: readonly FunctionComplexityEntry[] | null,
	afterFns: readonly FunctionComplexityEntry[],
): string | null {
	if (afterFns.length === 0 && (beforeFns?.length ?? 0) === 0) return null;

	const total = sumCC(afterFns);
	let line = `[interlinked:cyclomatic] ${displayPath}: ${afterFns.length} fns, ΣCC ${total}`;
	if (beforeFns) line += ` (Δ${signed(total - sumCC(beforeFns))})`;

	if (afterFns.length > 0) {
		const max = afterFns.reduce((m, f) => (f.cyclomatic > m.cyclomatic ? f : m));
		line += `, max ${max.name}=${max.cyclomatic} (cap ${DEFAULT_MAX_CYCLOMATIC})`;
	}

	if (beforeFns) {
		const deltas = namedDeltas(beforeFns, afterFns);
		if (deltas.length > 0) {
			const shown = deltas
				.slice(0, MAX_NAMED_DELTAS)
				.map((d) => d.label)
				.join(", ");
			const more = deltas.length - MAX_NAMED_DELTAS;
			line += `; Δ fns: ${shown}${more > 0 ? `, +${more} more` : ""}`;
		}
	}

	const overCap = afterFns
		.filter((f) => f.cyclomatic > DEFAULT_MAX_CYCLOMATIC)
		.sort((a, b) => b.cyclomatic - a.cyclomatic);
	if (overCap.length > 0) {
		const shown = overCap
			.slice(0, MAX_OVER_CAP_LISTED)
			.map((f) => `${f.name}=${f.cyclomatic}`)
			.join(", ");
		const more = overCap.length - MAX_OVER_CAP_LISTED;
		line += `; over cap: ${shown}${more > 0 ? `, +${more} more` : ""}`;
	}
	return line;
}

/** The pulse line for one on-disk file, or null (unreadable, not a governed
 *  code file, analyzer unavailable, or nothing to say). */
function pulseForFile(sessionId: string, cwd: string, absPath: string): string | null {
	let disk: string;
	try {
		disk = readFileSync(absPath, "utf-8");
	} catch {
		return null; // deleted / unreadable — nothing to profile
	}

	const snap = consumeComplexityPulse(sessionId, absPath, disk);
	let beforeFns: readonly FunctionComplexityEntry[] | null;
	let afterFns: FunctionComplexityEntry[] | null;
	if (snap) {
		({ beforeFns, afterFns } = snap);
	} else {
		// Stash miss (daemon restarted, runner without a PreToolUse, projected
		// content never landed): one on-disk parse, absolutes only. Same
		// population filter as the gate.
		if (!isCappableFile({ filePath: absPath, content: disk })) return null;
		const analyzer = selectAnalyzer(absPath);
		if (!analyzer) return null;
		beforeFns = null;
		afterFns = analyzer.compute(disk, absPath);
	}
	if (!afterFns) return null;

	const rel = relative(cwd, absPath);
	const display = rel === "" || rel.startsWith("..") ? absPath : rel;
	return formatComplexityPulse(display, beforeFns, afterFns);
}

/**
 * PostToolUse entry — one pulse line per edited code file, bounded per event.
 * Never blocks; returns [] for non-write tools and ungoverned files.
 */
export function collectComplexityPulseWarnings(event: HarnessEvent): string[] {
	if (!isFileWrite(event.tool_name || "")) return [];
	const cwd = event.cwd || process.cwd();
	const warnings: string[] = [];
	for (const path of extractAllEditedFilePaths(event).slice(0, MAX_FILES_PER_EVENT)) {
		const abs = isAbsolute(path) ? path : resolve(cwd, path);
		const line = pulseForFile(event.session_id, cwd, abs);
		if (line) warnings.push(line);
	}
	return warnings;
}
