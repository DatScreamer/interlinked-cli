// ===========================================
// Per-edit mutation — resolving a surviving mutant
// ===========================================
// Some survivors are EQUIVALENT: the mutation changes the code but not its
// behavior (a poll loop that only branches on "ready"/"gone" cannot observe
// {kind:"not_ready"} becoming {}), so no test can ever kill them. Under
// `mode: block` an unresolvable equivalent would brick its file forever — which
// makes this the last gate before enforcement, and the block message has
// promised it all along ("or annotating an equivalent mutant").
//
// What changed (plan 16 §7): the judgment is no longer prose. Prose is text, not
// evidence — it has no invalidation inputs, so an acceptance stayed valid long
// after the code it described had moved. There are now exactly TWO doors, and
// they are disjoint:
//
//   acceptMutant       — flips status to "equivalent". Admits ONLY
//                        `proved_equivalent`, and only when the method carries
//                        its own mechanism AND the certificate still binds to
//                        this exact mutant + symbol hash + environment. Nothing
//                        in the CLI can mint such a certificate, which is the
//                        point: the escape hatch is meant to be hard to reach.
//   recordDisposition  — attaches every OTHER judgment (dead_code, unresolved,
//                        …) WITHOUT touching status and WITHOUT writing
//                        accepted_reason. `dead_code` means the code should not
//                        exist; accepting it would seal a real defect in as
//                        "reviewed", so it cannot reach the equivalence door.

import {
	certificateHolds,
	describeDisposition,
	equivalenceRefusal,
	grantsEquivalence,
	methodProves,
	type SurvivorDisposition,
} from "./disposition.js";
import { normalizeManifestKey } from "./manifest.js";
import type { MutantRecord, MutationManifest, StableId, SymbolRecord } from "./types.js";

export interface AcceptArgs {
	base: MutationManifest;
	/** Repo-relative path whose baseline holds the mutant. */
	file: string;
	mutantId: string;
	/** The typed judgment. Only a certificate-bearing `proved_equivalent` is admitted. */
	disposition: SurvivorDisposition;
}

export interface RecordDispositionArgs {
	base: MutationManifest;
	file: string;
	mutantId: string;
	/** Any judgment that is NOT an accepted equivalence. */
	disposition: SurvivorDisposition;
}

interface LocatedMutant {
	symbolId: StableId;
	symbol: SymbolRecord;
	mutant: MutantRecord;
}

// `locate`/`withMutant` never MINT a new top-level file key (`withMutant`'s
// `fileRecord = base.files[key] ?? {}` fallback is unreachable in practice —
// `locate` already confirmed the key exists before either `acceptMutant` or
// `recordDisposition` ever calls `withMutant`), so there is no test-file or
// duplicate-key risk to introduce here. Both still normalize their lookup key
// so a caller passing an absolute/`./`/backslash `file` finds the SAME record
// `applyMeasuredRun` (manifest.ts) would have written it under, rather than a
// silent "not found".
function locate(base: MutationManifest, file: string, mutantId: string): LocatedMutant | null {
	const fileRecord = base.files[normalizeManifestKey(file)];
	if (!fileRecord) return null;
	for (const [symbolId, symbol] of Object.entries(fileRecord)) {
		const mutant = symbol.mutants[mutantId];
		if (mutant) return { symbolId, symbol, mutant };
	}
	return null;
}

/**
 * The record for a mutant, or null when the file or the id is unknown. Exported
 * so callers can tell "no such mutant" apart from "found, but not resolvable" —
 * two very different messages.
 */
export function findMutantRecord(
	base: MutationManifest,
	file: string,
	mutantId: string,
): MutantRecord | null {
	return locate(base, file, mutantId)?.mutant ?? null;
}

/** Is this disposition a proof that still holds against the manifest's state? */
function provesEquivalence(
	base: MutationManifest,
	located: LocatedMutant,
	disposition: SurvivorDisposition,
): boolean {
	if (!grantsEquivalence(disposition)) return false;
	if (!methodProves(disposition.method)) return false;
	return certificateHolds(disposition.certificate, {
		mutantId: located.mutant.mutantId,
		sourceSymbolHash: located.symbol.symbolHash,
		environmentHash: base.environmentHash,
		dependencyGraphVersion: base.dependencyGraphVersion,
	});
}

function withMutant(
	base: MutationManifest,
	file: string,
	located: LocatedMutant,
	updated: MutantRecord,
): MutationManifest {
	const key = normalizeManifestKey(file);
	const fileRecord = base.files[key] ?? {};
	const symbol = located.symbol;
	return {
		...base,
		files: {
			...base.files,
			[key]: {
				...fileRecord,
				[located.symbolId]: {
					...symbol,
					mutants: { ...symbol.mutants, [updated.mutantId]: updated },
				},
			},
		},
	};
}

/**
 * A copy of `base` with the named survivor recorded as a PROVED equivalent, or
 * null when there is nothing legitimate to accept: unknown file/mutant, a kind
 * that is not `proved_equivalent`, a method carrying no mechanism, or a
 * certificate that no longer binds to this mutant's current state.
 *
 * Null instead of throwing: the CLI turns it into a message, and a gate must
 * never crash on a bad accept. Use `refuseAcceptance` for the WHY.
 */
export function acceptMutant(args: AcceptArgs): MutationManifest | null {
	const located = locate(args.base, args.file, args.mutantId);
	if (!located) return null;
	if (!provesEquivalence(args.base, located, args.disposition)) return null;
	const updated: MutantRecord = {
		...located.mutant,
		status: "equivalent",
		// Back-compat: readers that predate typed dispositions still see a WHY.
		accepted_reason: describeDisposition(args.disposition),
		disposition: args.disposition,
	};
	return withMutant(args.base, args.file, located, updated);
}

/**
 * Why `acceptMutant` would refuse this disposition, or null if it would accept.
 * Separate from the manifest lookup so a caller can explain the refusal without
 * conflating it with "no such mutant".
 */
export function refuseAcceptance(disposition: SurvivorDisposition): string | null {
	const kindRefusal = equivalenceRefusal(disposition);
	if (kindRefusal) return kindRefusal;
	if (!grantsEquivalence(disposition)) return "not an equivalence claim";
	if (!methodProves(disposition.method)) {
		return `the declared ${disposition.method.kind} carries no mechanism — a bare claim is not a proof`;
	}
	return null;
}

/**
 * A copy of `base` with a NON-accepting judgment attached to the named mutant.
 *
 * This is the honest home for everything that is not a proved equivalence: the
 * `status` is left exactly as measured and `accepted_reason` is never written,
 * so a `dead_code` finding can never be read back as a reviewed acceptance.
 * Returns null for `proved_equivalent` — that kind has one door, `acceptMutant`,
 * and it checks a certificate.
 */
export function recordDisposition(args: RecordDispositionArgs): MutationManifest | null {
	if (grantsEquivalence(args.disposition)) return null;
	const located = locate(args.base, args.file, args.mutantId);
	if (!located) return null;
	const updated: MutantRecord = { ...located.mutant, disposition: args.disposition };
	return withMutant(args.base, args.file, located, updated);
}
