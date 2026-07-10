// ===========================================
// Skipped-tests water-line — policy module
// ===========================================
// Bun's Rust-rewrite merge bar was "0 tests skipped or deleted"
// (docs/external-pulse/bun-in-rust.md §2.5). Every other ratchet has a
// committed water-line protected by baseline_integrity_gate; the test suite —
// the oracle every ratchet ultimately depends on — had none, so skips could
// drift up one commit at a time across sessions
// (docs/design/test-oracle-integrity.md §4.2).
//
// Shape mirrors large-files-baseline.json (the established grandfather
// pattern): a global tighten-only cap plus a shrink-only per-file grandfather
// list whose goal end-state is empty. Counting rules are EXACTLY
// countSkippedTests (test-skip-markers.ts) — the baseline and the
// disabled_tests check can never disagree about what a "skip" is.
//
// Direction contract (enforced by detectSkippedTests in
// evaluator/baseline-integrity-gate.ts):
//   - max_skipped may only SHRINK
//   - a grandfather count may only SHRINK
//   - a NEW grandfather entry above max_skipped is blocked

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SKIPPED_TESTS_BASELINE_REL = ".interlinked/skipped-tests-baseline.json";

export interface SkippedTestsBaseline {
	version: 1;
	/** Max unconditional skips any non-grandfathered file may carry. Tighten-only. */
	max_skipped: number;
	/** Grandfather list: recorded skip ceiling per offender. Shrink-only. */
	files: Record<string, number>;
}

export function emptySkippedTestsBaseline(): SkippedTestsBaseline {
	return { version: 1, max_skipped: 0, files: {} };
}

/** Fail-soft loader: missing or malformed baseline reads as null (no policy). */
export function loadSkippedTestsBaseline(projectRoot: string): SkippedTestsBaseline | null {
	const path = join(projectRoot, SKIPPED_TESTS_BASELINE_REL);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SkippedTestsBaseline>;
		if (!raw || raw.version !== 1 || typeof raw.max_skipped !== "number") return null;
		const files =
			raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)
				? (raw.files as Record<string, number>)
				: {};
		return { version: 1, max_skipped: raw.max_skipped, files };
	} catch {
		return null;
	}
}

/** Effective skip ceiling for one file: its grandfather entry, else the global cap. */
export function maxSkippedFor(baseline: SkippedTestsBaseline | null, relPath: string): number {
	if (!baseline) return emptySkippedTestsBaseline().max_skipped;
	return baseline.files[relPath] ?? baseline.max_skipped;
}
