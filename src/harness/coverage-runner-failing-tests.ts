// interlinked-tdd: exempt
// ===========================================
// CoverageRunner — failing-test name parsing + attachment helpers
// ===========================================
// Pure text/result helpers extracted from coverage-runner.ts (leaf cluster):
//   - best-effort failing-test name parsing from vitest / pytest output;
//   - trim/de-dupe/cap of those names;
//   - attaching them to a CoverageRunResult only when the run is RED.
// These are message sugar only — the suite EXIT CODE owns the pass/fail
// decision; missing names never affect it.

import type { CoverageRunResult } from "./coverage-runner.js";

/** Cap on failing-test names captured for a block message (sugar, not data). */
const MAX_FAILING_TEST_NAMES = 5;

/**
 * Best-effort parse of failing test names from vitest text output. vitest's
 * default reporter prints failing cases as `FAIL  <file> > <suite> > <test>`
 * (or `❯`/`×`-prefixed rows in some renderers). We take the ` > `-tail when
 * present, else the trailing path/segment — purely message sugar; missing names
 * never affect the pass/fail decision (the exit code owns that).
 */
export function parseVitestFailingTests(text: string): string[] {
	const names: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:FAIL|×|✗|❯)\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		const label = m[1];
		if (!label) continue;
		const arrow = label.lastIndexOf(" > ");
		names.push(arrow >= 0 ? label.slice(arrow + 3).trim() : label.trim());
	}
	return names;
}

/**
 * Best-effort parse of failing test ids from pytest text output. pytest prints
 * each failure as `FAILED <nodeid>[ - <message>]` in its short-test-summary, and
 * `<nodeid> ... FAILED` in default verbosity. We capture the nodeid in either
 * shape — message sugar only; the exit code owns the pass/fail decision.
 */
export function parsePytestFailingTests(text: string): string[] {
	const names: string[] = [];
	for (const line of text.split("\n")) {
		const summary = /^FAILED\s+(\S+)/.exec(line);
		if (summary?.[1]) {
			names.push(summary[1]);
			continue;
		}
		const inline = /^(\S+::\S+)\s+FAILED\b/.exec(line);
		if (inline?.[1]) names.push(inline[1]);
	}
	return names;
}

/** Trim, de-dupe, and cap a parsed failing-test name list. */
function dedupeCap(names: string[]): string[] {
	const seen = new Set<string>();
	for (const raw of names) {
		const name = raw.trim();
		if (name) seen.add(name);
		if (seen.size >= MAX_FAILING_TEST_NAMES) break;
	}
	return [...seen];
}

/**
 * Attach `failingTests` to a result only when the run is RED and at least one
 * name was parsed. Keeps `failingTests` absent (per exactOptionalPropertyTypes)
 * for green / indeterminate runs and for red runs with no parseable names.
 */
export function withFailingTests(result: CoverageRunResult, names: string[]): CoverageRunResult {
	if (result.testsPassed !== false) return result;
	const capped = dedupeCap(names);
	if (capped.length === 0) return result;
	return { ...result, failingTests: capped };
}
