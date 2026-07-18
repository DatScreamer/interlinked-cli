// ===========================================
// Per-edit property-test budget (DW P0.1 — bounded-N property runs)
// ===========================================
// When the per-edit coverage gate runs a SCOPED suite it sets
// INTERLINKED_PROPERTY_NUMRUNS so fast-check caps its case count — a property
// test that would run hundreds of cases fits the tight per-edit latency budget
// instead of blowing it. A no-op (full numRuns) for normal / CI runs where the
// env is unset, so coverage and CI keep their full search. Wired as a vitest
// setupFile; the parse is a pure function so it is unit-testable without the
// global side effect.
//
// NOTE (the divergence, now built on request): this is a LATENCY lever, not a
// correctness one — capping cases trades property-search depth for per-edit
// speed. The full-N runs still happen in coverage / CI / the commit gate.

/** Parse the env budget into a positive integer numRuns, or null when unset /
 *  invalid (→ leave fast-check at its default). */
export function parsePropertyBudget(raw: string | undefined): number | null {
	if (!raw) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

// --- vitest setupFile side effect (runs on import, before the test files) ---
// Guarded so importing this module in a test with the env unset is inert (no
// fast-check load, no global mutation).
const budget = parsePropertyBudget(process.env.INTERLINKED_PROPERTY_NUMRUNS);
if (budget !== null) {
	try {
		const fc = await import("fast-check");
		fc.configureGlobal({ ...fc.readConfigureGlobal(), numRuns: budget });
	} catch (err) {
		void err; // fast-check not resolvable in this project — nothing to cap
	}
}
