// ===========================================
// Active-Skill Markers
// ===========================================
// Per-session markers populated by `interlinked skill enter <name>` and
// agent-native skill-lifecycle hooks. Read by the active_when predicate
// evaluator to scope distilled rules. See harness-active-when-scoping.md.
//
// Lifted out of session-state.ts to keep that file under the per-file line
// cap. The public helpers are re-exported from session-state.ts so existing
// `from "./session-state.js"` importers keep working unchanged.

import { harnessNow } from "./replay/harness-clock.js";
import type { ActiveSkillRecord, SessionTrajectory } from "./types.js";

const DEFAULT_SKILL_TTL_MS = 30 * 60 * 1000;
const MAX_SKILL_TTL_MS = 4 * 60 * 60 * 1000;
const MIN_SKILL_TTL_MS = 60 * 1000;

export interface SkillEnterArgs {
	name: string;
	/** Override default TTL (30 min). Clamped to [60s, 4h]. */
	ttl_seconds?: number;
	/** "cli" = explicit `interlinked skill enter`; "hook" = agent-native event; "manual" = enable-side toggle. */
	source?: ActiveSkillRecord["source"];
}

/** Record that a skill is now active for this session. Replaces any existing
 *  marker for the same name (re-entering refreshes the TTL). */
export function recordSkillEnter(
	session: SessionTrajectory,
	args: SkillEnterArgs,
): ActiveSkillRecord {
	if (!session.active_skills) session.active_skills = new Map();
	const requestedSec = args.ttl_seconds ?? DEFAULT_SKILL_TTL_MS / 1000;
	const ttlMs = Math.min(MAX_SKILL_TTL_MS, Math.max(MIN_SKILL_TTL_MS, requestedSec * 1000));
	const now = harnessNow();
	const record: ActiveSkillRecord = {
		name: args.name,
		entered_at: now,
		expires_at: now + ttlMs,
		source: args.source ?? "cli",
	};
	session.active_skills.set(args.name, record);
	return record;
}

/** Remove a skill marker. Returns true if a marker existed. */
export function recordSkillLeave(session: SessionTrajectory, name: string): boolean {
	if (!session.active_skills) return false;
	return session.active_skills.delete(name);
}

/** Drop expired markers in-place. Called on every event so stale markers
 *  don't leak past their TTL even if no `skill_leave` arrived. */
export function gcExpiredSkills(session: SessionTrajectory): number {
	if (!session.active_skills || session.active_skills.size === 0) return 0;
	const now = harnessNow();
	let removed = 0;
	for (const [name, record] of session.active_skills) {
		if (record.expires_at <= now) {
			session.active_skills.delete(name);
			removed++;
		}
	}
	return removed;
}

/** Snapshot of currently-active skills (post-GC) for read-only consumers. */
export function getActiveSkills(session: SessionTrajectory): ActiveSkillRecord[] {
	gcExpiredSkills(session);
	if (!session.active_skills) return [];
	return [...session.active_skills.values()];
}
