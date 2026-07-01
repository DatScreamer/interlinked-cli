// ===========================================
// Per-edit mutation — PreToolUse gate orchestration (build steps 1 & 7)
// ===========================================
// The entry point the hook pipeline calls: normalize the tool_input, pick the
// edited code file, and — capability-aware (spec §12) — either run the injected
// MutationRunner and evaluate, or return a not-measured allow. Default-off; the
// runner is null until the cloud Sandbox runner is wired, so an enabled-but-
// runnerless install honestly discloses `[mutation:not-measured]` and never
// claims a clean pass. The wiring into pre-tool-pipeline.ts is a thin call site.

import type { HarnessDecision } from "../types/decisions.js";
import { type ChangeSet, changedPaths, normalizeChangeSet } from "./changeset.js";
import { evaluateMutation } from "./evaluate.js";
import { applyChangeSet } from "./provisioner.js";
import type { MutationRunOutput } from "./stryker-adapter.js";
import type { MutationGateOutcome, MutationManifest } from "./types.js";
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
	/** Cloud Sandbox runner endpoint; absent → no runner → honest not-measured. */
	runner_url?: string | undefined;
	token?: string | undefined;
}

/** The mutation execution backend (cloud Sandbox runner / local Stryker). */
export interface MutationRunner {
	available(): boolean;
	run(file: string, overlayContent: string): Promise<MutationRunOutput>;
}

export interface MutationGateContext {
	toolName: string;
	toolInput: unknown;
	config: PerEditMutationConfig;
	runner: MutationRunner | null;
	baseManifest: MutationManifest;
	readDisk: (file: string) => string | null;
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

function failClosed(reason: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:mutation] BLOCKED: ${reason} (unavailable_behavior=block).`,
		rule_id: RULE_ID,
		severity: "medium",
		category: CATEGORY,
	};
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
		result = await ctx.runner.run(target, overlayContent);
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
	return applyMode(mutationOutcomeToDecision(outcome), ctx.config.mode);
}
