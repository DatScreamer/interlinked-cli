// ===========================================
// Cross-process project heavyweight-work lease
// ===========================================
// Whole-project verification, affected-test runs, and external check batches
// can each retain substantial process memory. Independent agent processes must
// not overlap those workloads for the same checkout. This lease deliberately
// uses a different key namespace from the compiler lease: a heavyweight owner
// may invoke tsc while it holds this lease without recursively contending with
// itself for the compiler-specific lock.

import {
	canonicalProjectRoot,
	tryAcquireCrossProcessCompilerLease,
} from "./project-compiler-lock.js";

const HEAVY_PROJECT_KEY_PREFIX = "interlinked-heavy-process-v1\0";

/**
 * Attempt once, without queueing, to own heavyweight work for a project.
 *
 * Returns an idempotent release callback on success and `null` when another
 * process already owns the project lane. The underlying atomic-directory
 * primitive also recovers locks whose owner process has exited.
 */
export function tryAcquireProjectHeavyProcessLease(projectRoot: string): (() => void) | null {
	const projectKey = `${HEAVY_PROJECT_KEY_PREFIX}${canonicalProjectRoot(projectRoot)}`;
	return tryAcquireCrossProcessCompilerLease(projectKey)?.release ?? null;
}
