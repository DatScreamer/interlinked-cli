// ===========================================
// Daemon lifecycle ledger — every exit self-documents
// ===========================================
// Over one session (2026-07-28) the daemon "went down" a dozen times with FOUR
// distinct causes — build-refresh handovers after any rebuild of the shared
// dist (including rebuilds triggered from OTHER guarded repos via `interlinked
// reload`), memory hangs on a swap-bound machine, orphan accumulation, and the
// RSS-ceiling recycle — and every one presented to the agent as the same
// opaque symptom: "BLOCKED: pid present, no live daemon". Hours went into
// re-diagnosing (and misattributing) each occurrence, because nothing recorded
// WHY the previous daemon left.
//
// This ledger is that record. Daemons append one row on start, hand-over
// intent, and exit (with reason + RSS + uptime); the cold-block message and
// `harness status` read the tail so an outage explains itself: "handed over to
// a newer build 4s ago — normal after a rebuild" is actionable in a way
// "unreachable" never was.
//
// Design constraints, in order: NEVER throw (the guard must not die of its own
// diary); bounded reads (tail only); extensible (a new exit reason is just a
// new string — readers print unknown reasons verbatim).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Known reasons; readers must handle unknown strings (forward compatibility). */
export type DaemonEventKind = "start" | "listening" | "handover" | "exit" | "spike";

export interface DaemonLedgerEvent {
	/** Epoch ms. */
	at: number;
	pid: number;
	event: DaemonEventKind;
	/** e.g. "signal" | "idle-timeout" | "rss-ceiling" | "build-refresh" | "crash". */
	reason?: string;
	detail?: string;
	rss_mb?: number;
	/** V8 heap in use — JS objects (caches, ASTs, parsed structures). */
	heap_mb?: number;
	/** External + ArrayBuffers — Buffers, subprocess output, native allocations.
	 *  The heap/external SPLIT is the first question of any memory diagnosis:
	 *  the 2026-07-28 spikes (0→838MB in 15s, 2.5GB in one 30s window) could not
	 *  be attributed without it. */
	ext_mb?: number;
	uptime_s?: number;
}

const LEDGER_REL = join(".interlinked", "daemon-events.jsonl");
/** Tail bound for reads — ~8KB ≈ the last few dozen lifecycle events. */
const READ_TAIL_BYTES = 8 * 1024;
/** An exit older than this cannot explain a CURRENT outage. */
const EXPLAIN_WINDOW_MS = 5 * 60 * 1000;

function ledgerPath(projectRoot: string): string {
	return join(projectRoot, LEDGER_REL);
}

/** Append one event. Never throws — a diary failure must not harm the daemon. */
export function recordDaemonEvent(projectRoot: string, evt: DaemonLedgerEvent): void {
	try {
		mkdirSync(join(projectRoot, ".interlinked"), { recursive: true });
		appendFileSync(ledgerPath(projectRoot), `${JSON.stringify(evt)}\n`);
	} catch (err) {
		// Deliberately quiet: this can run on the Stop/shutdown path where stderr
		// becomes agent-visible noise, and there is no safer channel left.
		void err;
	}
}

function parseEventLine(line: string): DaemonLedgerEvent | null {
	try {
		const raw: unknown = JSON.parse(line);
		if (typeof raw !== "object" || raw === null) return null;
		// SAFETY: object-ness checked above; the three required fields are
		// individually type-tested below before the row is trusted.
		const e = raw as Partial<DaemonLedgerEvent>;
		if (typeof e.at !== "number" || typeof e.pid !== "number" || typeof e.event !== "string") return null;
		// SAFETY: at/pid/event verified as number/number/string on the line above.
		return e as DaemonLedgerEvent;
	} catch {
		// A torn final line from a killed daemon is expected, not exceptional.
		return null;
	}
}

/** The newest events, oldest→newest, from a bounded tail read. Never throws. */
export function readRecentDaemonEvents(projectRoot: string): DaemonLedgerEvent[] {
	const path = ledgerPath(projectRoot);
	try {
		if (!existsSync(path)) return [];
		const size = statSync(path).size;
		const full = readFileSync(path, "utf-8");
		const tail = size > READ_TAIL_BYTES ? full.slice(full.length - READ_TAIL_BYTES) : full;
		const lines = tail.split("\n");
		// A mid-line cut at the tail boundary produces a torn first line; drop it.
		if (size > READ_TAIL_BYTES) lines.shift();
		const out: DaemonLedgerEvent[] = [];
		for (const line of lines) {
			if (line.trim() === "") continue;
			const evt = parseEventLine(line);
			if (evt) out.push(evt);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * One sentence explaining the most recent RELEVANT exit, or null.
 *
 * Null when there is no exit recent enough to explain a current outage — a
 * wrong explanation is worse than none. A `handover` intent immediately before
 * the exit upgrades a generic "signal" exit into its real cause: the
 * build-refresh watcher hands over by spawning `harness restart`, so the exit
 * itself only ever sees SIGTERM.
 */
export function describeLastExit(events: DaemonLedgerEvent[], nowMs: number): string | null {
	let lastExit: DaemonLedgerEvent | null = null;
	let lastHandover: DaemonLedgerEvent | null = null;
	for (const e of events) {
		if (e.event === "exit") lastExit = e;
		if (e.event === "handover") lastHandover = e;
	}
	if (lastExit === null) return null;
	if (nowMs - lastExit.at > EXPLAIN_WINDOW_MS) return null;

	const ageS = Math.max(0, Math.round((nowMs - lastExit.at) / 1000));
	const handoverExplains =
		lastHandover !== null && lastExit.at >= lastHandover.at && lastExit.at - lastHandover.at < 60_000;
	const reason = handoverExplains ? (lastHandover?.reason ?? "handover") : (lastExit.reason ?? "unknown");
	const rss = lastExit.rss_mb !== undefined ? `, rss ${lastExit.rss_mb}MB` : "";
	const normal =
		reason === "build-refresh" || reason === "rss-ceiling" || reason === "idle-timeout"
			? " — planned restart, not a crash; self-heal brings it back"
			: "";
	return `last daemon (pid ${lastExit.pid}) exited ${ageS}s ago: ${reason}${rss}${normal}`;
}
