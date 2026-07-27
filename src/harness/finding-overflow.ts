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

// SCOPE — harness findings only. `src/commands/` keeps three hand-written
// truncations (index-cmd 50 file paths, status-full-render 5 commits, watch 12
// tasks) and they are DELIBERATELY not migrated. They differ in every way that
// made the harness sites worth unifying: they build `string[]` line arrays or
// call console.log per item rather than one `detail` string, they indent 2 / 6
// / 4 spaces rather than a uniform 2, two style the overflow with `c.dim()`,
// and their caps were each chosen for a reason rather than typed by accident.
//
// The deeper difference is the reader. These caps govern agent CONTEXT SPEND —
// an unbudgeted cost the agent cannot opt out of. The CLI ones govern terminal
// scrollback for a human who can re-run with different arguments. Migrating
// them would mean parameterizing this helper on indent and ANSI styling to
// serve two unrelated readers. Don't.

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
