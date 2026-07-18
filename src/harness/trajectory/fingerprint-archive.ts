// ===========================================
// Armed-fingerprint archive — continuity across daemon restarts (P1)
// ===========================================
// The armed set lives in-memory on the session (block-fingerprint-session.ts).
// In THIS repo the common restart is the build-refresh handover — a newer build
// takes over mid-session, same session_id, and the in-memory armed set is gone.
// Without persistence, every rebuild silently disarms workaround detection right
// when a block is freshest. This module write-throughs the armed set to a
// per-session file on each arm and hydrates it back on the first event a fresh
// daemon sees for that session.
//
// DIVERGENCE from the plan's literal "SessionStart preload": SessionStart fires
// once per session and never re-fires on a mid-session daemon restart, and the
// 15-min TTL means a truly prior session's fingerprints are expired by the time
// a new session starts. Keying on session_id + hydrating on first-event serves
// the stated intent ("continuity across restarts") where SessionStart-only would
// be inert. See block-fingerprint-session.ts for the consumer.
//
// Best-effort + fail-open: any fs error leaves detection working in-memory —
// persistence is a durability bonus, never a correctness dependency. Shingles
// (a Set) round-trip through an array for JSON.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BlockFingerprint, pruneExpired } from "./block-fingerprint.js";
import type { WorkaroundSignal } from "./block-fingerprint-session.js";

interface ArchivedFingerprint {
	ruleId: string;
	shingles: string[];
	target: string | null;
	atMs: number;
}

interface ArchiveShape {
	fingerprints: ArchivedFingerprint[];
	signals: WorkaroundSignal[];
}

/** Per-session archive file. session_id is sanitized to a safe basename. */
function archivePath(cwd: string, sessionId: string): string {
	const safe = sessionId.replace(/[^\w.-]/g, "_") || "unknown";
	return join(cwd, ".interlinked", "trajectory-armed", `${safe}.json`);
}

/** Write-through the session's armed set + noted signals. Best-effort. */
export function persistArmedFingerprints(
	cwd: string,
	sessionId: string,
	fingerprints: readonly BlockFingerprint[],
	signals: readonly WorkaroundSignal[],
): void {
	try {
		const p = archivePath(cwd, sessionId);
		mkdirSync(dirname(p), { recursive: true });
		const shape: ArchiveShape = {
			fingerprints: fingerprints.map((f) => ({
				ruleId: f.ruleId,
				shingles: [...f.shingles],
				target: f.target,
				atMs: f.atMs,
			})),
			signals: [...signals],
		};
		writeFileSync(p, JSON.stringify(shape));
	} catch (err) {
		void err; // durability bonus only — never break the tool loop on an fs error
	}
}

/** Load + rehydrate a session's armed set, dropping expired fingerprints.
 *  Returns null when there is no archive (or it is unreadable). */
export function loadArmedFingerprints(
	cwd: string,
	sessionId: string,
	nowMs: number,
): { fingerprints: BlockFingerprint[]; signals: WorkaroundSignal[] } | null {
	try {
		const p = archivePath(cwd, sessionId);
		if (!existsSync(p)) return null;
		const shape = JSON.parse(readFileSync(p, "utf-8")) as ArchiveShape;
		const hydrated: BlockFingerprint[] = (shape.fingerprints ?? []).map((f) => ({
			ruleId: f.ruleId,
			shingles: new Set(f.shingles),
			target: f.target,
			atMs: f.atMs,
		}));
		return { fingerprints: pruneExpired(hydrated, nowMs), signals: shape.signals ?? [] };
	} catch (err) {
		void err; // a corrupt archive must not brick detection — fall back to in-memory
		return null;
	}
}

/** Remove a session's archive (SessionEnd cleanup — the session is over, so its
 *  armed set can never be resurfaced against). Best-effort. */
export function clearArchive(cwd: string, sessionId: string): void {
	try {
		rmSync(archivePath(cwd, sessionId), { force: true });
	} catch (err) {
		void err; // orphan archives are swept by the SessionEnd batch GC (P2)
	}
}
