// ===========================================
// Per-edit mutation — read-side survivor-diff helpers (extracted from
// manifest.ts, 2026-08-25, for the 500-line cap)
// ===========================================
// The pure READ half of the manifest: which symbols changed, which survivors
// are accepted, what each mutant's prior status was. manifest.ts keeps the
// write half (refresh + persistence) and re-exports these for its existing
// importers, so `from "./manifest.js"` call sites are untouched.

import type { SymbolHashEntry } from "./identity.js";
import { normalizeManifestKey } from "./manifest-key.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationManifest,
	StableId,
	SymbolRecord,
} from "./types.js";

/** Every read of a file's records funnels through `normalizeManifestKey` too —
 *  a caller that still hands in an absolute/`./`/backslash path reads the
 *  SAME record `applyMeasuredRun` would write, instead of silently missing it. */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for manifest path helpers (see manifest-key.ts); branded ManifestKey refactor is tracked work
export function fileRecords(
	manifest: MutationManifest,
	file: string,
	cwd?: string,
): Record<StableId, SymbolRecord> {
	return manifest.files[normalizeManifestKey(file, cwd)] ?? {};
}

/**
 * Has this file ever been measured into the manifest?
 *
 * False means there is no prior state to diff against, so "changed region" is
 * meaningless — EVERY symbol reads as changed and every existing survivor reads
 * as new. Judging an edit against that produces a guaranteed rejection whose
 * size reflects the file, not the change. Callers use this to treat the first
 * measurement of a file as BASELINE ESTABLISHMENT rather than a verdict.
 */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for manifest path helpers (see manifest-key.ts); branded ManifestKey refactor is tracked work
export function hasFileBaseline(manifest: MutationManifest, file: string, cwd?: string): boolean {
	return Object.keys(fileRecords(manifest, file, cwd)).length > 0;
}

/** Symbols whose hash differs from the base manifest (or are new) — the changed region (spec §3). */
// interlinked: defer function_arg_count -- positional (base, next, file, cwd) mirrors the survivor-diff call sites; options-object refactor tracked with the branded-key work
export function changedSymbols(
	base: MutationManifest,
	file: string,
	overlayHashes: Map<StableId, SymbolHashEntry>,
	cwd?: string,
): Set<StableId> {
	const records = fileRecords(base, file, cwd);
	const changed = new Set<StableId>();
	for (const [symbolId, entry] of overlayHashes) {
		const prior = records[symbolId];
		if (!prior || prior.symbolHash !== entry.symbolHash) changed.add(symbolId);
	}
	return changed;
}

/** Prior mutant ids that disappeared from an unchanged symbol's current run.
 * A missing row is not a legitimate refresh: it could be an unreported
 * survivor. Changed symbols are excluded because their mutation census may
 * legitimately change with the source. */
export function missingUnchangedMutants(
	base: MutationManifest,
	file: string,
	overlayHashes: Map<StableId, SymbolHashEntry>,
	measured: readonly MeasuredMutant[],
	cwd?: string,
): StableId[] {
	const prior = fileRecords(base, file, cwd);
	const measuredBySymbol = new Map<StableId, Set<StableId>>();
	for (const mutant of measured) {
		const ids = measuredBySymbol.get(mutant.identity.symbolId) ?? new Set<StableId>();
		ids.add(mutant.identity.mutantId);
		measuredBySymbol.set(mutant.identity.symbolId, ids);
	}
	const missing: StableId[] = [];
	for (const [symbolId, entry] of overlayHashes) {
		const previous = prior[symbolId];
		if (previous === undefined || previous.symbolHash !== entry.symbolHash) continue;
		const current = measuredBySymbol.get(symbolId) ?? new Set<StableId>();
		for (const mutantId of Object.keys(previous.mutants)) {
			if (!current.has(mutantId)) missing.push(mutantId);
		}
	}
	return missing;
}

/** mutantIds accepted (grandfathered survivors + reviewed equivalents) in the base. */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for manifest path helpers (see manifest-key.ts); branded ManifestKey refactor is tracked work
export function acceptedSurvivors(base: MutationManifest, file: string, cwd?: string): Set<StableId> {
	const out = new Set<StableId>();
	for (const symbol of Object.values(fileRecords(base, file, cwd))) {
		for (const m of Object.values(symbol.mutants)) {
			if (m.status === "survived" || m.status === "equivalent") out.add(m.mutantId);
		}
	}
	return out;
}

/** Prior status per mutantId — the baseline for status-TRANSITION checks
 *  (review 2026-08-25, pass 6: killed→uncovered is a regression too, but a
 *  mutant that was ALWAYS uncovered is not; set membership cannot tell those
 *  apart, only the recorded prior status can). */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for manifest path helpers (see manifest-key.ts); branded ManifestKey refactor is tracked work
export function priorStatuses(
	base: MutationManifest,
	file: string,
	cwd?: string,
): Map<StableId, MutantStatus> {
	const out = new Map<StableId, MutantStatus>();
	for (const symbol of Object.values(fileRecords(base, file, cwd))) {
		for (const m of Object.values(symbol.mutants)) out.set(m.mutantId, m.status);
	}
	return out;
}

/** symbolIds currently quarantined (identity unstable → survivors WARN, not BLOCK). */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for manifest path helpers (see manifest-key.ts); branded ManifestKey refactor is tracked work
export function quarantinedSymbols(base: MutationManifest, file: string, cwd?: string): Set<StableId> {
	const out = new Set<StableId>();
	for (const [symbolId, symbol] of Object.entries(fileRecords(base, file, cwd))) {
		if (symbol.instability.quarantined) out.add(symbolId);
	}
	return out;
}

/** The one MutantRecord constructor — manifest.ts's refresh path and
 *  evaluate.ts's regression records both build records through here. */
export function toMutantRecord(
	identity: MutantIdentity,
	status: MutantStatus,
	firstSeen: string,
): MutantRecord {
	return {
		mutantId: identity.mutantId,
		siteId: identity.siteId,
		mutator: identity.mutator,
		originalLexeme: identity.originalLexeme,
		replacement: identity.replacement,
		ordinalWithinSymbol: identity.ordinalWithinSymbol,
		status,
		firstSeen,
	};
}

export interface MeasuredMutant {
	identity: MutantIdentity;
	status: MutantStatus;
}

export interface SurvivorDiffSets {
	changed: Set<StableId>;
	accepted: Set<StableId>;
	quarantined: Set<StableId>;
}

/**
 * The invariant (spec §5): a NEW changed-region survivor is a `survived` mutant
 * whose symbol changed, not already accepted, in a non-quarantined symbol. These
 * are the records that BLOCK; survivors in quarantined symbols are handled as
 * WARN by the caller.
 */
export function computeNewSurvivors(
	measured: MeasuredMutant[],
	sets: SurvivorDiffSets,
	firstSeen: string,
): MutantRecord[] {
	const out: MutantRecord[] = [];
	for (const m of measured) {
		const id = m.identity;
		const isNewSurvivor =
			m.status === "survived" &&
			sets.changed.has(id.symbolId) &&
			!sets.accepted.has(id.mutantId) &&
			!sets.quarantined.has(id.symbolId);
		if (isNewSurvivor) out.push(toMutantRecord(id, m.status, firstSeen));
	}
	return out;
}
