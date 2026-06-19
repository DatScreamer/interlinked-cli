// interlinked-tdd: exempt
// ===========================================
// Interlinked Harness — Behavioral Checks (prod/test LOC ratio gate)
// ===========================================
// The git-diff-based prod/test LOC ratio commit gate and its numstat-driven
// delta computation, split out of `behavioral-checks-tdd.ts` to keep each
// module under the per-file line cap; the public API is re-exported from
// `behavioral-checks-tdd.ts` (and onward from `behavioral-checks.ts`) so all
// importers are unchanged.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";
import { isCodeFile } from "./verification-stop-checks.js";

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

const PROD_TEST_LOC_RATIO_LIMIT = 5;

/** Lines added + deleted, split by prod vs test path. */
export interface LocDelta {
	prodLoc: number;
	testLoc: number;
}

/**
 * Compute LOC delta covering BOTH tracked changes (`git diff --numstat HEAD`)
 * AND untracked-but-not-ignored files (counted at full line count, since
 * they're entirely new). Counts added + deleted for tracked files so a
 * 50-line refactor registers as 100 churn — that's what the ratio gate
 * cares about (proportional test coverage of touched code).
 *
 * Three-bucket classification: a path counts toward testLoc if it matches
 * the test convention, prodLoc if it's a known code-file extension, and
 * is dropped otherwise. The third bucket exists because the previous
 * bipartite split routed every non-test path into prodLoc — docs
 * (CLAUDE.md), JSON data, lockfiles, and shell-script bootstraps then
 * tripped the "wrote N lines of production code with no tests" warning
 * on doc-only sessions. `isCodeFile` is the shared positive predicate
 * used by the Stop-event verification nudges.
 *
 * The untracked path matters because `git diff` doesn't see new files
 * before they're staged, and the gate fires at PreToolUse time on
 * `git add ... && git commit ...` — before staging happens. Without
 * untracked accounting, a brand-new test file wouldn't count.
 *
 * Returns zeroes on any failure (not in a repo, no HEAD, git missing).
 */
export function gitNumstatDelta(cwd: string = process.cwd()): LocDelta {
	let prodLoc = 0;
	let testLoc = 0;
	try {
		const numstat = execSync("git diff --numstat HEAD", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const line of numstat.split("\n")) {
			const parts = line.split("\t");
			if (parts.length < 3) continue;
			const added = Number.parseInt(parts[0], 10);
			const deleted = Number.parseInt(parts[1], 10);
			if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
			const path = parts[2];
			const delta = added + deleted;
			if (TEST_FILE_RE.test(path)) testLoc += delta;
			else if (isCodeFile(path)) prodLoc += delta;
			// else: docs, JSON data, lockfiles, etc. — not "production code"
		}
		const untracked = execSync("git ls-files --others --exclude-standard", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const path of untracked.split("\n")) {
			if (!path) continue;
			if (!TEST_FILE_RE.test(path) && !isCodeFile(path)) continue;
			try {
				const content = readFileSync(join(cwd, path), "utf-8");
				const loc = content.split("\n").length;
				if (TEST_FILE_RE.test(path)) testLoc += loc;
				else prodLoc += loc;
			} catch {
				// intentional: best-effort read; skip an unreadable untracked file.
			}
		}
	} catch {
		// intentional: git unavailable / not a repo / no HEAD — fall back to 0
	}
	return { prodLoc, testLoc };
}

/**
 * Commit gate: flag when prod LOC delta exceeds test LOC delta by more than
 * PROD_TEST_LOC_RATIO_LIMIT × — measured against `git diff HEAD`, NOT against
 * file totals. Touching a 1000-line file with a 2-line edit contributes 2 to
 * the delta, not 1000. The previous file-total approach made the gate fire
 * on any session that brushed a large file, even when the actual change was
 * small and well-tested.
 */
export function checkProdTestLocRatio(
	session: SessionTrajectory,
	getDelta: () => LocDelta = gitNumstatDelta,
): CheckResultEntry[] {
	void session; // signature kept for symmetry with other commit gates
	const { prodLoc, testLoc } = getDelta();
	if (testLoc === 0 && prodLoc === 0) return [];
	if (testLoc === 0) {
		return [
			{
				source: "structural",
				name: "prod_test_loc_ratio",
				severity: "warning",
				message: `Wrote ${prodLoc} lines of production code this session with no tests written. Add tests before committing.`,
				file: "<session>",
				determinism: "heuristic",
			},
		];
	}
	const ratio = prodLoc / testLoc;
	if (ratio > PROD_TEST_LOC_RATIO_LIMIT) {
		return [
			{
				source: "structural",
				name: "prod_test_loc_ratio",
				severity: "warning",
				message: `Prod/test LOC ratio is ${ratio.toFixed(1)}:1 (limit ${PROD_TEST_LOC_RATIO_LIMIT}:1). Production code is growing faster than test coverage.`,
				file: "<session>",
				determinism: "heuristic",
			},
		];
	}
	return [];
}
