// timing-flake — detects a test that waits a FIXED duration and then asserts on
// work that finishes on someone else's schedule.
//
// Bug class: `await sleep(300)` followed by `expect(...)` encodes a guess about
// how long a subprocess / timer / async pipeline needs. The guess holds on an
// idle laptop and fails on a loaded CI box or under a parallel test run — so the
// test passes in isolation, which is exactly what makes it survive triage ("ran
// it 3x, can't reproduce, must be a flake") and keep failing in the suite.
//
// Measured provenance (interlinked-cli, 2026-08-05/06): two instances, both
// found only because a full-suite coverage run went red and vitest then emitted
// NO coverage report at all — one flaky test cost the entire measurement, twice.
//   * `tsgo-runner-watch.test.ts` — `await sleep(300)` then asserted on a real
//     spawned subprocess's parsed stdout. Passed 3x standalone; failed twice
//     under a 4-worker coverage run.
//   * `trajectory/helpers.test.ts` — a single timing sample per input size, then
//     a ratio assertion. One GC pause in the larger sample pushed a perfectly
//     linear function to a 15.7x measured ratio against a threshold of 8.
//
// The fix in both cases is to stop encoding a duration: poll until the condition
// holds with a generous ceiling (the ceiling then bounds only FAILURE, never
// success), or take a best-of-N sample for timing comparisons. Both are fast on
// an idle box and correct on a loaded one.
//
// Check id: `timing_flake`. Advisory: a fixed sleep is legitimate when a test is
// deliberately exercising elapsed-time behavior (debounce windows, TTL expiry),
// so this is a taste signal for review rather than a gate.

import type { InlineMatch } from "./shared.js";

/** A wait on a hardcoded duration: `await sleep(300)`, `await delay(1_000)`,
 *  `await new Promise(r => setTimeout(r, 250))`, `await wait(50)`. A duration
 *  read from a named constant is NOT matched — that is usually a deliberate,
 *  documented window rather than a guess. */
const FIXED_WAIT_RE =
	/await\s+(?:sleep|delay|wait|pause)\s*\(\s*[\d_]+\s*\)|setTimeout\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[\d_]+\s*\)/;

/** An assertion — the thing whose correctness the wait is standing in for. */
const ASSERTION_RE = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/;

/** Polling / condition-waiting forms that make a wait safe: the test re-checks
 *  until the condition holds instead of assuming one duration is enough. */
const POLL_RE =
	/while\s*\(|for\s*\(\s*;|waitFor|pollUntil|until\s*\(|vi\.waitFor|retry\s*\(|Date\.now\(\)\s*[<>]/;

/** Fake-timer control means elapsed time is deterministic, so a fixed advance is
 *  exact rather than a guess. */
const FAKE_TIMERS_RE = /useFakeTimers|advanceTimersBy|setSystemTime|runAllTimers|vi\.advanceTimers/;

/** Waits at or below this many ms are too short to be a scheduling guess — they
 *  are typically a yield to the microtask queue / event loop tick. */
const YIELD_CEILING_MS = 10;

const MAX_MATCHES = 5;

/** Extract the numeric duration from a matched wait, or null when unreadable. */
function durationOf(line: string): number | null {
	const m = /(?:sleep|delay|wait|pause)\s*\(\s*([\d_]+)\s*\)|setTimeout\s*\([^,]+,\s*([\d_]+)\s*\)/.exec(
		line,
	);
	const raw = m?.[1] ?? m?.[2];
	if (raw === undefined) return null;
	const n = Number.parseInt(raw.replace(/_/g, ""), 10);
	return Number.isFinite(n) ? n : null;
}

/** What follows a wait, within the enclosing test body. `asserts` is whether the
 *  wait is standing in for a real check; `polls` is whether the test re-checks
 *  instead of trusting the duration. */
interface LookaheadVerdict {
	asserts: boolean;
	polls: boolean;
}

/**
 * Scan forward from a wait to the end of its enclosing test body, stopping at a
 * body-closing line or the next `it(`/`test(` so a sleep in one test is never
 * blamed for an assertion in the next.
 */
function scanAfterWait(lines: string[], start: number, waitLine: string): LookaheadVerdict {
	let polls = POLL_RE.test(waitLine);
	for (let j = start; j < lines.length; j++) {
		const ahead = lines[j] ?? "";
		if (/^\s*(?:it|test)\s*[(.]/.test(ahead) || /^\s*\}\s*\)\s*;?\s*$/.test(ahead)) break;
		if (POLL_RE.test(ahead)) polls = true;
		if (ASSERTION_RE.test(ahead)) return { asserts: true, polls };
	}
	return { asserts: false, polls };
}

/** How many lines above a wait to inspect for polling context. A poll loop puts
 *  its condition BEFORE the wait (`while (…) { await sleep(25) }`), so a
 *  forward-only scan misclassifies the safest possible pattern as the bug —
 *  found by this check's own N1 case on first run. */
const POLL_LOOKBEHIND = 4;

/** True when the wait sits inside a loop that re-checks a condition, which is
 *  the correct pattern rather than the bug. */
function insidePollLoop(lines: string[], waitIndex: number): boolean {
	const from = Math.max(0, waitIndex - POLL_LOOKBEHIND);
	for (let j = from; j < waitIndex; j++) {
		if (POLL_RE.test(lines[j] ?? "")) return true;
	}
	return false;
}

/** True when this line is a duration guess rather than an event-loop yield. */
function isSchedulingGuess(line: string): boolean {
	if (!FIXED_WAIT_RE.test(line)) return false;
	const ms = durationOf(line);
	return ms === null || ms > YIELD_CEILING_MS;
}

/**
 * Flag a fixed-duration wait that is followed by an assertion inside the same
 * test body, with no polling and no fake timers.
 *
 * Scoped to test files only — a fixed sleep in production code is a different
 * (and often legitimate) concern. Returns at most {@link MAX_MATCHES} findings.
 *
 * check id: `timing_flake`
 */
export function checkTimingFlake(content: string, filePath: string): InlineMatch[] {
	if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)) return [];
	// A file that controls the clock is measuring elapsed time deliberately.
	if (FAKE_TIMERS_RE.test(content)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const line = lines[i] ?? "";
		if (!isSchedulingGuess(line)) continue;

		if (insidePollLoop(lines, i)) continue;

		const { asserts, polls } = scanAfterWait(lines, i + 1, line);
		if (!asserts || polls) continue;

		const ms = durationOf(line);
		matches.push({
			line: i + 1,
			text: `fixed ${ms ?? "?"}ms wait before an assertion — passes on an idle box, fails under load; poll for the condition instead`.slice(
				0,
				200,
			),
		});
	}

	return matches;
}
