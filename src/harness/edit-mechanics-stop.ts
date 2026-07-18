// ===========================================
// Edit-mechanics Stop reflection — LG-5 (edit-contract-hardening.md)
// ===========================================
//
// One nudge at Stop when the session burned real round-trips on edits the
// client was always going to reject (doomed anchors), summarizing how many
// were rescued in one round trip and what the underlying pattern usually is
// (editing from memory instead of from current file content). Sibling of
// commit-cadence.ts: formatter returns `string | null`, never blocks,
// stderr-only via the Stop warnings channel.

import type { SessionTrajectory } from "./types.js";

/** Doomed-edit count at which the Stop nudge fires. */
const EDIT_MECHANICS_STOP_THRESHOLD = 3;

/** Build the Stop-time edit-mechanics nudge, or null below the threshold. */
export function buildEditMechanicsStopNudge(session: SessionTrajectory): string | null {
	const mechanics = session.edit_mechanics;
	if (!mechanics || mechanics.doomed < EDIT_MECHANICS_STOP_THRESHOLD) return null;
	const parts = [
		`${mechanics.doomed} edit(s) this session were dead on arrival (anchor missing or ambiguous)`,
	];
	if (mechanics.rescued > 0) parts.push(`${mechanics.rescued} recovered in one round trip`);
	if (mechanics.stale_reads > 0) {
		parts.push(`${mechanics.stale_reads} targeted file(s) that drifted after your last read`);
	}
	if (mechanics.blind_edits > 0) {
		parts.push(`${mechanics.blind_edits} anchored on lines never displayed this session`);
	}
	return (
		`[interlinked:edit-mechanics] ${parts.join("; ")}. ` +
		`Doomed edits usually mean editing from memory — copy anchors from current file content ` +
		`(the rescue block in each rejection carries it verbatim).`
	);
}
