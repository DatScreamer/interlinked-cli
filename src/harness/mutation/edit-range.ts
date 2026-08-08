// ===========================================
// Per-edit mutation scoping — measure the DIFF, not the file
// ===========================================
//
// The per-edit gate shipped the whole file to the runner and Stryker mutated
// all of it. A three-line edit to a 400-line module therefore paid for ~350
// mutants and reported survivors in functions the edit never touched — which is
// both slow (the run outgrows the per-edit budget, so the gate degrades to
// "not measured" exactly when it matters) and noisy (the agent is handed a list
// of pre-existing survivors as if its edit caused them).
//
// The wire already supports the fix. `range: {start, end}` is 1-based inclusive
// and the runner turns it into Stryker's `file:start-end` mutation range, then
// scopes the returned report to it. Until now only the SHARDING path set it,
// splitting one file across N runners; the single-runner path always sent the
// whole file.
//
// So: derive the changed span from the before/after content and send that.
//
// The span is a HULL over the changed lines, not a set of disjoint ranges — one
// request carries one range. For the edit shape this gate exists to judge (an
// agent's Edit/Write to one region) the hull is tight. A change scattered
// across a file degrades to a wider hull and, in the limit, to the whole file:
// slower, never wrong.

/** A 1-based inclusive line span, matching Stryker's mutation-range syntax and
 *  the runner's wire shape. Structurally identical to `Shard` (shard-plan.ts);
 *  kept separate because they answer different questions — one is "which slice
 *  is this runner responsible for", the other "what did this edit touch". */
export interface EditRange {
	start: number;
	end: number;
}

/**
 * How many lines of context to add on each side of the changed span.
 *
 * Stryker places a mutant at its AST node's START line, which can sit ABOVE the
 * line the edit changed: altering the second line of a multi-line `if (...)`
 * condition, or a property inside an object literal, mutates a node that begins
 * earlier. A zero-padding range would silently skip those mutants and report a
 * clean run — under-reporting, the failure mode this gate exists to prevent.
 *
 * Three lines covers the common multi-line-construct case without meaningfully
 * widening the run. It is not a proof of sufficiency: the padding is a
 * heuristic, and `wholeFile` remains the correct answer whenever the edit is
 * not clearly localized.
 */
export const EDIT_RANGE_CONTEXT_LINES = 3;

export type EditScope =
	/** Measure the entire file — a new file, or a change too diffuse to localize. */
	| { kind: "whole" }
	/** Measure only this span. */
	| { kind: "span"; range: EditRange }
	/** The content is byte-identical; there is nothing this edit could have changed. */
	| { kind: "none" };

/**
 * Fraction of a file's lines above which a "localized" span stops being worth
 * scoping. Past this the range costs a request round-trip's worth of bookkeeping
 * and saves little, and `--incremental` (which the runner enables only for
 * UNRANGED runs) is the better trade.
 */
const WHOLE_FILE_SPAN_FRACTION = 0.6;

function splitLines(content: string): string[] {
	return content.split("\n");
}

/**
 * Public API — what should the runner measure for this edit?
 *
 * Computed as a common-prefix / common-suffix hull rather than a real diff:
 * the answer needed is the smallest span containing every changed line, and
 * that is exactly (first line differing from the top) through (last line
 * differing from the bottom). An LCS would find the same hull at more cost,
 * because a hull cannot exploit the interior alignment an LCS recovers.
 *
 * `before === ""` means a newly created file, which is `whole` — there is no
 * prior state to diff against, and every line is new.
 */
export function editScope(before: string, after: string): EditScope {
	if (before === after) return { kind: "none" };
	if (before === "") return { kind: "whole" };

	const b = splitLines(before);
	const a = splitLines(after);

	let prefix = 0;
	while (prefix < b.length && prefix < a.length && b[prefix] === a[prefix]) prefix++;

	let suffix = 0;
	while (
		suffix < b.length - prefix &&
		suffix < a.length - prefix &&
		b[b.length - 1 - suffix] === a[a.length - 1 - suffix]
	) {
		suffix++;
	}

	// Changed region in the AFTER content, as 1-based inclusive lines. When the
	// edit is a pure deletion the region is empty (prefix meets suffix); anchor
	// on the join point so the surrounding code is still measured — a deletion
	// changes the behavior of what remains.
	const startLine = prefix + 1;
	const endLine = Math.max(startLine, a.length - suffix);

	const start = Math.max(1, startLine - EDIT_RANGE_CONTEXT_LINES);
	const end = Math.min(a.length, endLine + EDIT_RANGE_CONTEXT_LINES);

	if (end - start + 1 >= a.length * WHOLE_FILE_SPAN_FRACTION) return { kind: "whole" };
	return { kind: "span", range: { start, end } };
}

/**
 * Public API — one line describing what the gate measured, for the warning the
 * agent reads.
 *
 * Worth stating explicitly on every scoped run: a survivor count means something
 * different when it covers 40 lines than when it covers the file, and a reader
 * who assumes the latter will conclude the rest of the file is clean.
 */
export function describeEditScope(scope: EditScope, file: string): string {
	if (scope.kind === "none") return `${file}: unchanged`;
	if (scope.kind === "whole") return `${file}: whole file`;
	return `${file}: lines ${scope.range.start}-${scope.range.end} (the edited span)`;
}
