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
import { relative, resolve } from "node:path";
import {
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
} from "../apply-patch-content.js";
import { applyDebtMode } from "../coverage-debt-gate.js";
import { noteWanderBlockDecision } from "../debt-evasion.js";
import { type DependencyView, resolveDependencyView } from "../dependency-view.js";
import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { unavailableDecision } from "../mutation/gate-decision.js";
import type { MutationRunner, MutationTestSelection, PerEditMutationConfig } from "../mutation/gate.js";
import { runPerEditMutationGate } from "../mutation/gate.js";
import { computeMutationTestScope } from "../mutation/test-scope.js";
// NOTE: `loadManifest` (the strict, 44MB-parsing loader) survives HERE and only
// here on the daemon side, deliberately. This is a BLOCKING gate: it must judge
// against the exact manifest generation, never a summary, and it needs full
// `SymbolRecord`s (symbol hashes, per-mutant identity, instability) that the
// survivors-index sidecar does not carry. The fast path that keeps it off the
// hot path is the `cfg?.enabled` guard a few lines below `runMutationWriteGate`'s
// entry: `per_edit_mutation` is default-OFF, so an unconfigured daemon never
// reaches the load at all. Every ADVISORY consumer (Stop nudges, pulse lines)
// reads the sidecar instead — see harness/mutation/survivors-index.ts.
import { emptyManifest, loadManifestState, makeManifestPersister } from "../mutation/manifest.js";
import { makeManifestPersisterWithIndex } from "../mutation/survivors-index.js";
import {
	commitPendingRegistry,
	initPendingRegistryStore,
	overlayHash,
	pendingRegistry,
} from "../mutation/pending-registry.js";
import { appendMutationRun } from "../mutation/run-log.js";
import { recordPending } from "../mutation/pending-runs.js";
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
	// tool_input crosses a process boundary, so its field types are a claim, not
	// a guarantee. Asserting `as string` here made a non-string payload flow on
	// as a "string" and fail somewhere further down, where the cause is invisible.
	const fromFilePath = typeof input.file_path === "string" ? input.file_path : "";
	const named = fromFilePath !== "" ? fromFilePath : typeof input.path === "string" ? input.path : "";
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

function mutationTestSelectionForTarget(
	ctx: ServerRuntime,
	target: string,
	cfg: PerEditMutationConfig,
): MutationTestSelection {
	const targetPath = resolve(ctx.cwd, target);
	let depView: DependencyView;
	try {
		depView = resolveDependencyView(targetPath, ctx.cwd, getGraphForFile(ctx, targetPath));
	} catch {
		return { kind: "unavailable", reason: "dependency graph unavailable — exact mutation test scope is unproven" };
	}
	const editedRelPath = relative(ctx.cwd, targetPath).replaceAll("\\", "/");
	const scope = computeMutationTestScope({
		editedRelPath,
		projectRoot: ctx.cwd,
		depView,
		...(cfg.max_test_scope !== undefined ? { maxScope: cfg.max_test_scope } : {}),
	});
	if (scope.tests !== null) {
		return {
			kind: "selected",
			options: { testFiles: scope.tests, scopeMode: "import_graph" },
			partial: false,
		};
	}
	if (scope.companionScope !== undefined && scope.companionScope.length > 0) {
		return {
			kind: "selected",
			options: { testFiles: scope.companionScope, scopeMode: "companion_fallback" },
			partial: true,
		};
	}
	const count = scope.uncappedCount === undefined ? "" : ` (${scope.uncappedCount} tests exceeded the cap)`;
	return {
		kind: "unavailable",
		reason: `exact mutation test scope is unavailable for ${editedRelPath}: ${scope.reason ?? "unknown"}${count}`,
	};
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
	const depView = depViewForEvent(ctx, event);
	let decision = await checkCoverageWrite(event, ctx.rules, undefined, depView);
	// Pair-scoped debt lifecycle (a pure no-op unless `per_edit_coverage.debt_mode`
	// is on): downgrades a first uncovered-line block to opened debt, blocks a
	// wander outside the debt's work, discharges on a companion-test edit. The
	// SAME dependency view powers failure-evidence relatedness: while red, an
	// edit that can influence a recorded failing test is never a "wander".
	decision = applyDebtMode(event, coverageCfg, decision, depView);
	// A debt-focus wander block arms this session's inline-exec evasion counter
	// (debt-evasion.ts owns the logic; this observes every outcome). Never blocks.
	noteWanderBlockDecision(ctx.sessions, event, decision, Date.now());
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
/**
 * Build the mutation runner from config: exactly ONE endpoint, whole-file
 * scope. Line-range sharding is retired from v1 (2026-08-27) — a mutant whose
 * span crossed a shard boundary vanished from both sides — so `cloud_shards`
 * and extra `runner_urls` entries are obsolete and draw a one-time
 * deprecation warning below. The dormant partial-scope design lives in plan
 * 27 Appendix B. Lazy dynamic imports keep this off the default-off hot path.
 */
/** One-time flags so obsolete-config warnings do not spam every edit. */
let warnedObsoleteShards = false;
let warnedExtraUrls = false;

async function buildMutationRunner(cfg: PerEditMutationConfig, cwd?: string): Promise<MutationRunner | null> {
	const urls = [cfg.runner_url, ...(cfg.runner_urls ?? [])].filter(
		(u): u is string => typeof u === "string" && u.length > 0,
	);
	if (urls.length === 0) return null;
	// SHARDING IS RETIRED FROM v1 (review passes 11-19): both `cloud_shards`
	// and multi-URL line-range partitioning drove the proven-lossy ranged
	// execution (a mutant spanning a split vanished from both sides). Obsolete
	// configuration FAILS VISIBLY rather than being silently ignored — a user
	// who configured three endpoints must not believe three are serving.
	if (typeof cfg.cloud_shards === "number" && cfg.cloud_shards > 1 && !warnedObsoleteShards) {
		warnedObsoleteShards = true;
		console.error(
			"[interlinked:mutation] config `cloud_shards` is OBSOLETE and ignored — " +
				"v1 measures the whole file in one run (line-range sharding lost boundary mutants). " +
				"Remove it from per_edit_mutation; future sharding arrives as new config (plan 27).",
		);
	}
	if (urls.length > 1 && !warnedExtraUrls) {
		warnedExtraUrls = true;
		console.error(
			`[interlinked:mutation] config runner_urls lists ${urls.length} endpoints but ONLY THE FIRST is used — ` +
				"line-range partitioning is retired and failover is not implemented. " +
				"Remove the extra entries so the config states what actually runs.",
		);
	}
	const { createCloudMutationRunner } = await import("../mutation/cloud-runner.js");
	const timeoutMs = cfg.budget_ms ?? 25_000;
	// `cwd` canonicalizes the requested target against report entries at the
	// runner's trust boundary (exact-path match, review 2026-08-25 pass 6).
	const url = urls[0] ?? "";
	return createCloudMutationRunner({ url, token: cfg.token, timeoutMs, cwd }, (u, init) =>
		fetch(u, { ...init, signal: init.signal }),
	);
}

// interlinked: defer ubs_large_function -- pre-existing size; this goal added a
// 1-line dry_run guard, and goal 28 forbids unrelated refactors. Extracting the
// runner-construction and pending-registry stages is worth doing, but as its own
// change where the test surface can move with it.
export async function runMutationWriteGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	if (preDecision.decision !== "allow") return null;
	const cfg = ctx.rules.per_edit_mutation;
	if (!cfg?.enabled || cfg.mode === "off") return null; // fast path: default OFF
	// A DRY RUN MUST NOT MOVE THE GATE (CLAUDE.md). `interlinked harness test
	// --write/--edit` sets `dry_run` on a synthetic event; without this check the
	// mutation gate ran for real — persisting a refreshed manifest, appending a
	// receipt, writing a run-log row and committing the pending registry — for an
	// edit that never happened. Every other evaluator that persists already
	// honors the flag; this one was missed because its persistence is indirect,
	// through the `persist` callback below rather than a visible `writeFileSync`.
	if (event.dry_run === true) return null;
	const interlinkedDir = resolve(ctx.cwd, ".interlinked");
	// Review 2026-08-28 item 4: only a MISSING manifest may bootstrap a fresh
	// (adoptable) empty baseline. A CORRUPT one must not — collapsing both let
	// the next successful run adopt a new floor over the damaged history,
	// resetting the ratchet. Corrupt ⇒ honest not-measured, gate not run, file
	// left in place for recovery, zero persistence.
	const manifestState = loadManifestState(interlinkedDir);
	if (manifestState.kind === "corrupt") {
		// Through the ONE "could not measure" choke point (review 2026-08-28
		// finding 1): a hand-built allow here silently bypassed
		// `unavailable_behavior: "block"` — the fail-closed operator policy has
		// to govern this exit like every other not-measured exit.
		return unavailableDecision(
			cfg,
			`mutation manifest is corrupt (${manifestState.detail}) — not adopting a fresh baseline over damaged history; the file is preserved at .interlinked/mutation-manifest.json for recovery`,
		);
	}
	const baseManifest =
		manifestState.kind === "valid" ? manifestState.manifest : emptyManifest(MUTATION_PLACEHOLDER_META);
	// interlinked: defer sequential_awaits -- the second await CONSUMES the first
	// (`runner` is passed to the gate below), so these are dependent, not
	// independent; Promise.all would be wrong here, not faster.
	const runner = await buildMutationRunner(cfg, ctx.cwd);
	const decision = await runPerEditMutationGate({
		toolName: event.tool_name ?? "",
		toolInput: event.tool_input,
		config: cfg,
		runner,
		baseManifest,
		readDisk: (file) => readDiskSafe(resolve(ctx.cwd, file)),
		selectTests: (target) => mutationTestSelectionForTarget(ctx, target, cfg),
		// Measured-clean passes AND first-sighting adoptions persist the refreshed
		// manifest + a receipt line (spec §4/§12; review 2026-08-28 items 1-2) —
		// the receipt's `outcome` field says which, and the gate itself guarantees
		// dirty/unmeasured runs never reach here. Decorated so the survivors-index
		// sidecar is rewritten in the same CALL — NOT the same transaction
		// (review 2026-08-28): manifest → receipt → index → ledger are four
		// separate writes with no atomicity, so a crash mid-sequence leaves the
		// later artifacts stale relative to the manifest (MUT-AC-11; the SQLite
		// journal is the fix). The decoration only ensures no SUCCESSFUL persist
		// skips the sidecar.
		persist: (manifest, receipt) => {
			makeManifestPersisterWithIndex(interlinkedDir, makeManifestPersister(interlinkedDir))(manifest, receipt);
			// Live run ledger (viz). Counts are STATUS-based — `total - killed`
			// would misfile uncovered/timeout/equivalent sites as survivors
			// (external review 2026-08-23, finding 4). The row carries the
			// receipt's outcome so the dashboard renders adoption as a neutral
			// "baseline" row instead of inferring clean from survived === 0
			// (review 2026-08-28 item 2).
			const byStatus = (s: string): number => receipt.sites.filter((x) => x.status === s).length;
			appendMutationRun(ctx.cwd, {
				ts: receipt.measuredAt,
				file: relative(ctx.cwd, resolve(ctx.cwd, editedFileForEvent(event) ?? "")),
				source: "per-edit",
				mutants: receipt.sites.length,
				killed: byStatus("killed"),
				survived: byStatus("survived"),
				uncovered: byStatus("uncovered"),
				outcome: receipt.outcome,
			});
		},
		// A run that outlives the budget keeps computing on the runner. Recording
		// its handles here is what lets the PostToolUse window claim work this
		// window paid for — without it the engine's output is simply discarded.
		onPending: (file, overlayContent, pending) => {
			const now = Date.now();
			// Durable across daemon restarts (campaign U5): a handover between the
			// two hook windows must not discard work the runner already paid for.
			initPendingRegistryStore(ctx.cwd);
			const store = pendingRegistry(now);
			const hash = overlayHash(overlayContent);
			// Key on the REPO-RELATIVE path. The gate hands the runner absolute
			// paths, but the PostToolUse window derives its key from the edited
			// file's relative path — so recording the absolute form made the two
			// windows key on different strings and the harvest never matched
			// anything. Silent: an unmatched claim is indistinguishable from
			// "nothing was pending".
			const key = relative(ctx.cwd, resolve(ctx.cwd, file));
			for (const p of pending) {
				recordPending(store, { file: key, overlayHash: hash, jobId: p.jobId, runnerUrl: p.runnerUrl, startedAt: now });
			}
			commitPendingRegistry();
		},
		at: new Date().toISOString(),
		cwd: ctx.cwd,
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
