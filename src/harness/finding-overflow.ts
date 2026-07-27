// ===========================================
// Finding-list overflow rendering
// ===========================================
// One place that decides how many findings a check lists before summarizing
// the rest, and what the summary line looks like.
//
// This replaced nine hand-written copies of the same three-statement idiom:
//
//   const shown = items.slice(0, 5);
//   const detail = shown.map(render).join("\n");
//   const overflow = items.length > 5 ? `\n  ... and ${items.length - 5} more` : "";
//
// Each copy repeated its cap THREE times (slice, comparison, subtraction), so
// nine sites carried 27 cap literals. Nobody ever chose those numbers as
// policy — 5, 8, and 10 were each picked locally, in isolation, by whoever
// wrote that check. Output volume was therefore an emergent property of where
// the code happened to be written rather than a decision anyone made.
//
// With the cap named and defaulted, a site that wants the standard budget says
// nothing at all, and a site that deviates has to pass a number — which makes
// the deviation visible in review instead of invisible in a slice() call.

/**
 * Findings listed before the remainder is summarized. The default for every
 * call site that has no specific reason to differ.
 */
export const MAX_LISTED_FINDINGS = 5;

/**
 * Render up to `cap` items, followed by a `... and N more` line when the list
 * was truncated. Returns "" for an empty list, and omits the summary line
 * entirely when everything fits — both matching the previous per-site
 * behaviour exactly.
 */
export function listWithOverflow<T>(
	items: readonly T[],
	render: (item: T) => string,
	cap: number = MAX_LISTED_FINDINGS,
): string {
	const detail = items.slice(0, cap).map(render).join("\n");
	if (items.length <= cap) return detail;
	return `${detail}\n  ... and ${items.length - cap} more`;
}
