// ===========================================
// Per-edit mutation — accepting an equivalent mutant
// ===========================================
// Some survivors are EQUIVALENT: the mutation changes the code but not its
// behavior (a poll loop that only branches on "ready"/"gone" cannot observe
// {kind:"not_ready"} becoming {}), so no test can ever kill them. Under
// `mode: block` an unannotatable equivalent would brick its file forever —
// which makes this verb the last gate before enforcement, and the block
// message has promised it all along ("or annotating an equivalent mutant").
//
// The judgment is a HUMAN one, recorded auditable-in-band: the mutant's status
// flips to "equivalent" (already honored by `acceptedSurvivors`, so the gate
// needs no change) and the WHY travels with it in the manifest. An empty
// reason is refused — a floor entry nobody can audit is how ratchets rot.

import type { MutantRecord, MutationManifest } from "./types.js";

export interface AcceptArgs {
	base: MutationManifest;
	/** Repo-relative path whose baseline holds the mutant. */
	file: string;
	mutantId: string;
	/** Why this mutant is unkillable — stored on the record. */
	reason: string;
}

/**
 * A copy of `base` with the named survivor recorded as equivalent, or null
 * when there is nothing legitimate to accept (unknown file/mutant, blank
 * reason). Null instead of throwing: the CLI turns it into a message, and a
 * gate must never crash on a bad accept.
 */
export function acceptMutant(args: AcceptArgs): MutationManifest | null {
	if (args.reason.trim() === "") return null;
	const fileRecord = args.base.files[args.file];
	if (!fileRecord) return null;

	for (const [symbolId, symbol] of Object.entries(fileRecord)) {
		const mutant = symbol.mutants[args.mutantId];
		if (!mutant) continue;
		const updated: MutantRecord = {
			...mutant,
			status: "equivalent",
			accepted_reason: args.reason.trim(),
		};
		return {
			...args.base,
			files: {
				...args.base.files,
				[args.file]: {
					...fileRecord,
					[symbolId]: { ...symbol, mutants: { ...symbol.mutants, [args.mutantId]: updated } },
				},
			},
		};
	}
	return null;
}
