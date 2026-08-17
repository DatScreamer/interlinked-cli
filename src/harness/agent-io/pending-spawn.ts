// ===========================================
// Pending-spawn registry — the spawn-call ↔ agent-id bridge
// ===========================================
// The spawn CALL and the `SubagentStart` that follows it share NO id: the
// PreToolUse row has a `tool_use_id`, the start event has an unrelated
// `subagent_id`, and the transcript has an `agent_id` that agrees only with
// the latter (design F6). So the prompt and the agent it belongs to sit in two
// records with nothing between them.
//
// This binds them the way `rememberAgentType` already binds labels: a bounded,
// insertion-ordered per-session map of spawns that have fired but not yet been
// claimed, drained FIFO by the next start event in the same session whose
// `agent_type` matches the spawn's `subagent_type`.
//
// It is deliberately conservative. An unclaimed spawn expires by eviction and
// an ambiguous one is left unbound — a prompt row with no agent id is strictly
// better than no row, and better still than a guessed id that quietly
// misattributes one agent's instruction to another.

/** One spawn call awaiting its agent. */
export interface PendingSpawn {
	session: string | null;
	/** The `subagent_type` argument of the spawn call, when it carried one. */
	subagentType: string | null;
	toolUseId: string | null;
	ts: string;
}

/** Bound on unclaimed spawns held per daemon. Insertion-ordered, so eviction
 *  drops the oldest — the ones whose start event has almost certainly already
 *  fired (or never will). */
export const MAX_PENDING_SPAWNS = 500;

const pending: PendingSpawn[] = [];

/** Record a spawn call that has not yet been matched to an agent. */
export function rememberPendingSpawn(spawn: PendingSpawn): void {
	pending.push(spawn);
	if (pending.length > MAX_PENDING_SPAWNS) pending.splice(0, pending.length - MAX_PENDING_SPAWNS);
}

/**
 * Claim the oldest pending spawn for this session whose `subagentType` matches
 * `agentType`. A spawn that carried no type matches anything (the runner
 * simply did not say); a spawn with a DIFFERENT type never matches. Returns
 * null when nothing matches — the caller then records an unbound row rather
 * than guessing.
 */
export function claimPendingSpawn(
	session: string | null,
	agentType: string | null,
): PendingSpawn | null {
	for (let i = 0; i < pending.length; i++) {
		const candidate = pending[i];
		if (!candidate) continue;
		if (candidate.session !== session) continue;
		if (candidate.subagentType !== null && agentType !== null && candidate.subagentType !== agentType) {
			continue;
		}
		pending.splice(i, 1);
		return candidate;
	}
	return null;
}

/** Test seam — drop every unclaimed spawn. */
export function resetPendingSpawns(): void {
	pending.length = 0;
}

/** Test seam — how many spawns are waiting. */
export function pendingSpawnCount(): number {
	return pending.length;
}
