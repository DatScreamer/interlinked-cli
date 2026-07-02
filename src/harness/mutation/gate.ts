// ===========================================
// Per-edit mutation — PreToolUse gate orchestration (build steps 1 & 7)
// ===========================================
// The entry point the hook pipeline calls: normalize the tool_input, pick the
// edited code file, and — capability-aware (spec §12) — either run the injected
// MutationRunner and evaluate, or return a not-measured allow. Default-off; the
// runner is null until the cloud Sandbox runner is wired, so an enabled-but-
// runnerless install honestly discloses `[mutation:not-measured]` and never
// claims a clean pass. The wiring into pre-tool-pipeline.ts is a thin call site.

import { expectedCompanionTest } from "../coverage-debt.js";
import type { HarnessDecision } from "../types/decisions.js";
import { type ChangeSet, changedPaths, normalizeChangeSet } from "./changeset.js";
import { evaluateMutation } from "./evaluate.js";
import { applyChangeSet } from "./provisioner.js";
import type { MutationRunOutput } from "./stryker-adapter.js";
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
	/** Cloud Sandbox runner endpoint; absent → no runner → honest not-measured. */
	runner_url?: string | undefined;
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
export interface MutationRunner {
	available(): boolean;
	run(file: string, overlayContent: string, overlays?: FileOverlay[]): Promise<MutationRunOutput>;
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
	at: string;
}

const RULE_ID = "per-edit-mutation";
const CATEGORY = "mutation";
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function primaryCodeFile(paths: string[]): string | null {
	return paths.find((p) => CODE_EXT.test(p)) ?? null;
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
	return out;
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
	const target = primaryCodeFile(changedPaths(changeSet));
	if (target === null) return null;

	if (ctx.runner === null || !ctx.runner.available()) {
		if (ctx.config.unavailable_behavior === "block") return failClosed("mutation could not be measured");
		return mutationOutcomeToDecision(notMeasured("no mutation runner configured"));
	}

	const disk = ctx.readDisk(target);
	if (disk === null) return null;
	const overlayContent = overlayContentFor(changeSet, target, disk);
	if (overlayContent === null) return null;

	let result: MutationRunOutput;
	try {
		const overlays = buildOverlays({ changeSet, target, overlayContent, readDisk: ctx.readDisk });
		result = await ctx.runner.run(target, overlayContent, overlays);
	} catch {
		// A runner failure is never a clean pass — it is an unmeasured allow.
		return mutationOutcomeToDecision(notMeasured("the mutation runner failed"));
	}
	const outcome = evaluateMutation({
		file: target,
		baseManifest: ctx.baseManifest,
		overlayContent,
		adapted: result.mutants,
		siteCountThreshold: ctx.config.site_count_threshold ?? DEFAULT_SITE_COUNT_THRESHOLD,
		testRun: result.testRun,
		at: ctx.at,
	});
	const persistWarning = persistIfCleanMeasured(outcome, ctx.persist);
	const decision = applyMode(mutationOutcomeToDecision(outcome), ctx.config.mode);
	if (persistWarning) decision.warnings = [...(decision.warnings ?? []), persistWarning];
	return decision;
}
