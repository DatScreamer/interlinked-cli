// interlinked-tdd: exempt
// ===========================================
// Istanbul → canonical element sets
// ===========================================
// Pure canonicalization helpers split out of vitest.ts to keep both modules
// under the per-file line cap. This is a leaf cluster: it depends only on its
// own logic, node builtins, and the coverage-index element-set type — nothing
// in vitest.ts imports back into here, so there is no cycle.

import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { CanonicalCoverageElementSet } from "../coverage-index/types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwrap a FileCoverage envelope ({data: …}) to its plain data, or null. */
function unwrapFileCoverage(raw: unknown): Record<string, unknown> | null {
	if (!isRecord(raw)) return null;
	const candidate = !isRecord(raw.statementMap) && isRecord(raw.data) ? raw.data : raw;
	if (!isRecord(candidate)) return null;
	if (!isRecord(candidate.statementMap) || !isRecord(candidate.s)) return null;
	return candidate;
}

/** A `{start: {line, column}}` location's line, or null. */
function locLine(raw: unknown): number | null {
	if (!isRecord(raw)) return null;
	const start = raw.start;
	if (!isRecord(start) || typeof start.line !== "number") return null;
	return start.line;
}

function locColumn(raw: unknown): number {
	if (isRecord(raw) && isRecord(raw.start) && typeof raw.start.column === "number") {
		return raw.start.column;
	}
	return 0;
}

/** A path with symlinks resolved when it exists; the input untouched otherwise. */
export function canonicalPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Repo-relative POSIX path for an istanbul file key, or null when outside.
 * Both sides are symlink-canonicalized before comparing: on macOS `tmpdir()`
 * roots live under `/var/folders/…` while vitest realpaths everything to
 * `/private/var/…`, and an un-canonicalized comparison silently drops every
 * file as "outside the root".
 */
function relFor(rawPath: string, projectRoot: string): string | null {
	const norm = rawPath.replace(/\\/g, "/");
	if (!isAbsolute(norm)) return norm || null;
	const rel = relative(canonicalPath(projectRoot), canonicalPath(norm)).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..")) return null;
	return rel;
}

/**
 * Lines + statement elements from istanbul statement data. Per-line value is
 * the MAX of the hits of statements starting on that line — istanbul's own
 * getLineCoverage semantics, so the index and istanbul reports can never
 * disagree about what a "covered line" means.
 */
function lineAndStatementElements(
	statementMap: Record<string, unknown>,
	s: Record<string, unknown>,
): { lines: Map<number, number>; statements: Map<string, number> } {
	const lines = new Map<number, number>();
	const statements = new Map<string, number>();
	for (const [id, loc] of Object.entries(statementMap)) {
		const line = locLine(loc);
		const hits = s[id];
		if (line === null || typeof hits !== "number") continue;
		lines.set(line, Math.max(lines.get(line) ?? 0, hits));
		statements.set(`${line}:${locColumn(loc)}`, hits);
	}
	return { lines, statements };
}

/** Branch elements keyed `line:branchId:pathIndex` from istanbul branch data. */
function branchElements(fc: Record<string, unknown>): Map<string, number> {
	const branches = new Map<string, number>();
	const branchMap = fc.branchMap;
	const b = fc.b;
	if (!isRecord(branchMap) || !isRecord(b)) return branches;
	for (const [id, branch] of Object.entries(branchMap)) {
		if (!isRecord(branch)) continue;
		const hitsArr = b[id];
		if (!Array.isArray(hitsArr)) continue;
		const locations = Array.isArray(branch.locations) ? branch.locations : [];
		const fallbackLine = typeof branch.line === "number" ? branch.line : (locLine(branch.loc) ?? 0);
		for (let i = 0; i < hitsArr.length; i++) {
			const hits = hitsArr[i];
			if (typeof hits !== "number") continue;
			branches.set(`${locLine(locations[i]) ?? fallbackLine}:${id}:${i}`, hits);
		}
	}
	return branches;
}

/** Function elements keyed `name@declLine` from istanbul function data. */
function functionElements(fc: Record<string, unknown>): Map<string, number> {
	const functions = new Map<string, number>();
	const fnMap = fc.fnMap;
	const f = fc.f;
	if (!isRecord(fnMap) || !isRecord(f)) return functions;
	for (const [id, fn] of Object.entries(fnMap)) {
		if (!isRecord(fn)) continue;
		const hits = f[id];
		if (typeof hits !== "number") continue;
		const name = typeof fn.name === "string" && fn.name ? fn.name : `(anonymous_${id})`;
		functions.set(`${name}@${locLine(fn.decl) ?? locLine(fn.loc) ?? 0}`, hits);
	}
	return functions;
}

/** One istanbul file entry → a canonical element set, or null when malformed. */
function elementSetFromIstanbul(fc: Record<string, unknown>): CanonicalCoverageElementSet | null {
	const statementMap = fc.statementMap;
	const s = fc.s;
	if (!isRecord(statementMap) || !isRecord(s)) return null;
	const { lines, statements } = lineAndStatementElements(statementMap, s);
	const set: CanonicalCoverageElementSet = {
		lines,
		branches: branchElements(fc),
		functions: functionElements(fc),
	};
	if (statements.size > 0) set.statements = statements;
	return set;
}

/**
 * Canonicalize an istanbul coverage-data object (one capture record's
 * `istanbul` field, or a parsed `coverage-final.json`) into per-file element
 * sets keyed by repo-relative POSIX path. Malformed entries and files outside
 * the project root are skipped — partial data never throws.
 */
export function istanbulToElementSets(
	data: unknown,
	projectRoot: string,
): Map<string, CanonicalCoverageElementSet> {
	const out = new Map<string, CanonicalCoverageElementSet>();
	if (!isRecord(data)) return out;
	for (const [key, rawEntry] of Object.entries(data)) {
		const fc = unwrapFileCoverage(rawEntry);
		if (!fc) continue;
		const rel = relFor(typeof fc.path === "string" ? fc.path : key, projectRoot);
		if (!rel) continue;
		const set = elementSetFromIstanbul(fc);
		if (set) out.set(rel, set);
	}
	return out;
}
