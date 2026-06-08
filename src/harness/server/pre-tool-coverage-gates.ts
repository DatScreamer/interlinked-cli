// ===========================================
// PreToolUse pipeline — coverage / commit gate phases
// ===========================================
// The two config-gated (DEFAULT OFF) coverage phase helpers, extracted from
// `pre-tool-pipeline.ts` so the orchestrator stays under the per-file line cap.
// Both gate on `rules.per_edit_coverage.enabled` and short-circuit the pipeline
// with a block decision when they fire:
//
//   - runCoverageWriteGate — the per-EDIT gate. On a code-file Write/Edit it
//     applies the proposed content to an apply-before-disk overlay, runs the
//     suite under coverage there, and blocks an uncovered added line / coverage
//     drop / (opt-in) red bar / (opt-in) CRAP. See `coverage-write-guard.ts`.
//   - runCommitGate — the COMMIT-TIME gate. On a real `git commit` Bash call it
//     runs the FULL suite + coverage on the working tree and blocks a red bar /
//     uncovered changed line / CRAP-over / cyclomatic-over. The hard gate for
//     repos whose suite is too big for per-edit enforcement. See `commit-gate.ts`.
//
// Both are pure no-ops when the feature is off; `checkCommitGate` is additionally
// a no-op for non-commit Bash, so an opted-in repo pays the commit cost only on
// an actual `git commit`. Neither throws (each underlying check fails open).

import { resolveDependencyView, type DependencyView } from "../dependency-view.js";
import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";

/**
 * Build the {@link DependencyView} for the file an edit touches, REUSING the same
 * `ProjectGraph` the daemon already holds (lazily built + cached per project root)
 * and the same `resolveDependencyView` seam PostToolUse impact analysis uses — no
 * second graph is constructed. The view powers affected-test selection inside
 * `checkCoverageWrite`. Returns undefined (→ full-suite fallback) for a non-file
 * event or on any failure: the selector must never run a wrong subset, so an
 * absent view is the safe default.
 */
function depViewForEvent(ctx: ServerRuntime, event: HarnessEvent): DependencyView | undefined {
	const filePath = (event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
	if (!filePath) return undefined;
	try {
		const graph = getGraphForFile(ctx, filePath);
		return resolveDependencyView(filePath, ctx.cwd, graph);
	} catch {
		return undefined;
	}
}

/**
 * Per-edit coverage gate (config-gated, DEFAULT OFF). The expensive,
 * apply-before-disk overlay+suite check — placed AFTER the synchronous
 * `evaluatePreToolUse` cheap checks. Runs only when the pre-decision is `allow`
 * (a block already short-circuited) and `rules.per_edit_coverage.enabled` is
 * true; `checkCoverageWrite` itself is a pure no-op otherwise, so a repo that
 * does not opt in pays zero cost. On a coverage block, returns a block decision
 * carrying any warnings already accumulated; else null (continue → allow). Never
 * throws (the guard fails open internally).
 */
export async function runCoverageWriteGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	if (preDecision.decision !== "allow") return null;
	if (!ctx.rules.per_edit_coverage?.enabled) return null; // fast path: default OFF
	// Source the dependency view from the daemon's existing graph so the gate can
	// select only the affected tests (fast → fits the per-edit budget → enforces).
	const coverageBlock = await checkCoverageWrite(event, ctx.rules, undefined, depViewForEvent(ctx, event));
	if (!coverageBlock) return null;
	if (preDecision.warnings && preDecision.warnings.length > 0) {
		coverageBlock.warnings = preDecision.warnings;
	}
	return coverageBlock;
}

/**
 * Commit-time quality gate (config-gated, DEFAULT OFF). Intercepts a real
 * `git commit` Bash call and runs the FULL suite + coverage on the working tree,
 * BLOCKING the commit on a red bar / uncovered changed line / CRAP-over /
 * cyclomatic-over. This is the hard gate for repos whose suite is too big for the
 * per-edit `runCoverageWriteGate` (they defer per-edit and enforce here instead).
 * Placed AFTER the cheap synchronous checks, like the per-edit gate, and gated on
 * the SAME `per_edit_coverage.enabled` flag — `checkCommitGate` is itself a pure
 * no-op for non-commit commands, so a repo that has opted into coverage pays this
 * cost only on an actual `git commit`. Returns a block carrying any accumulated
 * warnings, or null (continue). Never throws (the gate fails open internally).
 */
export async function runCommitGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	if (preDecision.decision !== "allow") return null;
	if (event.tool_name !== "Bash") return null; // only the Bash path can carry a commit
	if (!ctx.rules.per_edit_coverage?.enabled) return null; // fast path: default OFF
	const commitDecision = await checkCommitGate(event, ctx.rules);
	if (!commitDecision) return null;
	// Merge any warnings already accumulated on the running decision (e.g. the
	// evaluator's) ahead of the gate's own (e.g. the `--no-verify` note).
	if (preDecision.warnings && preDecision.warnings.length > 0) {
		commitDecision.warnings = [...preDecision.warnings, ...(commitDecision.warnings ?? [])];
	}
	return commitDecision;
}
