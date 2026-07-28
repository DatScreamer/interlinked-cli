// ===========================================
// Per-edit mutation — brownfield adoption
// ===========================================
// The per-edit gate persists a manifest ONLY on a measured-clean pass, and that
// rule is right: if a dirty run could write the baseline, an agent could
// introduce a survivor and have it silently become the accepted floor. That is
// laundering, and it defeats the ratchet.
//
// But it has a consequence that makes the gate greenfield-only: on legacy code
// most files are NOT clean, so they never earn a baseline, stay permanently in
// first-sighting mode, and can never be enforced. Measured on this repo
// 2026-07-28: 9 files out of 1070 had a baseline after months of use.
//
// Adoption is the way out, and it is the same shape every other ratchet here
// already uses — the line cap grandfathers a high-water count per file, coverage
// grandfathers a per-file percentage, and both then allow only improvement.
// Mutation grandfathers the survivors that already exist: they are recorded with
// their measured status, `acceptedSurvivors` treats them as the floor, and
// `computeNewSurvivors` blocks only what an edit ADDS beyond it.
//
// The safety property is preserved by SEPARATION, not by weakening the rule: the
// per-edit path still refuses to persist a dirty run. Only this explicit,
// operator-invoked path may establish a floor from dirty state, and the floor is
// shrink-only afterwards under the baseline-integrity gate.

import { computeSymbolHashes, deriveIdentities } from "./identity.js";
import { applyMeasuredRun, type MeasuredMutant } from "./manifest.js";
import { strykerToAdapted } from "./stryker-adapter.js";
import type { MutationManifest } from "./types.js";

export interface SeedArgs {
	/** Manifest to extend — pass the previous result to seed many files. */
	base: MutationManifest;
	/** Repo-relative path of the file being adopted. */
	file: string;
	/** The exact source the report was measured against. */
	content: string;
	/** Raw Stryker JSON for this file. */
	report: unknown;
	/** ISO timestamp recorded as `firstSeen` for newly-recorded mutants. */
	at: string;
}

/**
 * Establish a baseline for one file from a possibly-DIRTY measurement.
 *
 * Returns the extended manifest, or null when the report cannot be trusted to
 * describe this file. Null is important: an EMPTY baseline is worse than none,
 * because it asserts "measured, nothing survived", and a real survivor
 * introduced later would then read as pre-existing and be accepted silently.
 */
export function seedFileBaseline(args: SeedArgs): MutationManifest | null {
	const adapted = strykerToAdapted(args.report);
	if (adapted === null) return null;

	const forFile = adapted.find((f) => f.file === args.file) ?? adapted[0];
	if (forFile === undefined || forFile.mutants.length === 0) return null;

	const identities = deriveIdentities(
		args.file,
		args.content,
		forFile.mutants.map((m) => m.raw),
	);
	const overlayHashes = computeSymbolHashes(args.file, args.content);
	// Both are null when the TypeScript API is unavailable; without identities
	// there is no stable key to record a mutant under, so there is no baseline
	// worth writing.
	if (identities === null || overlayHashes === null) return null;

	const measured: MeasuredMutant[] = [];
	const n = Math.min(identities.length, forFile.mutants.length);
	for (let i = 0; i < n; i++) {
		const identity = identities[i];
		const m = forFile.mutants[i];
		if (identity && m) measured.push({ identity, status: m.status });
	}
	if (measured.length === 0) return null;

	// applyMeasuredRun already records every measured mutant WITH ITS STATUS —
	// survivors included. Reusing it means adoption and the clean-pass refresh
	// build byte-identical manifests, so a file adopted today is indistinguishable
	// from one that earned its baseline honestly. Only the caller differs.
	return applyMeasuredRun({
		base: args.base,
		file: args.file,
		overlayHashes,
		measured,
		at: args.at,
	});
}
