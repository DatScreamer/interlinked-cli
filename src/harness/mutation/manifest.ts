// ===========================================
// Per-edit mutation — manifest I/O + the survivor-diff invariant (build step 2)
// ===========================================
// The persistent state and the set-diff that turns "no new changed-region
// survivor" from prose into code (spec §4–§5). The manifest is a sibling of the
// coverage index: a generation-stamped snapshot of per-symbol hashes + per-mutant
// statuses. Pure functions apart from the JSON load/save.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isTestPath } from "../coverage-test-selector.js";
import { normalizeFindingPath } from "../findings/provenance.js";
import type { SymbolHashEntry } from "./identity.js";
import { freshInstability, mutantIdsChurned, updateInstability } from "./instability.js";
import { healManifestFiles } from "./manifest-heal.js";
import type {
	MeasurementProvenance,
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationManifest,
	MutationReceipt,
	StableId,
	SymbolRecord,
} from "./types.js";

export function mutationManifestPath(dir: string): string {
	return join(dir, "mutation-manifest.json");
}

/**
 * Normalize a raw `file` argument into the manifest's ONE canonical key: a
 * repo-relative, forward-slash path with no leading "./". This is the single
 * choke point every manifest reader/writer funnels a path through —
 * `applyMeasuredRun` and `fileRecords` below, plus accept.ts's `locate` /
 * `withMutant` — so an absolute path, a "./"-prefixed path, and a backslash
 * path all collapse onto the SAME key instead of each earning an independent
 * record.
 *
 * Measured defect (2026-07-31): Claude Code's hook event carries an ABSOLUTE
 * `file_path`, while the brownfield-adoption sweep (`seedFileBaseline`, driven
 * from a plain repo-relative path list) keys the SAME files by their
 * repo-relative path. 17 files ended up with two independent records, so the
 * survivor-diff invariant compared an edit against a record that was not its
 * own — half of every affected file's measurement history was invisible to
 * the ratchet.
 *
 * Reuses `normalizeFindingPath` (findings/provenance.ts) for the string-level
 * cleanup (backslash → "/", strip a leading "./") rather than re-deriving it —
 * `findings/corpus.ts`'s `toRepoRelative` composes the exact same
 * `isAbsolute(file) ? relative(cwd, file) : file` shape for the same reason.
 * `cwd` defaults to `process.cwd()` — the harness's documented convention that
 * every `.interlinked/` path resolves against the process cwd (the guarded
 * repo root) — but real callers on the live gate path (gate.ts /
 * pre-tool-coverage-gates.ts) thread the daemon's actual `ctx.cwd` explicitly,
 * since a daemon started with `--cwd` can diverge from `process.cwd()`.
 */
export function normalizeManifestKey(file: string, cwd: string = process.cwd()): string {
	const posix = normalizeFindingPath(file);
	// Both branches go through the SAME resolve -> relative round-trip. An earlier
	// version returned a relative input after string cleanup only, which left this
	// "canonical" key non-canonical for exactly the spellings a choke point exists
	// to collapse: measured 2026-07-31, one file produced FIVE distinct keys —
	// `src//a.ts`, `src/./a.ts`, `src/sub/../a.ts` and `../<repo>/src/a.ts` each
	// survived alongside `src/a.ts`. That is the same two-spellings/one-map class
	// this function was introduced to kill, reintroduced inside the fix itself.
	// `resolve` collapses `//`, `/./` and `/../`, so the round-trip is idempotent.
	const abs = isAbsolute(posix) ? posix : resolve(cwd, posix);
	return normalizeFindingPath(relative(cwd, abs));
}

/**
 * Thrown by `applyMeasuredRun` when the resolved key names a test/spec file.
 *
 * Mutating a test asks whether anything would notice a CHANGED TEST — the test
 * is the oracle, so the answer is always "no" and the measurement means
 * nothing (the same reasoning `gate.ts`'s `isMutationTarget` already applies
 * before a file is ever chosen as the primary edit target). This class existed
 * in the wild: 2 `.test.ts` keys were found in the live manifest on 2026-07-31,
 * written by `seedFileBaseline` (adopt.ts) — a caller with no test-file filter
 * of its own, upstream of `isMutationTarget`.
 *
 * Thrown, not silent: a test-file key reaching THIS point is a caller bug, not
 * a normal outcome, so it must be loud rather than quietly dropped (a silent
 * drop would hide exactly the caller defect that put it here). `evaluateMutation`
 * and `seedFileBaseline` both catch it and fold it into their EXISTING
 * "nothing to write" contracts (`unavailable` / `null`) — the daemon and the
 * CLI never see a raw throw, but a new caller that forgets to catch gets an
 * immediate, unambiguous failure instead of silent corruption.
 */
export class MutationManifestTestTargetError extends Error {
	constructor(public readonly key: string) {
		super(
			`mutation manifest: refusing to record a baseline for test file "${key}" — mutating a test proves nothing (the test is the oracle)`,
		);
		this.name = "MutationManifestTestTargetError";
	}
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

/** Parsed-manifest cache, keyed by (path, mtimeMs, size). The daemon calls
 *  `loadManifest` on EVERY code-edit PreToolUse; at 46MB a fresh JSON.parse
 *  costs ~300MB transient heap per call — measured live 2026-07-28 as the
 *  rss-ceiling kill loop (daemon-events.jsonl: heap 1–1.9GB, back-to-back
 *  recycles). The manifest only changes on a measured-clean persist, so an
 *  unchanged file serves the same parsed object. One entry per path — a
 *  daemon serves one repo, and a second path simply evicts the previous. */
let manifestCache: {
	path: string;
	mtimeMs: number;
	size: number;
	manifest: MutationManifest;
} | null = null;

/** Drop the resident parsed manifest — public API for the daemon's
 *  idle-shrink path: an idle daemon should not stay a ~1GB jetsam target for
 *  the sake of a cache the next event rebuilds in ~200ms. */
export function clearManifestCache(): void {
	manifestCache = null;
}

function cachedManifest(path: string, mtimeMs: number, size: number): MutationManifest | null {
	if (!manifestCache) return null;
	const hit =
		manifestCache.path === path && manifestCache.mtimeMs === mtimeMs && manifestCache.size === size;
	return hit ? manifestCache.manifest : null;
}

export function loadManifest(dir: string): MutationManifest | null {
	const path = mutationManifestPath(dir);
	if (!existsSync(path)) return null;
	try {
		const stat = statSync(path);
		const hit = cachedManifest(path, stat.mtimeMs, stat.size);
		if (hit) return hit;
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.files) return null;
		// SAFETY: version + files presence checked on the line above; deeper shape
		// errors surface as missing per-file records, which every consumer treats
		// as "no baseline" rather than crashing.
		const parsed = raw as MutationManifest; // SAFETY: see guard above
		// Repo root = the parent of the `.interlinked` dir this manifest lives in
		// (every caller passes `resolve(cwd, ".interlinked")` as `dir` — see
		// `normalizeManifestKey`'s docstring).
		const manifest: MutationManifest = { ...parsed, files: healManifestFiles(parsed.files, dirname(dir)) };
		manifestCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, manifest };
		return manifest;
	} catch {
		return null;
	}
}

/**
 * Stamp the conditions one file's records were measured under.
 *
 * Pure — returns a new manifest. Keyed through `normalizeManifestKey` like
 * every other manifest read/write, so an absolute path and a repo-relative one
 * stamp the SAME entry rather than two.
 */
export function stampProvenance(args: {
	manifest: MutationManifest;
	file: string;
	provenance: MeasurementProvenance;
	cwd?: string | undefined;
}): MutationManifest {
	const key = normalizeManifestKey(args.file, args.cwd ?? process.cwd());
	return {
		...args.manifest,
		fileProvenance: { ...(args.manifest.fileProvenance ?? {}), [key]: args.provenance },
	};
}

/** The conditions a file's records were measured under, or null when nothing
 *  recorded them — which is NOT the same as "measured under today's rules". */
export function provenanceOf(
	manifest: MutationManifest,
	file: string,
	cwd?: string,
): MeasurementProvenance | null {
	const key = normalizeManifestKey(file, cwd ?? process.cwd());
	return manifest.fileProvenance?.[key] ?? null;
}

export function saveManifest(dir: string, manifest: MutationManifest): void {
	const path = mutationManifestPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	// Compact on purpose: at manifest scale (46MB pretty / ~28MB compact for 730
	// files) the indent alone costs tens of MB of string churn on EVERY
	// measured-clean persist, and nobody reads this file by eye.
	writeFileSync(path, `${JSON.stringify(manifest)}\n`, "utf-8");
	// Prime the read cache with the object just written: without this every
	// persist invalidates the cache and the NEXT edit re-parses the whole file —
	// the cache would self-defeat under exactly the traffic it exists for.
	const stat = statSync(path);
	manifestCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, manifest };
}

/** Every read of a file's records funnels through `normalizeManifestKey` too —
 *  a caller that still hands in an absolute/`./`/backslash path reads the
 *  SAME record `applyMeasuredRun` would write, instead of silently missing it. */
function fileRecords(manifest: MutationManifest, file: string, cwd?: string): Record<StableId, SymbolRecord> {
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
export function hasFileBaseline(manifest: MutationManifest, file: string, cwd?: string): boolean {
	return Object.keys(fileRecords(manifest, file, cwd)).length > 0;
}

/** Symbols whose hash differs from the base manifest (or are new) — the changed region (spec §3). */
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

/** mutantIds accepted (grandfathered survivors + reviewed equivalents) in the base. */
export function acceptedSurvivors(base: MutationManifest, file: string, cwd?: string): Set<StableId> {
	const out = new Set<StableId>();
	for (const symbol of Object.values(fileRecords(base, file, cwd))) {
		for (const m of Object.values(symbol.mutants)) {
			if (m.status === "survived" || m.status === "equivalent") out.add(m.mutantId);
		}
	}
	return out;
}

/** symbolIds currently quarantined (identity unstable → survivors WARN, not BLOCK). */
export function quarantinedSymbols(base: MutationManifest, file: string, cwd?: string): Set<StableId> {
	const out = new Set<StableId>();
	for (const [symbolId, symbol] of Object.entries(fileRecords(base, file, cwd))) {
		if (symbol.instability.quarantined) out.add(symbolId);
	}
	return out;
}

function toRecord(identity: MutantIdentity, status: MutantStatus, firstSeen: string): MutantRecord {
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

// ============================================================
// Measured-run refresh + receipt persistence (spec §4/§12)
// ============================================================

/** Consecutive stable runs required before a quarantined symbol's identity is
 *  trusted (BLOCK-capable) again. Mirrors the coverage index's quarantine model. */
const QUARANTINE_STABILITY_THRESHOLD = 3;

interface RefreshSymbolArgs {
	prev: SymbolRecord | undefined;
	symbolId: StableId;
	entry: SymbolHashEntry;
	ms: MeasuredMutant[];
	at: string;
	threshold: number;
}

function refreshSymbol(args: RefreshSymbolArgs): SymbolRecord {
	const { prev, symbolId, entry, ms, at, threshold } = args;
	// Differential runs skip unchanged symbols: no fresh measurements + same hash
	// → carry the prior record forward verbatim (don't discard knowledge).
	if (ms.length === 0 && prev && prev.symbolHash === entry.symbolHash) return prev;
	const mutants: Record<StableId, MutantRecord> = {};
	for (const m of ms) {
		const firstSeen = prev?.mutants[m.identity.mutantId]?.firstSeen ?? at;
		mutants[m.identity.mutantId] = toRecord(m.identity, m.status, firstSeen);
	}
	// Identity churn only counts against an UNCHANGED hash — a changed symbol is
	// EXPECTED to mint new mutant ids (spec §6 of the identity spec).
	const churned =
		prev !== undefined &&
		prev.symbolHash === entry.symbolHash &&
		mutantIdsChurned(prev, new Set(Object.keys(mutants)));
	const instability = updateInstability(prev?.instability ?? freshInstability(), { churned, at, threshold });
	return { symbolId, qualifiedName: entry.qualifiedName, symbolHash: entry.symbolHash, mutants, instability };
}

export interface MeasuredRunArgs {
	base: MutationManifest;
	file: string;
	overlayHashes: Map<StableId, SymbolHashEntry>;
	measured: MeasuredMutant[];
	at: string;
	/** Stable runs to clear a quarantine; defaults to {@link QUARANTINE_STABILITY_THRESHOLD}. */
	stabilityThreshold?: number;
	/** Repo root `file` resolves against when absolute. Defaults to `process.cwd()`
	 *  inside {@link normalizeManifestKey} — pass the daemon's actual `ctx.cwd`
	 *  when it can diverge from the process cwd (e.g. an explicit `--cwd`). */
	cwd?: string;
}

/**
 * Fold a measured-clean run into the next manifest snapshot: fresh statuses +
 * hashes for every symbol in the overlay, `firstSeen` preserved across runs,
 * instability updated (churn under an unchanged hash → quarantine), symbols no
 * longer present dropped, generation bumped. Pure — the caller persists it, and
 * ONLY on a measured-clean allow (a dirty run must not launder the manifest).
 *
 * THE choke point (spec of this fix): `args.file` is normalized to the
 * canonical manifest key exactly once, here, via `normalizeManifestKey` — so
 * every real writer (the per-edit gate's `evaluateMutation` and the
 * brownfield-adoption `seedFileBaseline`) keys the SAME file identically
 * regardless of what shape of path it was handed. A resolved key that names a
 * test/spec file throws {@link MutationManifestTestTargetError} rather than
 * silently writing — see that class's docstring for why throw-and-catch (not
 * silent, not an uncaught crash) is the deliberate choice.
 */
export function applyMeasuredRun(args: MeasuredRunArgs): MutationManifest {
	const { base, overlayHashes, measured, at } = args;
	const file = normalizeManifestKey(args.file, args.cwd);
	if (isTestPath(file)) throw new MutationManifestTestTargetError(file);
	const threshold = args.stabilityThreshold ?? QUARANTINE_STABILITY_THRESHOLD;
	const prevFile = base.files[file] ?? {};
	const bySymbol = new Map<StableId, MeasuredMutant[]>();
	for (const m of measured) {
		const list = bySymbol.get(m.identity.symbolId) ?? [];
		list.push(m);
		bySymbol.set(m.identity.symbolId, list);
	}
	const nextFile: Record<StableId, SymbolRecord> = {};
	for (const [symbolId, entry] of overlayHashes) {
		nextFile[symbolId] = refreshSymbol({
			prev: prevFile[symbolId],
			symbolId,
			entry,
			ms: bySymbol.get(symbolId) ?? [],
			at,
			threshold,
		});
	}
	return { ...base, generation: base.generation + 1, authoritativeAt: at, files: { ...base.files, [file]: nextFile } };
}

export function mutationReceiptsPath(dir: string): string {
	return join(dir, "mutation-receipts.jsonl");
}

/** Append one receipt line (measured-clean passes only — spec §9/§12). */
export function appendReceipt(dir: string, receipt: MutationReceipt): void {
	const path = mutationReceiptsPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf-8");
}

/** fs persister for a measured-clean pass: manifest snapshot + receipt line. */
export function makeManifestPersister(
	dir: string,
): (manifest: MutationManifest, receipt: MutationReceipt) => void {
	return (manifest, receipt) => {
		saveManifest(dir, manifest);
		appendReceipt(dir, receipt);
	};
}
