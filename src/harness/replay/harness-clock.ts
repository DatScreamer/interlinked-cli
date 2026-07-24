// ===========================================
// G4 ambient clock — one time source for every decision branch
// ===========================================
// `harnessNow()` is the drop-in for `Date.now()` at DECISION-AFFECTING sites
// (reservation expiry, error-memory freshness, marker expiry, frequency
// windows, ...). Outside a scope it IS real time — zero behavior change on
// the live path. Inside `runWithClock(ts, fn)` every read returns the frozen
// timestamp, across await points, isolated per logical evaluation via
// AsyncLocalStorage — required because the daemon interleaves evaluations
// across socket connections (per-connection serial, no global mutex; audited
// + falsifier-confirmed 2026-07-24), so a module-global would bleed between
// concurrent events (docs/design/reproducibility/g4-harness-determinism.md).
//
// Replay mode (Tier 2) wraps each recorded event's evaluation in
// runWithClock(event.ts_ms) so time-window branches reproduce their recorded
// verdicts byte-for-byte.

import { AsyncLocalStorage } from "node:async_hooks";

const clockStore = new AsyncLocalStorage<{ now: number }>();

/** Milliseconds since epoch: the scope's frozen time, else real time. */
export function harnessNow(): number {
	return clockStore.getStore()?.now ?? Date.now();
}

/** Run `fn` with the clock frozen at `nowMs`. Nestable; the scope ends when
 *  the (possibly async) body settles. */
export function runWithClock<T>(nowMs: number, fn: () => T): T {
	return clockStore.run({ now: nowMs }, fn);
}
