// ===========================================
// Mutation-directed file-class severity profile — PreToolUse wiring
// ===========================================
// docs/design/luna-gate-audit-2026-08-14.md §3(a). Detection lives in
// checks/mutation-directed-profile.ts (pure content functions); this module
// reads config, resolves proposed/baseline content, and builds the
// HarnessDecision. Both gates are scoped to MUTATION_DIRECTED_PATH files —
// isMutationDirectedFile() is the first check in the function body, so a
// write to any other file costs exactly one regex test.
//
// GATE 1 (severity remap) and GATE 2's BLOCK behavior both live behind
// `mutation_directed_strict_profile` (default OFF — there is no
// default-config.ts entry, so the flag is simply absent/undefined until a
// repo opts in, matching the `strict_typing_block` precedent). Building and
// wiring this module changes nothing about a running daemon until that flag
// flips to true.
//
// The field is declared via `declare module` augmentation below instead of
// as a member of GuardRulesConfig in types/config.ts directly: that file is
// AT its enforced line-cap right now (a concurrent-edit congestion this
// codebase has hit before — see the INTERLINKED_DISABLE_LOCAL_LEASE_BLOCK
// precedent in pre-tool-decision-phases.ts, which used an env var for the
// same reason). Standard TS declaration merging keeps the read fully typed
// with no cast; fold it into GuardRulesConfig directly once that file has
// headroom again.
//
// GATE 2's WARNING is unconditional (not flag-gated) — the audit's own
// framing: legitimate refactors remove assertions constantly, so the block
// needs FP data before it can fire, but the warning is safe to ship now and
// is exactly what would have surfaced `kill_taste_smell_mutants`'s own
// self-reported "No mutation measurement was run" moment as a machine
// signal instead of prose nobody acted on.

import type { InlineMatch } from "../check-registry/types.js";
import {
	detectRemovedAssertions,
	evaluateMutationDirectedSignals,
	isMutationDirectedFile,
	REMOVED_ASSERTION_CHECK_ID,
} from "../checks/mutation-directed-profile.js";
import { resolveProposedContent } from "../overlay-content.js";
import { lineList, preBlockIntroducedBlock, resolveDiskBaseline } from "../pre-block-gate.js";
import { findProjectRoot } from "../quality-checks.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import type { ToolInput } from "./pre-tool-context-phases.js";
import { isFileWrite } from "./tool-classifiers.js";

// See the module header: types/config.ts is at its line cap right now, so
// this field is merged in here rather than declared as a member there.
declare module "../types/config.js" {
	interface GuardRulesConfig {
		/** Mutation-directed file-class severity profile (Luna gate audit §3a,
		 *  docs/design/luna-gate-audit-2026-08-14.md). Default OFF. */
		mutation_directed_strict_profile?: { enabled?: boolean };
	}
}

function profileEnabled(rules: GuardRulesConfig): boolean {
	return rules.mutation_directed_strict_profile?.enabled === true;
}

function removedAssertionWarning(filePath: string, removed: InlineMatch[]): string {
	return (
		`[interlinked:${REMOVED_ASSERTION_CHECK_ID}] ${filePath} removes ${removed.length} test-case/` +
		`assertion line(s) vs the on-disk baseline (first at L${removed[0]?.line ?? 0}). Mutation-directed ` +
		"files are graded on kill evidence — confirm this removal is a legitimate refactor, not evidence " +
		"going missing."
	);
}

function removedAssertionBlock(
	filePath: string,
	removed: InlineMatch[],
	warnings: string[],
): HarnessDecision {
	const first = removed[0];
	const restSummary = removed.length > 1 ? ` (+ ${removed.length - 1} more at ${lineList(removed)})` : "";
	return {
		decision: "block",
		reason:
			`BLOCKED by [${REMOVED_ASSERTION_CHECK_ID}]. This edit removes ${removed.length} test-case/` +
			`assertion line(s) from ${filePath} vs the on-disk baseline. First: L${first?.line ?? 0} — ` +
			`"${first?.text ?? ""}"${restSummary}. Mutation-directed files are graded on kill evidence — ` +
			"restore the assertion, or if this is a deliberate consolidation/rename, keep the replacement " +
			"case's assertion count at or above what it replaces. File-level escape hatch: add an entry for " +
			`"${REMOVED_ASSERTION_CHECK_ID}" to .interlinked/verify-suppressions.json for ${filePath}.`,
		warnings,
		rule_id: REMOVED_ASSERTION_CHECK_ID,
		severity: "high",
		category: "pre-block",
	};
}

function preexistingSignalWarning(filePath: string, checkId: string, preexisting: InlineMatch[]): string {
	return (
		`[interlinked:mutation-directed-profile] ${filePath} carries ${preexisting.length} pre-existing ` +
		`[${checkId}] instance(s) at ${lineList(preexisting)} — not introduced by this edit, so the strict ` +
		"profile did not block."
	);
}

/**
 * PreToolUse phase. No-op unless the write touches a MUTATION_DIRECTED_PATH
 * file. Returns a block decision, or null after pushing any warnings.
 */
export function evaluateMutationDirectedProfile(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (!(isFileWrite(toolName) && (toolInput.content || toolInput.new_string))) return null;
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath || !isMutationDirectedFile(filePath)) return null;

	const content = resolveProposedContent(filePath, toolInput);
	const baselineContent = resolveDiskBaseline(filePath);
	const projectRoot =
		findProjectRoot(filePath, event.cwd || process.cwd()) || event.cwd || process.cwd();
	const args = { content, filePath, baselineContent, projectRoot };

	// GATE 2 — assertion-removal delta. Warning is unconditional; block is
	// flag-gated (see module header).
	const removed = detectRemovedAssertions(args);
	if (removed.length > 0) {
		warnings.push(removedAssertionWarning(filePath, removed));
		if (profileEnabled(rules)) return removedAssertionBlock(filePath, removed, warnings);
	}

	// GATE 1 — severity remap. Skip the (real) compute entirely at the
	// default OFF state: a full checkTestLegitimacy + SUT-import pass + test-
	// block extraction is not free, and this file class already paid for the
	// pre_warn version of the same work in evaluateWriteContent.
	if (!profileEnabled(rules)) return null;
	const outcomes = evaluateMutationDirectedSignals(args);
	const blocking = outcomes.find((o) => o.introduced.length > 0);
	if (blocking) return preBlockIntroducedBlock(blocking, filePath, warnings);
	for (const o of outcomes) {
		if (o.preexisting.length > 0) {
			warnings.push(preexistingSignalWarning(filePath, o.checkId, o.preexisting));
		}
	}
	return null;
}
