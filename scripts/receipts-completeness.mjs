// =====================================================================
// Receipts completeness guard
// =====================================================================
// `landing/receipts.json` backs PUBLIC claims about how many things the
// guard blocked, and the landing page's `data_as_of` marker is the stamp
// asserting those numbers are current.
//
// Every source the audit reads is append-only history. If a segment is
// missing from disk, recomputed totals are not "newer" — they are short by
// whatever that segment held. Writing them anyway silently converts a
// data-loss event into a published understatement.
//
// Observed 2026-07-26: three segments had been pruned, and a plain re-run
// would have rewritten 865 verified / 1081 logged down to 327 / 549 — a 62%
// drop, with the window start jumping forward 19 days. The blocks really
// happened; only the evidence was gone. The audit warned once per missing
// segment and then wrote regardless, so the loss scrolled past in three
// lines and would have been permanent in the committed file.
//
// Extracted from `audit-receipts.mjs` rather than inlined: that file sits at
// the per-file line cap, and a guard protecting a public-facing number is
// worth testing on its own.

/** Sources the audit could not read, in the order the audit declared them. */
export function missingSources(result) {
	return (result?.sources ?? []).filter((s) => s?.missing);
}

/**
 * Operator-facing refusal message when history is incomplete, or null when
 * every segment was readable and the write may proceed.
 *
 * Returns a string rather than throwing so the caller decides the exit path
 * (the audit also has a `--json` mode that must stay pipe-clean).
 */
export function incompleteHistoryError(result) {
	const missing = missingSources(result);
	if (missing.length === 0) return null;

	const list = missing.map((s) => `  - ${s.file}`).join("\n");
	const verified = result?.total_verified ?? "?";
	const logged = result?.total_logged ?? "?";
	const start = result?.window_start?.slice(0, 10) ?? "?";

	return (
		`\n[audit] REFUSING to write receipts — ${missing.length} history segment(s) missing:\n` +
		`${list}\n\n` +
		`These are append-only history. Recomputing without them UNDERSTATES the\n` +
		`totals rather than updating them (this run: ${verified} verified / ${logged} logged,\n` +
		`window starting ${start}).\n\n` +
		`Restore the segments, or re-run with --allow-partial to accept the\n` +
		`smaller window deliberately.\n`
	);
}
