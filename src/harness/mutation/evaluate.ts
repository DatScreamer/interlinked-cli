// ===========================================
// Per-edit mutation — local evaluation orchestrator (build step 4)
// ===========================================
// Ties the pure pipeline together: overlay content → symbol hashes + identities →
// changed-region + survivor-diff → MutationGateOutcome (+ hash-bound receipt). The
// engine execution that produces `adapted` is INJECTED, so this is the local
// 1-node core the cloud Sandbox runner calls. No I/O, no clock (the `at` stamp is
// passed in) — fully deterministic.

import { createHash } from "node:crypto";
import { computeSymbolHashes, deriveIdentities } from "./identity.js";
import {
	acceptedSurvivors,
	applyMeasuredRun,
	changedSymbols,
	computeNewSurvivors,
	type MeasuredMutant,
	quarantinedSymbols,
} from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type {
	MutantIdentity,
	MutationGateOutcome,
	MutationManifest,
	MutationReceipt,
	StableId,
	TestRunResult,
} from "./types.js";

export interface MutationEvalInput {
	file: string;
	baseManifest: MutationManifest;
	/** The proposed (post-overlay) content of the edited file. */
	overlayContent: string;
	/** Per-mutant engine results (status + raw span) — produced by the runner. */
	adapted: AdaptedMutant[];
	/** Small-scope ceiling (spec §6): over this many changed-region sites ⇒ block
	 *  "split this patch" rather than gate a huge edit. */
	siteCountThreshold: number;
	/** Optional overlay test-run signal (spec §7): red suite ⇒ block, weak RED-
	 *  witness ⇒ warn. Absent ⇒ neither gate fires (mutants-only runner). */
	testRun?: TestRunResult | undefined;
	/** Injected timestamp (no clock dependency). */
	at: string;
}

function unavailable(reason: string): MutationGateOutcome {
	return { kind: "unavailable", reason, warning: `[mutation:not-measured] ${reason}` };
}

function zip(identities: MutantIdentity[], adapted: AdaptedMutant[]): MeasuredMutant[] {
	const out: MeasuredMutant[] = [];
	const n = Math.min(identities.length, adapted.length);
	for (let i = 0; i < n; i++) {
		const identity = identities[i];
		const a = adapted[i];
		if (identity && a) out.push({ identity, status: a.status });
	}
	return out;
}

function uncoveredInChanged(measured: MeasuredMutant[], changed: Set<StableId>): StableId[] {
	const sites = new Set<StableId>();
	for (const m of measured) {
		if (m.status === "uncovered" && changed.has(m.identity.symbolId)) sites.add(m.identity.siteId);
	}
	return [...sites];
}

/** Distinct mutation sites in the changed region (spec §6 precheck). Counts every
 *  derived site whose symbol changed — not just the measured/covered ones — so an
 *  edit with many sites is rejected as "too big" before its survivors matter. */
function distinctChangedSites(identities: MutantIdentity[], changed: Set<StableId>): number {
	const sites = new Set<StableId>();
	for (const id of identities) {
		if (changed.has(id.symbolId)) sites.add(id.siteId);
	}
	return sites.size;
}

function buildReceipt(input: MutationEvalInput, measured: MeasuredMutant[]): MutationReceipt {
	return {
		overlayHash: createHash("sha256").update(input.overlayContent).digest("hex"),
		generation: input.baseManifest.generation,
		sites: measured.map((m) => ({ mutantId: m.identity.mutantId, symbolId: m.identity.symbolId, status: m.status })),
		engine: input.baseManifest.engine,
		engineVersion: input.baseManifest.engineVersion,
		measuredAt: input.at,
	};
}

/** Evaluate a measured per-edit mutation run into a gate outcome (spec §5). */
export function evaluateMutation(input: MutationEvalInput): MutationGateOutcome {
	const overlayHashes = computeSymbolHashes(input.file, input.overlayContent);
	const identities = deriveIdentities(
		input.file,
		input.overlayContent,
		input.adapted.map((a) => a.raw),
	);
	if (overlayHashes === null || identities === null) return unavailable("typescript unavailable");

	const measured = zip(identities, input.adapted);
	const changed = changedSymbols(input.baseManifest, input.file, overlayHashes);
	const newSurvivors = computeNewSurvivors(
		measured,
		{
			changed,
			accepted: acceptedSurvivors(input.baseManifest, input.file),
			quarantined: quarantinedSymbols(input.baseManifest, input.file),
		},
		input.at,
	);
	const uncoveredSites = uncoveredInChanged(measured, changed);
	const changedSiteCount = distinctChangedSites(identities, changed);
	const oversize = changedSiteCount > input.siteCountThreshold;
	// Spec §7: a red overlay suite is a hard block; a new test that doesn't fail on
	// base (RED-witness) is a warning, never a block.
	const suiteRed = input.testRun?.overlayGreen === false;
	const redWitnessFailed = input.testRun?.redWitnessSatisfied === false;
	const decision =
		suiteRed || oversize || newSurvivors.length > 0 || uncoveredSites.length > 0 ? "block" : "allow";
	// Manifest refresh is earned ONLY by a measured-clean pass — a dirty run must
	// not launder the manifest, and an unavailable run never reaches here (§4/§12).
	const refreshedManifest =
		decision === "allow"
			? applyMeasuredRun({
					base: input.baseManifest,
					file: input.file,
					overlayHashes,
					measured,
					at: input.at,
				})
			: undefined;
	return {
		kind: "measured",
		decision,
		receipt: buildReceipt(input, measured),
		newSurvivors,
		uncoveredSites,
		changedSiteCount,
		siteCountThreshold: input.siteCountThreshold,
		suiteRed,
		redWitnessFailed,
		refreshedManifest,
	};
}
