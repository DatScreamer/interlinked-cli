// ===========================================
// Per-edit mutation — manifest I/O + the survivor-diff invariant (build step 2)
// ===========================================
// The persistent state and the set-diff that turns "no new changed-region
// survivor" from prose into code (spec §4–§5). The manifest is a sibling of the
// coverage index: a generation-stamped snapshot of per-symbol hashes + per-mutant
// statuses. Pure functions apart from the JSON load/save.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SymbolHashEntry } from "./identity.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationManifest,
	StableId,
	SymbolRecord,
} from "./types.js";

export function mutationManifestPath(dir: string): string {
	return join(dir, "mutation-manifest.json");
}

export interface ManifestMeta {
	engine: string;
	engineVersion: string;
	dependencyGraphVersion: string;
	environmentHash: string;
	authoritativeAt: string;
}

export function emptyManifest(meta: ManifestMeta): MutationManifest {
	return {
		version: 1,
		generation: 0,
		authoritativeAt: meta.authoritativeAt,
		engine: meta.engine,
		engineVersion: meta.engineVersion,
		dependencyGraphVersion: meta.dependencyGraphVersion,
		environmentHash: meta.environmentHash,
		files: {},
	};
}

export function loadManifest(dir: string): MutationManifest | null {
	const path = mutationManifestPath(dir);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.files) return null;
		return raw as MutationManifest;
	} catch {
		return null;
	}
}

export function saveManifest(dir: string, manifest: MutationManifest): void {
	const path = mutationManifestPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function fileRecords(manifest: MutationManifest, file: string): Record<StableId, SymbolRecord> {
	return manifest.files[file] ?? {};
}

/** Symbols whose hash differs from the base manifest (or are new) — the changed region (spec §3). */
export function changedSymbols(
	base: MutationManifest,
	file: string,
	overlayHashes: Map<StableId, SymbolHashEntry>,
): Set<StableId> {
	const records = fileRecords(base, file);
	const changed = new Set<StableId>();
	for (const [symbolId, entry] of overlayHashes) {
		const prior = records[symbolId];
		if (!prior || prior.symbolHash !== entry.symbolHash) changed.add(symbolId);
	}
	return changed;
}

/** mutantIds accepted (grandfathered survivors + reviewed equivalents) in the base. */
export function acceptedSurvivors(base: MutationManifest, file: string): Set<StableId> {
	const out = new Set<StableId>();
	for (const symbol of Object.values(fileRecords(base, file))) {
		for (const m of Object.values(symbol.mutants)) {
			if (m.status === "survived" || m.status === "equivalent") out.add(m.mutantId);
		}
	}
	return out;
}

/** symbolIds currently quarantined (identity unstable → survivors WARN, not BLOCK). */
export function quarantinedSymbols(base: MutationManifest, file: string): Set<StableId> {
	const out = new Set<StableId>();
	for (const [symbolId, symbol] of Object.entries(fileRecords(base, file))) {
		if (symbol.instability.quarantined) out.add(symbolId);
	}
	return out;
}

export function toRecord(identity: MutantIdentity, status: MutantStatus, firstSeen: string): MutantRecord {
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
		if (isNewSurvivor) out.push(toRecord(id, m.status, firstSeen));
	}
	return out;
}
