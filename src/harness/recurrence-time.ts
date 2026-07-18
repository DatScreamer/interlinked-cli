// Time / duration helpers for recurrence aggregation, split out of
// recurrence.ts for the per-file line cap. All NaN-safe: malformed timestamps
// and overflowing durations fail closed (null / ignored) rather than throwing
// or corrupting bounds.

import { nonNull } from "../lib/non-null.js";

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

const DURATION_UNITS_MS: Record<string, number> = {
	s: MS_PER_SECOND,
	m: SECONDS_PER_MINUTE * MS_PER_SECOND,
	h: MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
	d: HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
	w: DAYS_PER_WEEK * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
};

/** Parse a "<n><s|m|h|d|w>" duration to milliseconds, or null. */
export function parseDurationMs(input: string): number | null {
	const match = /^\s*(\d+)\s*([smhdw])\s*$/i.exec(input);
	if (!match) return null;
	const amount = Number(match[1]);
	const unitMs = DURATION_UNITS_MS[nonNull(match[2]).toLowerCase()];
	if (!Number.isFinite(amount) || !unitMs) return null;
	// Validate the PRODUCT too (round-12 sol #3): a finite but enormous amount
	// can overflow to Infinity, which would later throw in `new Date(- Infinity)`.
	const ms = amount * unitMs;
	return Number.isFinite(ms) ? ms : null;
}

/** Resolve a `--since` value (relative duration or absolute ISO) to an absolute
 *  ISO cutoff, or null. Fail-closed on a malformed reference clock or result. */
export function resolveSinceCutoff(
	input: string | undefined,
	now: Date = new Date(),
): string | null {
	if (!input) return null;
	const duration = parseDurationMs(input);
	if (duration !== null) {
		// Guard the resulting date (round-12 sol #3): a non-finite offset (or an
		// invalid `now`) would make toISOString() throw instead of returning null.
		const cutoff = new Date(now.getTime() - duration);
		return Number.isNaN(cutoff.getTime()) ? null : cutoff.toISOString();
	}
	const parsed = new Date(input);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

/** Widen a bucket's [first_seen, last_seen] with a new timestamp, NaN-safe: a
 *  valid timestamp replaces a malformed bound and updates the min/max; a
 *  malformed timestamp is ignored so one bad row can't corrupt both bounds
 *  (round-17 sol #2). */
export function updateSeenBounds(
	row: { first_seen: string; last_seen: string },
	ts: string,
): void {
	const ms = new Date(ts).getTime();
	if (!Number.isFinite(ms)) return;
	const firstMs = new Date(row.first_seen).getTime();
	const lastMs = new Date(row.last_seen).getTime();
	if (!Number.isFinite(firstMs) || ms < firstMs) row.first_seen = ts;
	if (!Number.isFinite(lastMs) || ms > lastMs) row.last_seen = ts;
}
