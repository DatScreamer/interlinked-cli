// ===========================================
// Per-edit mutation — PreToolUse gate orchestration (build steps 1 & 7)
// ===========================================
// The entry point the hook pipeline calls: normalize the tool_input, pick the
// edited code file, and — capability-aware (spec §12) — either run the injected
// MutationRunner and evaluate, or return a not-measured allow. Default-off; the
// runner is null until the cloud Sandbox runner is wired, so an enabled-but-
// runnerless install honestly discloses `[mutation:not-measured]` and never
// claims a clean pass. The wiring into pre-tool-pipeline.ts is a thin call site.

import { expectedCompanionTest, expectedSourceOfTest } from "../coverage-debt.js";
import { isTestPath } from "../coverage-test-selector.js";
import { isRepoScratchPath } from "../large-file-policy.js";
import type { HarnessDecision } from "../types/decisions.js";
import { type ChangeSet, changedPaths, normalizeChangeSet } from "./changeset.js";
import { editScope } from "./edit-range.js";
import { evaluateMutation } from "./evaluate.js";
import { collectLocalDeps } from "./local-deps.js";
import { applyChangeSet } from "./provisioner.js";
import type { MutationRunOutput } from "./stryker-adapter.js";
import { testEditEffect } from "./test-edit-effect.js";
import type { MutationGateOutcome, MutationManifest, MutationReceipt } from "./types.js";
import { mutationOutcomeToDecision } from "./verdict.js";

/** Default small-scope ceiling (spec §6) — clj-mutate's "consider splitting a file
 *  over 50 sites" precedent. Per-repo configurable via `site_count_threshold`. */
export const DEFAULT_SITE_COUNT_THRESHOLD = 50;

export interface PerEditMutationConfig {
	enabled: boolean;
	mode: "block" | "warn" | "off";
	unavailable_behavior: "allow_unmeasured" | "block";
	/** Spec §6 small-scope ceiling; over this many changed-region sites ⇒ "split
	 *  this patch" block. Omitted ⇒ {@link DEFAULT_SITE_COUNT_THRESHOLD}. */
	site_count_threshold?: number | undefined;
	/** Wall-clock budget for the cloud runner round-trip (spec §12). Expiry ⇒
	 *  honest not-measured, never a forged pass. Omitted ⇒ 25 000 ms. Tune DOWN
	 *  when the runner is known-unmeasurable for this repo (e.g. scaffolding not
	 *  yet on the remote) so the per-edit latency tax stays small. */
	budget_ms?: number | undefined;
	/** How long the PostToolUse window will WAIT for a run that outlived
	 *  {@link PerEditMutationConfig.budget_ms}. This is the second half of the
	 *  two-window design: PostToolUse fires milliseconds after the write while
	 *  the run still needs seconds, so without a wait the work is discarded.
	 *  Bounds how long the agent's turn is held. Omitted ⇒ 25 000 ms. An
	 *  unreachable runner returns immediately regardless. */
	harvest_budget_ms?: number | undefined;
	/** Cloud Sandbox runner endpoint; absent → no runner → honest not-measured. */
	runner_url?: string | undefined;
	/**
	 * Additional runner endpoints. When more than one runner is configured the
	 * file's line span is partitioned across them and measured concurrently, which
	 * is how a per-edit budget buys more mutants than one runner could finish.
	 * Omitted / single ⇒ the unsharded path, byte-identical to before.
	 */
	runner_urls?: string[] | undefined;
	token?: string | undefined;
}

/** One proposed file state shipped to the runner (spec §7 atomic ChangeSet). */
export interface FileOverlay {
	path: string;
	content: string;
}

/**
 * The mutation execution backend (cloud Sandbox runner / local Stryker).
 * `overlays` carries the FULL proposed state — every ChangeSet file plus the
 * primary's companion test when it exists on local disk (the cloud clone comes
 * from git, so a test-first test that only exists locally must travel with the
 * edit or red/green + RED-witness can't see it). Always includes the primary.
 */
/** 1-based inclusive line span of the primary file to measure. Omitted ⇒ whole file. */
export interface MutationRange {
	start: number;
	end: number;
}

export interface MutationRunner {
	available(): boolean;
	/**
	 * `range` restricts measurement to one line span so N runners can measure N
	 * slices of the SAME edit concurrently — a model edits one file at a time, so
	 * splitting by file would not parallelise the common case. Optional: a runner
	 * that ignores it simply measures the whole file, which is always correct,
	 * only slower.
	 */
	run(
		file: string,
		overlayContent: string,
		overlays?: FileOverlay[],
		range?: MutationRange,
	): Promise<MutationRunOutput>;
}

export interface MutationGateContext {
	toolName: string;
	toolInput: unknown;
	config: PerEditMutationConfig;
	runner: MutationRunner | null;
	baseManifest: MutationManifest;
	readDisk: (file: string) => string | null;
	/** Persistence sink for a measured-clean pass (manifest snapshot + receipt).
	 *  Absent → evaluate-only. Persistence failures are swallowed — they must
	 *  never break the gate (the allow still stands). */
	persist?: ((manifest: MutationManifest, receipt: MutationReceipt) => void) | undefined;
	/** Called when a run outlives the budget but is still computing remotely.
	 *  Handing the handles out here is what makes the PostToolUse window able to
	 *  claim work this window paid for but could not wait for. Absent → the
	 *  results are simply dropped, which is the old single-window behaviour. */
	onPending?: ((file: string, overlayContent: string, pending: readonly PendingHandle[]) => void) | undefined;
	at: string;
	/** Repo root to resolve an absolute `file_path` against when keying the
	 *  manifest (manifest.ts's `normalizeManifestKey`) — pass the daemon's actual
	 *  `ctx.cwd`, which can diverge from `process.cwd()` under an explicit
	 *  `--cwd`. Omitted callers fall back to `process.cwd()`. */
	cwd?: string;
}

/** The minimum a caller needs to come back for an unfinished run. */
export interface PendingHandle {
	jobId: string;
	runnerUrl: string;
}

/**
 * Pull the still-running job handles out of whatever a runner threw.
 *
 * Both shapes matter: a single runner rejects with `MutationRunPendingError`
 * directly, while the sharded runner wraps every shard's rejection in a
 * `ShardedRunFailure`. Anything else is a real failure with nothing to claim.
 * Structural checks, not `instanceof`, so this stays free of an import cycle
 * with the runners that depend on this module's types.
 */
export function pendingHandlesFrom(err: unknown): PendingHandle[] {
	const isHandle = (v: unknown): v is PendingHandle =>
		typeof v === "object" &&
		v !== null &&
		// SAFETY: object-ness is established above; these two reads are the
		// predicate's actual test, and `typeof` on a missing key is "undefined",
		// so a non-handle fails rather than throwing.
		typeof (v as PendingHandle).jobId === "string" &&
		typeof (v as PendingHandle).runnerUrl === "string";

	if (isHandle(err)) return [err];
	const nested = (err as { pending?: unknown })?.pending;
	if (Array.isArray(nested)) return nested.filter(isHandle);
	return [];
}

/**
 * Why the run produced no verdict.
 *
 * Three outcomes that used to read identically as "the mutation runner failed",
 * which is the least useful of them and was wrong most of the time:
 *   - still working  -> results ARE coming, in the PostToolUse window
 *   - not measurable -> the runner succeeded; there is nothing to measure
 *                       (usually: no test exercises this file)
 *   - failed         -> actually broken
 */
function notMeasuredReason(err: unknown, pendingCount: number): string {
	if (pendingCount > 0) return "mutation still running past the budget";
	if (isRunnerBusy(err)) {
		return "the mutation runner is busy with another job right now — not measured this edit, and NOT evidence this file has no tests (retry on the next edit)";
	}
	const reason = notMeasurableReasonOf(err);
	if (reason === "no_tests") {
		return "no test exercises this file, so mutation cannot measure it — add one and the gate starts protecting this code";
	}
	if (reason !== null) return `mutation not measurable here (${reason})`;
	return describeRunnerFailure(err);
}

/**
 * Quote the runner's own words.
 *
 * "the mutation runner failed" was the terminal string for every unclassified
 * error, and it was the DOMINANT live outcome — 12 occurrences in the last 4000
 * activity records, against zero measured verdicts. It names the component and
 * withholds the cause, which is the one combination nobody can act on: the
 * reader cannot separate a dead endpoint from a failed clone from a crashed
 * engine, so re-running is the only move left. The client now carries the
 * response body up (`describeErrorResponse`), so there is finally something to
 * say.
 */
function describeRunnerFailure(err: unknown): string {
	const message = (err as { message?: unknown })?.message;
	if (typeof message !== "string" || message.trim() === "") return "the mutation runner failed";
	return `the mutation runner failed — ${message.trim()}`;
}

/**
 * A contended runner is not a broken one, and it is definitely not a
 * "no tests" verdict — collapsing "busy" into either is the exact
 * measurement-integrity defect this check exists to prevent (a contended
 * runner silently drops the file out of the denominator). Detected
 * structurally — by error name (a runner that throws the dedicated
 * `MutationRunnerBusyError`) or by message (the generic HTTP-status error a
 * plain non-ok response produces) — rather than `instanceof`, so this module
 * stays free of an import cycle with the runners it evaluates.
 */
function isRunnerBusy(err: unknown): boolean {
	const name = (err as { name?: unknown })?.name;
	if (name === "MutationRunnerBusyError") return true;
	const message = (err as { message?: unknown })?.message;
	return typeof message === "string" && /\bHTTP 503\b/.test(message);
}

/** Structural read, so this module stays free of an import cycle with the runners. */
function notMeasurableReasonOf(err: unknown): string | null {
	const name = (err as { name?: unknown })?.name;
	if (name !== "MutationNotMeasurableError") return null;
	const reason = (err as { reason?: unknown })?.reason;
	return typeof reason === "string" && reason !== "" ? reason : "unspecified";
}

const RULE_ID = "per-edit-mutation";
const CATEGORY = "mutation";
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * The file in this change set worth mutating.
 *
 * Test files are NOT worth mutating, and excluding them is a measurement
 * decision rather than an optimisation: mutation testing asks whether the tests
 * would notice a defect in the code, so mutating the tests themselves asks
 * whether anything would notice a changed test — for which the answer is almost
 * always no. The result would be a near-100% survivor rate that means nothing.
 *
 * It also failed concretely: a run targeting `harvest.test.ts` derived the test
 * scope `harvest.test.test.ts`, matched no tests, and reported the same opaque
 * "runner failed" as every other mis-scoped run.
 */
export function primaryCodeFile(paths: string[]): string | null {
	return paths.find(isMutationTarget) ?? null;
}

/**
 * What this change set should be measured against, including the TEST-EDIT case.
 *
 * Editing a test used to measure nothing at all: `primaryCodeFile` correctly
 * refuses to mutate a test, and with no code file in the set the gate returned
 * null. But "I added a test" is precisely the claim mutation testing exists to
 * check, and it was the one edit shape that went unchecked — a test could be
 * added, pass, and kill nothing, and the harness would say nothing.
 *
 * So a test-only change set resolves to the code that test protects, and the
 * run measures THAT with the new test overlaid. The comparison against the
 * manifest baseline then answers the real question: did the survivor count go
 * down?
 *
 * The companion convention (`foo.test.ts` -> `foo.ts`) is the same one the
 * coverage gate pairs on — `expectedSourceOfTest`, not a second opinion. A test
 * with no such source (an integration or end-to-end suite protecting no single
 * module) resolves to null and is skipped, because guessing a target for it
 * would measure something the edit was not about.
 */
export function mutationTargetFor(paths: string[], exists: (path: string) => boolean): string | null {
	const direct = primaryCodeFile(paths);
	if (direct !== null) return direct;
	for (const path of paths) {
		if (!isTestPath(path) || !CODE_EXT.test(path)) continue;
		const source = expectedSourceOfTest(path);
		if (source !== path && isMutationTarget(source) && exists(source)) return source;
	}
	return null;
}

/**
 * Is this path product code the tests are supposed to protect?
 *
 * `scratch/` is excluded through the repo's ONE product-code domain definition
 * rather than a second opinion — a probe script has no companion test by design,
 * so targeting it can only ever produce "no tests were executed".
 */
function isMutationTarget(path: string): boolean {
	if (!CODE_EXT.test(path)) return false;
	if (isTestPath(path)) return false;
	return !isRepoScratchPath(path.replace(/\\/g, "/"), undefined);
}

function overlayContentFor(changeSet: ChangeSet, file: string, diskContent: string): string | null {
	const ops = changeSet.ops.filter((op) =>
		op.kind === "rename" ? op.from === file || op.to === file : op.path === file,
	);
	return applyChangeSet(new Map([[file, diskContent]]), { ops }).get(file) ?? null;
}

function notMeasured(reason: string): MutationGateOutcome {
	return { kind: "unavailable", reason, warning: `[mutation:not-measured] ${reason}` };
}

/**
 * The full proposed state to ship (spec §7): every ChangeSet path's overlay,
 * plus the primary's companion test read from LOCAL disk when it exists — a
 * test-first test lives only in the local tree until commit, so the runner's
 * git-cloned base has never seen it. The primary is always first.
 */
function buildOverlays(args: {
	changeSet: ChangeSet;
	target: string;
	overlayContent: string;
	readDisk: (file: string) => string | null;
}): FileOverlay[] {
	const { changeSet, target, overlayContent, readDisk } = args;
	const out: FileOverlay[] = [{ path: target, content: overlayContent }];
	for (const path of changedPaths(changeSet)) {
		if (path === target) continue;
		const content = overlayContentFor(changeSet, path, readDisk(path) ?? "");
		if (content !== null) out.push({ path, content });
	}
	const companion = expectedCompanionTest(target);
	if (companion !== target && !out.some((o) => o.path === companion)) {
		const disk = readDisk(companion);
		if (disk !== null) out.push({ path: companion, content: disk });
	}
	addLocalDeps(out, target, companion, readDisk);
	return out;
}

/**
 * Add the local files the overlay set depends on but does not yet carry.
 *
 * The runner's checkout sits at a commit, so an uncommitted module the edited
 * file (or its test) imports is simply absent there — the test fails to load and
 * the run reports "no tests executed", which reaches the agent as an unhelpful
 * generic failure. Walking from BOTH the target and its companion matters: a new
 * module is often reached only through the test.
 *
 * Existing overlay entries always win; their content is the proposed text, and
 * re-reading them from disk would discard the very edit under measurement.
 */
function addLocalDeps(
	out: FileOverlay[],
	target: string,
	companion: string,
	readDisk: (file: string) => string | null,
): void {
	const have = new Set(out.map((o) => o.path));
	for (const entry of companion === target ? [target] : [target, companion]) {
		for (const dep of collectLocalDeps(entry, readDisk)) {
			if (have.has(dep)) continue;
			const content = readDisk(dep);
			if (content === null) continue;
			have.add(dep);
			out.push({ path: dep, content });
		}
	}
}

function failClosed(reason: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:mutation] BLOCKED: ${reason} (unavailable_behavior=block).`,
		rule_id: RULE_ID,
		severity: "medium",
		category: CATEGORY,
	};
}

/**
 * Persist the refreshed manifest + receipt iff the OUTCOME is a measured-clean
 * allow (spec §4/§12). Keyed off the outcome — not the wire decision — so
 * warn-mode (which downgrades blocks) can never launder a dirty run into a
 * manifest refresh. Returns a warning when persistence failed (the allow
 * stands; the next run simply re-measures), else null.
 */
function persistIfCleanMeasured(
	outcome: MutationGateOutcome,
	persist: MutationGateContext["persist"],
): string | null {
	if (outcome.kind !== "measured" || outcome.decision !== "allow") return null;
	if (!outcome.refreshedManifest || !persist) return null;
	try {
		persist(outcome.refreshedManifest, outcome.receipt);
		return null;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return `[interlinked:mutation] manifest persistence failed (${detail}) — allow stands; next run re-measures.`;
	}
}

function applyMode(decision: HarnessDecision, mode: PerEditMutationConfig["mode"]): HarnessDecision {
	if (mode === "warn" && decision.decision === "block") {
		return {
			decision: "allow",
			warnings: [decision.reason ?? "[interlinked:mutation] finding"],
			rule_id: decision.rule_id,
			category: decision.category,
		};
	}
	return decision;
}

/** PreToolUse per-edit mutation gate (spec §4 / §12). Default-off; capability-aware. */
export async function runPerEditMutationGate(ctx: MutationGateContext): Promise<HarnessDecision | null> {
	if (!ctx.config.enabled || ctx.config.mode === "off") return null;
	const changeSet = normalizeChangeSet(ctx.toolName, ctx.toolInput);
	if (changeSet === null) return null;
	const target = mutationTargetFor(changedPaths(changeSet), (p) => ctx.readDisk(p) !== null);
	if (target === null) return null;

	if (ctx.runner === null || !ctx.runner.available()) {
		if (ctx.config.unavailable_behavior === "block") return failClosed("mutation could not be measured");
		return mutationOutcomeToDecision(notMeasured("no mutation runner configured"));
	}

	const disk = ctx.readDisk(target);
	if (disk === null) return null;
	const overlayContent = overlayContentFor(changeSet, target, disk);
	if (overlayContent === null) return null;

	// Measure the DIFF, not the file. The wire has carried `range` all along, but
	// only the sharding path set it — so a three-line edit paid for every mutant
	// in the module and reported survivors in code the edit never touched. A
	// diffuse change degrades to `whole`, which is the previous behavior.
	const scope = editScope(disk, overlayContent);

	let result: MutationRunOutput;
	try {
		const overlays = buildOverlays({ changeSet, target, overlayContent, readDisk: ctx.readDisk });
		result = await ctx.runner.run(
			target,
			overlayContent,
			overlays,
			scope.kind === "span" ? scope.range : undefined,
		);
	} catch (err) {
		// A budget expiry is not a failure — the engine is still working and the
		// runner retains the report, so hand the handles up for the next window.
		// The answer is still "not measured", because right now it genuinely is.
		const pending = pendingHandlesFrom(err);
		if (pending.length > 0 && ctx.onPending) ctx.onPending(target, overlayContent, pending);
		return mutationOutcomeToDecision(notMeasured(notMeasuredReason(err, pending.length)));
	}
	const outcome = evaluateMutation({
		file: target,
		baseManifest: ctx.baseManifest,
		overlayContent,
		adapted: result.mutants,
		siteCountThreshold: ctx.config.site_count_threshold ?? DEFAULT_SITE_COUNT_THRESHOLD,
		testRun: result.testRun,
		at: ctx.at,
		...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
	});
	const persistWarning = persistIfCleanMeasured(outcome, ctx.persist);
	const decision = applyMode(mutationOutcomeToDecision(outcome), ctx.config.mode);
	if (persistWarning) decision.warnings = [...(decision.warnings ?? []), persistWarning];
	// A test-only edit leaves the source untouched, so the ordinary "no new
	// survivors" verdict is trivially satisfied and says nothing about whether
	// the test was worth adding. Answer that question directly.
	const effect = testEditEffect(changedPaths(changeSet), target, ctx.baseManifest, result.mutants);
	if (effect) decision.warnings = [...(decision.warnings ?? []), effect];
	return decision;
}
