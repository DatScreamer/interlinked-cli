// ===========================================
// Per-edit mutation — manifest self-heal on load
// ===========================================
// Extracted out of manifest.ts (2026-07-31, over the line cap) — converge an
// already-corrupted `files` map instead of leaving it broken forever. Two
// classes of corruption, both from the SAME root cause (a `file` key reaching
// the manifest without funneling through `normalizeManifestKey`, manifest.ts):
//   - two raw keys resolve to the SAME canonical path (an absolute-path write
//     duplicating a repo-relative one, or vice versa) — merged, not discarded.
//   - a raw key resolves to a test/spec file — dropped outright (mutating a
//     test proves nothing; see `MutationManifestTestTargetError`).
// Called from `loadManifest` only; every function here is a pure fold over the
// parsed `files` map.

import { isTestPath } from "../coverage-test-selector.js";
import { normalizeManifestKey } from "./manifest-key.js";
import type { IdentityInstability, MutantRecord, MutantStatus, StableId, SymbolRecord } from "./types.js";

/** Caution ranking for a status conflict when merging two duplicate copies of
 *  the SAME mutantId (see `mergeMutantRecord`). Higher wins — a merge must
 *  never silently clear a survivor one of the two copies recorded; that would
 *  read as the ratchet auto-resolving itself without a real new measurement. */
const STATUS_CAUTION_RANK: Record<MutantStatus, number> = {
	survived: 50,
	uncovered: 40,
	indeterminate: 30,
	timeout: 20,
	killed: 10,
	equivalent: 0,
};

/** Pick whichever of two same-shaped optional values is defined, merging when
 *  both are. Every call site derives its key from the UNION of both sides' own
 *  keys, so at least one is always present — never both undefined. */
function pickDefined<T>(a: T | undefined, b: T | undefined, merge: (a: T, b: T) => T): T {
	if (a !== undefined && b !== undefined) return merge(a, b);
	if (a !== undefined) return a;
	// SAFETY: the union-of-keys precondition above guarantees `b` is defined
	// whenever `a` is not.
	return b as T;
}

/**
 * Merge two records for the SAME mutantId (same symbolId, same symbolHash on
 * both sides). A reviewed judgment — `disposition` or the legacy
 * `accepted_reason` — always wins: it is a certificate- or human-backed
 * finding and must never be silently overridden by an unreviewed duplicate.
 * Otherwise the MORE CAUTIOUS status wins ({@link STATUS_CAUTION_RANK}).
 * `firstSeen` always takes the EARLIER of the two, independent of which side's
 * status wins — it is the true first sighting, not a property of the verdict.
 */
function mergeMutantRecord(a: MutantRecord, b: MutantRecord): MutantRecord {
	const judged = (r: MutantRecord) => r.disposition !== undefined || r.accepted_reason !== undefined;
	let winner: MutantRecord;
	if (judged(a) !== judged(b)) {
		winner = judged(a) ? a : b;
	} else {
		winner = STATUS_CAUTION_RANK[a.status] >= STATUS_CAUTION_RANK[b.status] ? a : b;
	}
	return { ...winner, firstSeen: a.firstSeen <= b.firstSeen ? a.firstSeen : b.firstSeen };
}

function eventKey(e: IdentityInstability["events"][number]): string {
	return `${e.at}|${e.kind}`;
}

/** Merge two instability records: union the event log (deduped by `at`+`kind`),
 *  the LOWER consecutive-stable-run count (a merge is not itself a new stable
 *  run), and `quarantined` true if EITHER side says so — never silently
 *  un-quarantine a symbol on merge; that flag exists because a survivor
 *  became unreliable, and a duplicate-key artifact is not new evidence against it. */
function mergeInstability(a: IdentityInstability, b: IdentityInstability): IdentityInstability {
	const seen = new Set<string>();
	const events = [...a.events, ...b.events].filter((e) => {
		const key = eventKey(e);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	events.sort((x, y) => x.at.localeCompare(y.at));
	return {
		events,
		consecutiveStableRuns: Math.min(a.consecutiveStableRuns, b.consecutiveStableRuns),
		quarantined: a.quarantined || b.quarantined,
	};
}

/** The most recent `firstSeen` across a symbol's own mutants — the recency
 *  proxy `mergeSymbolRecord` uses when two duplicate copies of a symbolId
 *  disagree on `symbolHash` (no per-symbol timestamp exists to compare directly). */
function latestFirstSeen(s: SymbolRecord): string {
	let max = "";
	for (const m of Object.values(s.mutants)) if (m.firstSeen > max) max = m.firstSeen;
	return max;
}

/**
 * Merge two records for the SAME symbolId. Matching `symbolHash` ⇒ they
 * describe the SAME code state, so it is safe to union their `mutants` (per-id
 * conflicts via `mergeMutantRecord`) and their instability. Differing
 * `symbolHash` ⇒ NOT mergeable — the two sides observed different edits of the
 * symbol, and a mutantId is only meaningful against the hash it was derived
 * from, so combining them would misattribute mutants to a hash they don't
 * belong to. Keep whichever side has the more recent evidence and drop the
 * other, mirroring `applyMeasuredRun`'s own precedent that a symbol no longer
 * present in a fresh measurement is dropped, not preserved forever.
 */
function mergeSymbolRecord(a: SymbolRecord, b: SymbolRecord): SymbolRecord {
	if (a.symbolHash !== b.symbolHash) return latestFirstSeen(a) >= latestFirstSeen(b) ? a : b;
	const mutants: Record<StableId, MutantRecord> = {};
	for (const id of new Set([...Object.keys(a.mutants), ...Object.keys(b.mutants)])) {
		mutants[id] = pickDefined(a.mutants[id], b.mutants[id], mergeMutantRecord);
	}
	return { ...a, mutants, instability: mergeInstability(a.instability, b.instability) };
}

/** Merge two file entries (symbolId → SymbolRecord) that resolved to the SAME
 *  canonical manifest key — the per-symbol half of `healManifestFiles`. */
function mergeFileRecords(
	a: Record<StableId, SymbolRecord>,
	b: Record<StableId, SymbolRecord>,
): Record<StableId, SymbolRecord> {
	const out: Record<StableId, SymbolRecord> = {};
	for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
		out[id] = pickDefined(a[id], b[id], mergeSymbolRecord);
	}
	return out;
}

/**
 * True when every raw key is ALREADY the canonical form (no normalization
 * needed, not a test path, no two keys colliding) — the overwhelmingly common
 * case once every writer funnels through `normalizeManifestKey`. Lets
 * `healManifestFiles` return the input UNCHANGED (same object reference, zero
 * allocation) instead of rebuilding a ~700-entry top-level map on every cold
 * parse purely to reproduce it verbatim. Detect-then-copy, never
 * copy-then-detect: a healthy manifest costs one scan, not a rebuild.
 */
function isAlreadyCanonical(files: Record<string, Record<StableId, SymbolRecord>>, cwd: string): boolean {
	const seen = new Set<string>();
	for (const rawKey of Object.keys(files)) {
		const key = normalizeManifestKey(rawKey, cwd);
		if (key !== rawKey || isTestPath(key) || seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

/**
 * Self-heal an already-corrupted `files` map on LOAD: every raw key is passed
 * through `normalizeManifestKey`; a key that resolves to a test/spec file is
 * DROPPED (mutating a test proves nothing — see `MutationManifestTestTargetError`
 * in manifest.ts); two raw keys that resolve to the SAME canonical key are
 * merged (`mergeFileRecords`) rather than one silently shadowing the other,
 * which is what a plain `{...a, ...b}` object-spread would do to `raw.files`
 * if this function didn't exist.
 *
 * Only heals the in-memory value `loadManifest` returns — it does not rewrite
 * the file itself. Rewriting on every read would add a write to the per-edit
 * hot-path load (this runs on every PreToolUse) purely to fix a legacy shape;
 * instead the FIRST measured-clean pass after this ships persists the healed
 * shape for every file it's holding — not just the one edited — because
 * `applyMeasuredRun` spreads `{...base.files, [file]: nextFile}` over an
 * already-healed `base`. The file converges within one clean pass rather than
 * needing a dedicated migration step.
 */
export function healManifestFiles(
	files: Record<string, Record<StableId, SymbolRecord>>,
	cwd: string,
): Record<string, Record<StableId, SymbolRecord>> {
	if (isAlreadyCanonical(files, cwd)) return files;
	const merged: Record<string, Record<StableId, SymbolRecord>> = {};
	for (const [rawKey, symbols] of Object.entries(files)) {
		const key = normalizeManifestKey(rawKey, cwd);
		if (isTestPath(key)) continue;
		const existing = merged[key];
		merged[key] = existing ? mergeFileRecords(existing, symbols) : symbols;
	}
	return merged;
}
