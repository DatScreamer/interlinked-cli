// interlinked-tdd: exempt — tested via behavioral-diff-checks.test.ts
// Diff-aware behavioral checks (Batch 3) — test-timeout inflation detector.
//
// Sibling of behavioral-diff-checks.ts (own module to keep the entry file
// under the per-file line cap; re-exported from there).
//
// An EXISTING timeout literal got RAISED in the staged diff — the test-side
// analog of loosening a ratchet baseline: instead of fixing the slow/flaky
// behavior, the agent buys more wall-clock. Covers three literal shapes:
//   - options object:  it("x", { timeout: 5000 }, ...)   → `timeout: N`
//   - third argument:  it("x", async () => {...}, 5000)  → `}, N)` close
//   - global config:   vi.setConfig({ testTimeout: N }) / vitest config
// Pairing is per-hunk, per-shape, in order of appearance: a removed literal
// with a larger added counterpart of the same shape fires. Pure additions
// (brand-new test with a timeout, brand-new file) have no removed
// counterpart and never fire; decreases and unchanged context lines never
// fire.

import { nonNull } from "../lib/non-null.js";
import { getStagedDiff } from "./behavioral-checks.js";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

function basename(p: string): string {
	return p.split("/").pop() || p;
}

type TimeoutKind = "options_timeout" | "third_arg" | "test_timeout_config";

const TIMEOUT_KIND_LABEL: Record<TimeoutKind, string> = {
	options_timeout: "{ timeout: N } option",
	third_arg: "it()/test() third-arg timeout",
	test_timeout_config: "testTimeout config",
};

// `testTimeout:` is matched first; the plain `timeout:` pattern stays
// disjoint from it because `\btimeout` is word-bounded and case-sensitive —
// it cannot match inside `testTimeout`. Underscore separators (`30_000`)
// are accepted.
const TEST_TIMEOUT_CONFIG_RE = /\btestTimeout\s*:\s*(\d[\d_]*)\b/;
const OPTIONS_TIMEOUT_RE = /\btimeout\s*:\s*(\d[\d_]*)\b/;
// Closing shape of a test callback with a trailing timeout arg: `}, 30000);`
const THIRD_ARG_CLOSE_RE = /^\s*\}\s*,\s*(\d[\d_]*)\s*\)/;

function parseTimeoutLiteral(raw: string): number {
	return Number.parseInt(raw.replace(/_/g, ""), 10);
}

/** Extract every timeout literal on one diff-line body (kind + ms value). */
function extractTimeoutLiterals(body: string): Array<{ kind: TimeoutKind; ms: number }> {
	const out: Array<{ kind: TimeoutKind; ms: number }> = [];
	const config = TEST_TIMEOUT_CONFIG_RE.exec(body);
	if (config) out.push({ kind: "test_timeout_config", ms: parseTimeoutLiteral(nonNull(config[1])) });
	const options = OPTIONS_TIMEOUT_RE.exec(body);
	if (options) out.push({ kind: "options_timeout", ms: parseTimeoutLiteral(nonNull(options[1])) });
	const thirdArg = THIRD_ARG_CLOSE_RE.exec(body);
	if (thirdArg) out.push({ kind: "third_arg", ms: parseTimeoutLiteral(nonNull(thirdArg[1])) });
	return out;
}

interface TimeoutInflation {
	kind: TimeoutKind;
	before: number;
	after: number;
}

/** Collect removed/added timeout literals from one hunk, keyed by kind. */
function collectHunkTimeouts(hunk: string): {
	removed: Map<TimeoutKind, number[]>;
	added: Map<TimeoutKind, number[]>;
} {
	const removed = new Map<TimeoutKind, number[]>();
	const added = new Map<TimeoutKind, number[]>();
	for (const line of hunk.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		const side = line.startsWith("+") ? added : line.startsWith("-") ? removed : null;
		if (!side) continue;
		for (const lit of extractTimeoutLiterals(line.slice(1))) {
			const bucket = side.get(lit.kind) ?? [];
			bucket.push(lit.ms);
			side.set(lit.kind, bucket);
		}
	}
	return { removed, added };
}

/** Per-hunk, per-kind index pairing of removed→added timeout literals. */
function findHunkInflations(hunk: string): TimeoutInflation[] {
	const { removed, added } = collectHunkTimeouts(hunk);
	const inflations: TimeoutInflation[] = [];
	for (const [kind, before] of removed) {
		const after = added.get(kind) ?? [];
		for (let i = 0; i < Math.min(before.length, after.length); i++) {
			const b = nonNull(before[i]);
			const a = nonNull(after[i]);
			if (a > b) inflations.push({ kind, before: b, after: a });
		}
	}
	return inflations;
}

/** Public API — flags raised test-timeout literals in staged test-file diffs. */
export function checkTestTimeoutInflation(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		// Split into hunks so removed/added literals are paired locally — a
		// timeout deleted in one test never pairs with one added elsewhere.
		const hunks = diff.split(/^@@.*$/m).slice(1);
		for (const hunk of hunks) {
			for (const inf of findHunkInflations(hunk)) {
				results.push({
					source: "structural",
					name: "test_timeout_inflation",
					severity: "warning",
					message: `${basename(file)} raises an existing test timeout ${inf.before}ms → ${inf.after}ms (${TIMEOUT_KIND_LABEL[inf.kind]}). Raising the timeout hides slowness/flakiness instead of fixing it — profile the test or fix the race, and only raise the timeout with a comment explaining why the operation is legitimately slow.`,
					file,
					determinism: "heuristic",
				});
			}
		}
	}
	return results;
}
