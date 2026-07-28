// ===========================================
// Stop nudges — say it once
// ===========================================
// A Stop reflection that repeats verbatim while nothing has changed is not a
// reminder, it is a loop. Observed in a real install:
//
//   agent: "Waiting on your call for the commit and deploy."
//   Stop:  "[verify-before-stop] 5 deferred coverage check(s) … run the full
//           suite with coverage, or commit …"
//   agent: "Waiting on your call for the commit and deploy."
//   Stop:  (identical nudge)
//   … until the user interrupted.
//
// The trap has two jaws. First, the agent was blocked on a HUMAN decision, so
// no amount of nudging could advance it. Second, one of the two offered
// remedies was "commit" — which an agent must not do unprompted — so the nudge
// could not be discharged by anything the agent was allowed to do.
//
// Rather than special-case that one nudge, the rule applies to all of them:
// each distinct message is delivered ONCE per session. Because every nudge
// renders its own state into its text (which files, how many), a real change
// produces different text and speaks again. Unchanged state stays quiet.
//
// NEVER THROWS. This runs on the Stop path; if the marker cannot be persisted
// the honest degradation is to deliver the nudge (possibly again), never to
// turn a reflection into an error.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "stop-nudges";
/** Session ids come from the runner and reach the filesystem; cap the segment
 *  well under every platform's per-component limit. */
const MAX_SESSION_SEGMENT = 120;

/**
 * Identity of a nudge, ignoring the numbers inside it.
 *
 * Hashing the raw text was not enough: several nudges carry a running COUNT
 * ("11 workaround signal(s)" → "12 workaround signal(s)"), so the text changed
 * every turn and the suppressor dutifully let each one through. From the
 * reader's side that is the same sentence forever — a ticking counter is not
 * news. Digit runs are therefore normalised away, so "N of the same thing"
 * speaks once.
 *
 * Anything that is genuinely a different nudge differs by more than digits: a
 * different file list, rule id, or wording all survive normalisation and speak
 * again.
 */
function keyOf(nudge: string): string {
	const shape = nudge.replace(/\d+/g, "#");
	return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}

/** Session ids reach the filesystem; keep them to one path segment. */
function safeSession(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_SESSION_SEGMENT) || "unknown";
}

function markerPath(projectRoot: string, sessionId: string): string {
	return join(projectRoot, ".interlinked", DIR, `${safeSession(sessionId)}.json`);
}

/** The marker file's only legal shape: an array of hash strings. Anything else
 *  is treated as absent rather than trusted. */
function parseSeen(raw: unknown): Set<string> {
	if (!Array.isArray(raw)) return new Set();
	return new Set(raw.filter((k): k is string => typeof k === "string"));
}

function readSeen(path: string): Set<string> {
	try {
		if (!existsSync(path)) return new Set();
		return parseSeen(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// A corrupt marker must not silence nudges: an unreadable set is treated as
		// empty, so everything counts as unsaid and the agent still hears it.
		return new Set();
	}
}

/** Persist the told-set. Failure is tolerable — see `suppressRepeatedNudges`. */
function rememberSeen(projectRoot: string, path: string, seen: Set<string>): void {
	try {
		mkdirSync(join(projectRoot, ".interlinked", DIR), { recursive: true });
		writeFileSync(path, JSON.stringify([...seen]));
	} catch (err) {
		// Repeating a nudge is a smaller failure than swallowing one the agent has
		// never seen, so the write failure is deliberately non-fatal and quiet:
		// this is the Stop path, and stderr here becomes agent-visible noise.
		void err;
	}
}

/** Who is being nudged. A struct because two bare strings were swappable at the
 *  call site, and swapping them would silently key every session off the repo
 *  path — one shared told-set for every agent. */
export interface NudgeScope {
	projectRoot: string;
	sessionId: string;
}

/**
 * Drop nudges this session has already been told, and remember the rest.
 *
 * Returns the messages to deliver, in their original order. Suppression is per
 * (session, exact text).
 */
export function suppressRepeatedNudges(
	scope: NudgeScope,
	nudges: readonly string[],
): string[] {
	const { projectRoot, sessionId } = scope;
	if (nudges.length === 0) return [];
	const path = markerPath(projectRoot, sessionId);
	const seen = readSeen(path);

	const fresh: string[] = [];
	for (const n of nudges) {
		const k = keyOf(n);
		if (seen.has(k)) continue;
		seen.add(k);
		fresh.push(n);
	}
	if (fresh.length === 0) return [];

	rememberSeen(projectRoot, path, seen);
	return fresh;
}
