import { nonNull } from "../../lib/non-null.js";

const MULTI_EDIT_REFACTOR_TSC_CODES = new Set(["TS2304", "TS2552"]);

interface TscBlockingFinding {
	ruleId?: string | undefined;
	line: number;
	column?: number | undefined;
	message: string;
}

/** Build the block reason for a tsc overlay, including coordinated-refactor guidance. */
export function buildTscDiffOverlayBlockReason(
	toolName: string,
	blocking: ReadonlyArray<TscBlockingFinding>,
	filePath: string,
): string {
	const first = blocking[0];
	const rest = blocking.length - 1;
	const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
	const head =
		`BLOCKED by tsc diff-overlay: this edit introduces ${blocking.length} new type error(s) in ${filePath}. ` +
		`First: [${nonNull(first).ruleId}] L${nonNull(first).line}:${nonNull(first).column ?? 1} — ${nonNull(first).message}${restSummary}. ` +
		"Fix the type error(s) in your edit, or retry without introducing them.";
	if (toolName === "MultiEdit") return head;
	const allMissingSymbols = blocking.every((finding) =>
		MULTI_EDIT_REFACTOR_TSC_CODES.has(finding.ruleId ?? ""),
	);
	if (allMissingSymbols) {
		return (
			`${head} All blocking errors are 'cannot find name' — the signature of a coordinated refactor whose missing symbols live in sibling edits that haven't landed yet. ` +
			"Land the dependent edits together so the overlay only sees a compiling state: sequence them through an intermediate that still compiles (add the new import / declaration ALONGSIDE the old, switch the usages, then drop the old), or apply them as one batch if your toolset has a transactional multi-edit primitive."
		);
	}
	return (
		`${head} If this is a coordinated refactor (multiple symbols moving together), land the dependent edits as one unit — ` +
		"sequence them through an intermediate that still compiles, or use a transactional multi-edit primitive if your toolset exposes one — so the overlay checks only the final content."
	);
}
