// ===========================================
// Per-edit mutation — identity quarantine state machine (build step 2, spec §6)
// ===========================================
// The safety net for identity instability: if a symbol's mutantId set churns
// while its content hash is unchanged, the identity key is misbehaving — so its
// survivors downgrade BLOCK → WARN until it proves stable again. Mirrors the
// coverage index's `ShardInstability` quarantine contract.

import type { IdentityInstability, StableId, SymbolRecord } from "./types.js";

const MAX_EVENTS = 20;

/** Do the recorded mutantIds differ from a fresh derivation (→ id churn)? */
export function mutantIdsChurned(prior: SymbolRecord, currentMutantIds: Set<StableId>): boolean {
	const recorded = Object.keys(prior.mutants);
	if (recorded.length !== currentMutantIds.size) return true;
	for (const id of recorded) {
		if (!currentMutantIds.has(id)) return true;
	}
	return false;
}

export interface InstabilityChange {
	churned: boolean;
	at: string;
	/** Consecutive stable runs required to clear a quarantine. */
	threshold: number;
}

/**
 * Quarantine state machine: churn → quarantine + reset; a stable run increments
 * and clears the quarantine once `threshold` consecutive stable runs accrue.
 */
export function updateInstability(prior: IdentityInstability, change: InstabilityChange): IdentityInstability {
	if (change.churned) {
		const event: IdentityInstability["events"][number] = { at: change.at, kind: "id_churn" };
		return {
			events: [...prior.events, event].slice(-MAX_EVENTS),
			consecutiveStableRuns: 0,
			quarantined: true,
		};
	}
	const consecutiveStableRuns = prior.consecutiveStableRuns + 1;
	return {
		events: prior.events,
		consecutiveStableRuns,
		quarantined: prior.quarantined && consecutiveStableRuns < change.threshold,
	};
}

export function freshInstability(): IdentityInstability {
	return { events: [], consecutiveStableRuns: 0, quarantined: false };
}
