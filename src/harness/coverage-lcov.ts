// ===========================================
// LCOV → Canonical Coverage
// ===========================================
// Parses the LCOV `lcov.info` interchange format — the cross-language de-facto
// standard. istanbul (lcov reporter), coverage.py (`coverage lcov`),
// cargo-llvm-cov (`--lcov`), gcov/lcov, and gocover→lcov all emit it, so one
// parser here replaces N bespoke per-engine readers. Pure + dependency-free;
// LCOV is a simple line-oriented record format.
//
// Record grammar (one source file per `end_of_record`):
//   TN:<test name>
//   SF:<source file path>
//   FN:<line>,<function name>
//   FNDA:<hits>,<function name>
//   FNF:<found>   FNH:<hit>
//   BRDA:<line>,<block>,<branch>,<taken|->
//   BRF:<found>   BRH:<hit>
//   DA:<line>,<hits>[,<checksum>]
//   LF:<found>    LH:<hit>
//   end_of_record
//
// We derive every metric from the detailed records (DA / BRDA / FN+FNDA) rather
// than trusting the summary lines (LF/LH/BRF/BRH/FNF/FNH), so a malformed or
// inconsistent summary line can't skew the result. Duplicate file records
// (merged reports) accumulate — line/branch hit counts sum — matching LCOV
// merge semantics.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
	type CanonicalCoverage,
	type CanonicalFileCoverage,
	type CanonicalFunction,
	metric,
} from "./coverage-canonical.js";
import type { CoverageSummary } from "./coverage-ratchet.js";
import type { FunctionCoverage, PerFileCoverage } from "./coverage-final-reader.js";

export interface ParseLcovOptions {
	/** Absolute repo root; absolute `SF` paths are normalized relative to it. */
	cwd?: string;
}

/** Per-file accumulator — merged across duplicate `SF` records before finalizing. */
interface FileAcc {
	/** 1-based line → summed hit count. */
	lineHits: Map<number, number>;
	/** function name → start line (from `FN`). */
	fnLine: Map<string, number>;
	/** function name → summed hit count (from `FNDA`). */
	fnHits: Map<string, number>;
	/** branch key `line:block:branch` → summed taken count (`-` ⇒ 0). */
	branchTaken: Map<string, number>;
}

function emptyAcc(): FileAcc {
	return {
		lineHits: new Map(),
		fnLine: new Map(),
		fnHits: new Map(),
		branchTaken: new Map(),
	};
}

/** Normalize an `SF` path to a repo-relative, POSIX-separated string. */
function normalizeSourcePath(sf: string, cwd: string | undefined): string {
	const posix = sf.trim().replace(/\\/g, "/");
	if (cwd && isAbsolute(posix)) {
		return relative(cwd, posix).replace(/\\/g, "/");
	}
	return posix;
}

/** Split on the FIRST comma only — function names may contain commas. */
function splitFirstComma(s: string): [string, string] {
	const i = s.indexOf(",");
	if (i === -1) return [s, ""];
	return [s.slice(0, i), s.slice(i + 1)];
}

/**
 * Parse an LCOV string into canonical coverage. Pure — never throws on
 * arbitrary input (malformed lines are skipped).
 */
export function parseLcov(content: string, opts: ParseLcovOptions = {}): CanonicalCoverage {
	const cwd = opts.cwd;
	const accs = new Map<string, FileAcc>();
	let cur: FileAcc | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line === "end_of_record") {
			cur = null;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const tag = line.slice(0, colon);
		const rest = line.slice(colon + 1);

		switch (tag) {
			case "SF": {
				const path = normalizeSourcePath(rest, cwd);
				if (!path) break;
				let acc = accs.get(path);
				if (!acc) {
					acc = emptyAcc();
					accs.set(path, acc);
				}
				cur = acc;
				break;
			}
			case "DA": {
				if (!cur) break;
				const parts = rest.split(",");
				const ln = Number.parseInt(parts[0] ?? "", 10);
				const hits = Number.parseInt(parts[1] ?? "", 10);
				if (!Number.isFinite(ln) || !Number.isFinite(hits)) break;
				cur.lineHits.set(ln, (cur.lineHits.get(ln) ?? 0) + hits);
				break;
			}
			case "FN": {
				if (!cur) break;
				const [lnStr, name] = splitFirstComma(rest);
				const ln = Number.parseInt(lnStr, 10);
				if (!name || !Number.isFinite(ln)) break;
				cur.fnLine.set(name, ln);
				break;
			}
			case "FNDA": {
				if (!cur) break;
				const [hitsStr, name] = splitFirstComma(rest);
				const hits = Number.parseInt(hitsStr, 10);
				if (!name || !Number.isFinite(hits)) break;
				cur.fnHits.set(name, (cur.fnHits.get(name) ?? 0) + hits);
				break;
			}
			case "BRDA": {
				if (!cur) break;
				const parts = rest.split(",");
				if (parts.length < 4) break;
				const key = `${parts[0]}:${parts[1]}:${parts[2]}`;
				const takenRaw = parts[3] ?? "-";
				const taken = takenRaw === "-" ? 0 : Number.parseInt(takenRaw, 10);
				if (!Number.isFinite(taken)) break;
				cur.branchTaken.set(key, (cur.branchTaken.get(key) ?? 0) + taken);
				break;
			}
			// LF/LH/BRF/BRH/FNF/FNH/TN intentionally ignored — derived from detail.
			default:
				break;
		}
	}

	const files = new Map<string, CanonicalFileCoverage>();
	for (const [path, acc] of accs) {
		files.set(path, finalizeFile(path, acc));
	}
	return { files, source: "lcov" };
}

function finalizeFile(path: string, acc: FileAcc): CanonicalFileCoverage {
	let linesCovered = 0;
	for (const hits of acc.lineHits.values()) if (hits > 0) linesCovered++;

	let branchesCovered = 0;
	for (const taken of acc.branchTaken.values()) if (taken > 0) branchesCovered++;

	const perFunction: CanonicalFunction[] = [];
	let functionsCovered = 0;
	for (const [name, ln] of acc.fnLine) {
		const hits = acc.fnHits.get(name) ?? 0;
		if (hits > 0) functionsCovered++;
		perFunction.push({ name, line: ln, hits });
	}

	return {
		path,
		lines: metric(linesCovered, acc.lineHits.size),
		branches: metric(branchesCovered, acc.branchTaken.size),
		functions: metric(functionsCovered, acc.fnLine.size),
		perFunction,
		lineHits: acc.lineHits,
	};
}

/** Read + parse an `lcov.info` file. Returns null when absent/unreadable. */
export function loadLcovFile(path: string, opts: ParseLcovOptions = {}): CanonicalCoverage | null {
	if (!existsSync(path)) return null;
	try {
		return parseLcov(readFileSync(path, "utf-8"), opts);
	} catch {
		return null;
	}
}

/**
 * Bridge canonical coverage into the ratchet's `CoverageSummary` shape, so the
 * existing per-file coverage ratchet (and CRAP) consume LCOV-derived data
 * unchanged. This is the seam that makes the ratchet language-agnostic: any
 * engine → LCOV → canonical → this → ratchet.
 */
export function canonicalToCoverageSummary(cov: CanonicalCoverage): CoverageSummary {
	const out: CoverageSummary = {};
	for (const [path, f] of cov.files) {
		out[path] = {
			lines: { pct: f.lines.pct, covered: f.lines.covered, total: f.lines.total },
			branches: { pct: f.branches.pct, covered: f.branches.covered, total: f.branches.total },
			functions: { pct: f.functions.pct, covered: f.functions.covered, total: f.functions.total },
		};
	}
	return out;
}

/**
 * Bridge one LCOV file record into the per-function `PerFileCoverage` shape CRAP
 * scoring consumes — the cross-language equivalent of the istanbul
 * `coverage-final.json` reader. LCOV records per-LINE hits (`DA`) and per-
 * function entry hits (`FNDA`) but NOT per-function statement coverage, so each
 * function's coverage is derived by intersecting the line-hit map with the
 * function's source range (supplied from the AST complexity pass): covered =
 * lines in `[line, endLine]` with hits > 0, over the lines in that range LCOV
 * recorded at all. This mirrors istanbul's `computeStatementPct` at line
 * granularity, letting any LCOV-emitting engine (coverage.py, cargo-llvm-cov,
 * gcov, vitest's lcov reporter) feed `interlinked metrics` CRAP — not just the
 * istanbul JSON reporter.
 */
export function perFileCoverageFromCanonical(
	canonicalFile: CanonicalFileCoverage,
	rel: string,
	mtime: number,
	fnRanges: ReadonlyArray<{ name: string; line: number; endLine: number }>,
): PerFileCoverage {
	const lineHits = canonicalFile.lineHits;
	const fnEntryHits = new Map<number, number>();
	for (const fn of canonicalFile.perFunction) fnEntryHits.set(fn.line, fn.hits);

	const functions: FunctionCoverage[] = fnRanges.map((fn) => {
		let total = 0;
		let covered = 0;
		for (let ln = fn.line; ln <= fn.endLine; ln++) {
			const hits = lineHits.get(ln);
			if (hits === undefined) continue;
			total++;
			if (hits > 0) covered++;
		}
		return {
			name: fn.name,
			line: fn.line,
			endLine: fn.endLine,
			hits: fnEntryHits.get(fn.line) ?? (covered > 0 ? 1 : 0),
			statement_pct: total > 0 ? (covered / total) * 100 : 0,
		};
	});
	return { filePath: rel, mtime, functions };
}
