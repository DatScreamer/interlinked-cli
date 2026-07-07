// ===========================================
// PreToolUse pipeline — coverage / commit gate phases
// ===========================================
// The two config-gated coverage phase helpers, extracted from
// `pre-tool-pipeline.ts` so the orchestrator stays under the per-file line cap.
// Shipped default is ON — all four test-quality gates (coverage, red/green,
// CRAP, cyclomatic) enforce out of the box since 2026-06; a repo opts out via
// `.interlinked/guard-rules.local.json` (`"per_edit_coverage": { "enabled":
// false }`). Both gate on `rules.per_edit_coverage.enabled` and short-circuit
// the pipeline with a block decision when they fire:
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
// The phase helpers remain pure no-ops when the feature is disabled;
// `checkCommitGate` is additionally a no-op for non-commit Bash, so an enabled
// repo pays the commit cost only on an actual `git commit`. Neither throws
// (each underlying check fails open).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
} from "../apply-patch-content.js";
import { applyDebtMode } from "../coverage-debt-gate.js";
import { type DependencyView, resolveDependencyView } from "../dependency-view.js";
import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { runPerEditMutationGate } from "../mutation/gate.js";
import { emptyManifest, loadManifest, makeManifestPersister } from "../mutation/manifest.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";

/**
 * The file an edit event touches, for dependency-view resolution: the named
 * `file_path`/`path` for ordinary writes, or the FIRST section path of an
 * `apply_patch` payload (whose paths live in the patch body, never in
 * `file_path`). Without the patch branch, apply_patch events never got a view
 * and so could never take the scoped affected-test route (finding 2026-06).
 * Any patch path works as the seed: the internal backend wraps the whole
 * ProjectGraph (`answerScope: "repo"`), so the one view answers for every
 * target in the patch; a per-file Supermodel view is seed-only and the
 * selector falls back to the full suite for it regardless of seed choice.
 */
function editedFileForEvent(event: HarnessEvent): string | undefined {
	const input = event.tool_input ?? {};
	const named = (input.file_path as string) || (input.path as string) || "";
	if (named) return named;
	const raw = extractApplyPatchRaw(input);
	if (!raw || !looksLikeApplyPatch(raw)) return undefined;
	const first = parseApplyPatchSections(raw)[0];
	if (!first) return undefined;
	return resolve(event.cwd || process.cwd(), first.path);
}

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
	const filePath = editedFileForEvent(event);
	if (!filePath) return undefined;
	try {
		const graph = getGraphForFile(ctx, filePath);
		return resolveDependencyView(filePath, ctx.cwd, graph);
	} catch {
		return undefined;
	}
}

/**
 * Per-edit coverage gate (config-gated; shipped default is ON — all four
 * test-quality gates enforce out of the box since 2026-06, and a repo opts out
 * via guard-rules.local.json). The expensive, apply-before-disk overlay+suite
 * check — placed AFTER the synchronous `evaluatePreToolUse` cheap checks. Runs
 * only when the pre-decision is `allow` (a block already short-circuited) and
 * `rules.per_edit_coverage.enabled` is true; `checkCoverageWrite` itself is a
 * pure no-op otherwise, so an opted-out repo pays zero cost.
 *
 * The guard returns one of three shapes, each propagated to the agent:
 *   - a `block` → returned (short-circuits the pipeline), merging any warnings
 *     already accumulated on the running decision.
 *   - an `allow` WITH warnings → the fail-LOUD degrade path (no coverage provider,
 *     runner error, …). Its warning MUST reach the agent, so we MERGE it onto
 *     `preDecision.warnings` and return null (continue the pipeline). The old code
 *     `return null`-ed on any non-block and dropped these — the silent-fail-open
 *     bug this fixes. Merging-and-continuing (vs returning the allow, which would
 *     short-circuit) keeps every downstream pipeline phase running while still
 *     surfacing the warning, since `preDecision` is what the pipeline returns and
 *     an allow-decision's `warnings` ride to the agent via the adapter.
 *   - `null` (clean / budget-deferred) → null (continue).
 *
 * Never throws (the guard fails open internally).
 */
export async function runCoverageWriteGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	if (preDecision.decision !== "allow") return null;
	const coverageCfg = ctx.rules.per_edit_coverage;
	if (!coverageCfg?.enabled) return null; // fast path: repo opted out (shipped default is ON)
	// Source the dependency view from the daemon's existing graph so the gate can
	// select only the affected tests (fast → fits the per-edit budget → enforces).
	let decision = await checkCoverageWrite(event, ctx.rules, undefined, depViewForEvent(ctx, event));
	// Pair-scoped debt lifecycle (a pure no-op unless `per_edit_coverage.debt_mode`
	// is on): downgrades a first uncovered-line block to opened debt, blocks a
	// wander to an unrelated file, discharges on a companion-test edit.
	decision = applyDebtMode(event, coverageCfg, decision);
	if (!decision) return null;

	if (decision.decision === "block") {
		// Carry forward any warnings already on the running decision (e.g. the
		// evaluator's) ahead of the block's own, if any.
		decision.warnings = mergeWarnings(preDecision.warnings, decision.warnings);
		return decision;
	}

	// Fail-LOUD allow: don't drop the coverage warning. Merge it onto the running
	// decision and continue — the pipeline returns `preDecision`, and an
	// allow-decision's warnings reach the agent (Claude Code → additionalContext).
	if (decision.warnings && decision.warnings.length > 0) {
		preDecision.warnings = mergeWarnings(preDecision.warnings, decision.warnings);
	}
	return null;
}

/** Concatenate two optional warning lists, dropping empties; undefined when both empty. */
function mergeWarnings(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	const merged = [...(a ?? []), ...(b ?? [])];
	return merged.length > 0 ? merged : undefined;
}

/**
 * Commit-time quality gate (config-gated; shipped default is ON since 2026-06 —
 * a repo opts out via guard-rules.local.json). Intercepts a real
 * `git commit` Bash call and runs the FULL suite + coverage on the working tree,
 * BLOCKING the commit on a red bar / uncovered changed line / CRAP-over /
 * cyclomatic-over. This is the hard gate for repos whose suite is too big for the
 * per-edit `runCoverageWriteGate` (they defer per-edit and enforce here instead).
 * Placed AFTER the cheap synchronous checks, like the per-edit gate, and gated on
 * the SAME `per_edit_coverage.enabled` flag — `checkCommitGate` is itself a pure
 * no-op for non-commit commands, so a coverage-enabled repo pays this
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
	if (!ctx.rules.per_edit_coverage?.enabled) return null; // fast path: repo opted out (shipped default is ON)
	const commitDecision = await checkCommitGate(event, ctx.rules);
	if (!commitDecision) return null;
	// Merge any warnings already accumulated on the running decision (e.g. the
	// evaluator's) ahead of the gate's own (e.g. the `--no-verify` note).
	if (preDecision.warnings && preDecision.warnings.length > 0) {
		commitDecision.warnings = [...preDecision.warnings, ...(commitDecision.warnings ?? [])];
	}
	return commitDecision;
}

function readDiskSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

const MUTATION_PLACEHOLDER_META = {
	engine: "stryker",
	engineVersion: "0",
	dependencyGraphVersion: "0",
	environmentHash: "0",
	authoritativeAt: new Date(0).toISOString(),
};

/**
 * Per-edit mutation gate (config-gated, DEFAULT OFF; spec §4 / §12). A no-op
 * unless `per_edit_mutation.enabled`. The runner is null until the cloud Sandbox
 * runner is wired, so an opted-in repo honestly gets `[mutation:not-measured]`
 * rather than a forged clean pass. Never throws (the gate fails open internally).
 */
export async function runMutationWriteGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	if (preDecision.decision !== "allow") return null;
	const cfg = ctx.rules.per_edit_mutation;
	if (!cfg?.enabled) return null; // fast path: default OFF
	const interlinkedDir = resolve(ctx.cwd, ".interlinked");
	const baseManifest = loadManifest(interlinkedDir) ?? emptyManifest(MUTATION_PLACEHOLDER_META);
	// Wire the cloud Sandbox runner when a URL is configured; a lazy dynamic import
	// keeps it off the default-off hot path. Absent URL → null → honest not-measured.
	const runner = cfg.runner_url
		? (await import("../mutation/cloud-runner.js")).createCloudMutationRunner(
				{ url: cfg.runner_url, token: cfg.token, timeoutMs: cfg.budget_ms ?? 25_000 },
				(u, init) => fetch(u, init),
			)
		: null;
	const decision = await runPerEditMutationGate({
		toolName: event.tool_name ?? "",
		toolInput: event.tool_input,
		config: cfg,
		runner,
		baseManifest,
		readDisk: (file) => readDiskSafe(resolve(ctx.cwd, file)),
		// Measured-clean passes persist the refreshed manifest + a receipt line
		// (spec §4/§12); the gate itself guarantees dirty/unmeasured runs never do.
		persist: makeManifestPersister(interlinkedDir),
		at: new Date().toISOString(),
	});
	if (!decision) return null;
	if (decision.decision === "block") {
		decision.warnings = mergeWarnings(preDecision.warnings, decision.warnings);
		return decision;
	}
	if (decision.warnings && decision.warnings.length > 0) {
		preDecision.warnings = mergeWarnings(preDecision.warnings, decision.warnings);
	}
	return null;
}
