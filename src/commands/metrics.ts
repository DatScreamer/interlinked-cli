// ===========================================
// interlinked metrics — whole-codebase test-quality scan
// ===========================================
// One command that scans every analyzable source file and reports the
// test-quality posture across the stack: companion-test presence, coverage,
// cyclomatic complexity (AST-accurate), and CRAP — per function and per file,
// with the agreed gate verdicts. Read-only; composes the existing pieces
// (file discovery, the AST complexity pass, the per-function coverage reader,
// the CRAP scorer, the companion-path helper) rather than recomputing anything.
//
// Coverage is OPTIONAL and language-agnostic: it loads istanbul
// `coverage-final.json` AND the canonical LCOV spine (`coverage/lcov.info`)
// the per-language adapters emit (coverage.py, cargo-llvm-cov, vitest's lcov
// reporter, …), MERGING them when both exist — per-file lookups prefer the
// fresher report and fall back to the other (a polyglot repo emits each for a
// different language). When neither exists the scan still reports complexity +
// companion presence and marks coverage/CRAP as unavailable (fail-open, never
// throws).

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { computeCrapForFile } from "../harness/checks/crap.js";
import { computeCyclomaticComplexity, type FunctionComplexityEntry } from "../harness/checks/cyclomatic.js";
import { astComplexityAvailable, computeCyclomaticAst } from "../harness/checks/cyclomatic-ast.js";
import { lcovReportPaths } from "../harness/coverage-adapters.js";
import {
	coverageForFile,
	loadCoverageFinal,
	type PerFileCoverage,
} from "../harness/coverage-final-reader.js";
import {
	canonicalToCoverageSummary,
	loadLcovFile,
	perFileCoverageFromCanonical,
} from "../harness/coverage-lcov.js";
import { type CoverageSummary, loadCoverageSummary } from "../harness/coverage-ratchet.js";
import {
	companionTestCandidates,
	isTddExemptPath,
} from "../harness/evaluator/tdd-new-file-gate.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";
import { discoverFiles } from "./verify/file-discovery.js";

// Agreed thresholds (see the test-quality session): cyclomatic > 25 is the hard
// "bad" line, > 15 the design-smell "review" line; CRAP >= 30 is the canonical
// Crap4J gate. These are the verdicts the scan reports against.
const CYCLOMATIC_REVIEW = 15;
const CYCLOMATIC_BAD = 25;
const CRAP_GATE = 30;

/** Source extensions the AST/regex complexity pass + coverage adapters cover. */
const ANALYZABLE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)$/;
const TEST_EXT_RE = /\.(test|spec)\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)$/;

interface FnMetric {
	file: string;
	name: string;
	line: number;
	cyclomatic: number;
	/** null when no coverage data is available for the file. */
	coveragePct: number | null;
	/** null when no coverage data is available (CRAP needs coverage). */
	crap: number | null;
}

interface FileMetric {
	file: string;
	functions: number;
	/** Per-file line coverage %, or null when no coverage report is present. */
	linePct: number | null;
	maxCyclomatic: number;
	/** null when no coverage data. */
	maxCrap: number | null;
	/** true/false when a companion is expected, null when the file is exempt. */
	companion: boolean | null;
	/** functions in this file at/over the CRAP gate. */
	overGate: number;
}

interface MetricsOptions {
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
	/** Cap the hotspot table (default 25). */
	top?: string;
}

/**
 * Analyzable when the extension is a supported source language, it is not a
 * test / declaration / fixture file, AND it is in scope: either under `src/`
 * (the JS coverage-include convention) or present in the loaded coverage report
 * (so a non-TS language whose sources live outside `src/` — e.g. a Python
 * package — still appears once its LCOV report is generated).
 */
function isAnalyzableSource(rel: string, covered: ReadonlySet<string>): boolean {
	if (!ANALYZABLE_EXT_RE.test(rel)) return false;
	if (/\.d\.ts$/.test(rel)) return false;
	if (TEST_EXT_RE.test(rel)) return false;
	if (/(^|\/)(__tests__|__fixtures__|tests|test)\//.test(rel)) return false;
	return rel.startsWith("src/") || covered.has(rel);
}

/**
 * Per-file line coverage % from a summary whose keys are REPO-RELATIVE (run it
 * through {@link normalizeSummaryKeys} at load). Exact-match only: the old
 * suffix match (`key.endsWith("/" + rel)`) mis-attributed coverage whenever two
 * files shared a path tail — in a monorepo with `src/foo.ts` and
 * `packages/a/src/foo.ts`, the latter's absolute key also ends with
 * `/src/foo.ts`, so iteration order decided which file's number the root file
 * got (finding 2026-06).
 *
 * Exported so the every-file-tested gate (`tested-file-policy.ts` via
 * `loadMetricsCoverage`) reuses the SAME lookup the metrics command uses — one
 * definition of "what is this file's line coverage".
 */
export function linePctFor(summary: CoverageSummary | null, rel: string): number | null {
	const entry = summary?.[rel];
	if (!entry) return null;
	return typeof entry.lines?.pct === "number" ? entry.lines.pct : null;
}

/**
 * Re-key a coverage summary onto REPO-RELATIVE POSIX paths, unambiguously: an
 * absolute key becomes `relative(cwd, key)`; a key outside the repo is DROPPED
 * (it cannot correspond to a repo-relative lookup — the old suffix match let it
 * shadow a repo file with the same tail, finding 2026-06). Same convention as
 * the istanbul final reader (`coverage-final-reader.ts::buildPerFileCoverage`).
 * Already-relative keys (LCOV-derived summaries) pass through normalized.
 */
function normalizeSummaryKeys(summary: CoverageSummary | null, cwd: string): CoverageSummary | null {
	if (!summary) return null;
	const out: CoverageSummary = {};
	for (const [key, entry] of Object.entries(summary)) {
		if (!entry) continue;
		if (key === "total") {
			out[key] = entry;
			continue;
		}
		const rel = isAbsolute(key) ? relative(cwd, key) : key;
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		out[rel.replace(/\\/g, "/")] = entry;
	}
	return out;
}

type FnRange = { name: string; line: number; endLine: number };

/**
 * Unified, language-agnostic coverage accessor. MERGES istanbul
 * `coverage-final.json` (per-statement, JS/TS) with the canonical LCOV spine
 * (per-function derived from line hits + the supplied AST ranges) when BOTH
 * exist — a polyglot repo emits each for a different language, and neither may
 * shadow the other. `available === false` when neither report exists.
 */
export interface MetricsCoverage {
	available: boolean;
	source: "istanbul" | "lcov" | "istanbul+lcov" | null;
	/** Files the report(s) know about, repo-relative — drives non-`src/` inclusion. */
	fileSet: ReadonlySet<string>;
	perFile(rel: string, fnRanges: FnRange[], mtime: number): PerFileCoverage | undefined;
	linePct(rel: string): number | null;
}

/** One loaded report format, with PER-AXIS report mtimes for freshness ordering:
 *  istanbul's per-file data lives in `coverage-final.json` while its line
 *  percentages live in `coverage-summary.json` — two files that can age apart,
 *  so each axis carries the mtime of the file that actually backs it (finding
 *  2026-06: ordering linePct by final.json's mtime let a STALE summary shadow a
 *  fresher LCOV percentage). */
interface CoverageSource {
	kind: "istanbul" | "lcov";
	perFileMtimeMs: number;
	linePctMtimeMs: number;
	fileSet: ReadonlySet<string>;
	perFile: MetricsCoverage["perFile"];
	linePct: MetricsCoverage["linePct"];
}

/** The report file's mtime, or 0 when unreadable (sorts oldest — least trusted). */
function reportMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** The istanbul `coverage-final.json` report as a CoverageSource, or null. */
function istanbulSource(cwd: string): CoverageSource | null {
	const path = join(cwd, "coverage", "coverage-final.json");
	const finalCov = loadCoverageFinal(path, cwd);
	if (!finalCov) return null;
	const summaryPath = join(cwd, "coverage", "coverage-summary.json");
	// Re-keyed repo-relative so lookups are exact, never suffix-ambiguous
	// (finding 2026-06: monorepo path tails collided).
	const summary = normalizeSummaryKeys(loadCoverageSummary(summaryPath), cwd);
	return {
		kind: "istanbul",
		perFileMtimeMs: reportMtimeMs(path),
		// The linePct axis is backed by the SUMMARY file — its own age decides
		// freshness, not final.json's (finding 2026-06).
		linePctMtimeMs: reportMtimeMs(summaryPath),
		fileSet: new Set(finalCov.keys()),
		perFile: (rel) => coverageForFile(finalCov, rel),
		linePct: (rel) => linePctFor(summary, rel),
	};
}

/**
 * Every existing LCOV report as its own CoverageSource — the canonical
 * aggregate path plus each adapter's PER-LANGUAGE report (finding 2026-06: the
 * adapters once shared one output path and clobbered each other; now each
 * report loads separately and the merge arbitrates per file by freshness).
 */
function lcovSources(cwd: string): CoverageSource[] {
	const sources: CoverageSource[] = [];
	for (const relPath of lcovReportPaths()) {
		const path = join(cwd, relPath);
		const lcov = loadLcovFile(path, { cwd });
		if (!lcov) continue;
		const summary = canonicalToCoverageSummary(lcov);
		const mtime = reportMtimeMs(path);
		sources.push({
			kind: "lcov",
			perFileMtimeMs: mtime,
			linePctMtimeMs: mtime, // both axes derive from the one .info file
			fileSet: new Set(lcov.files.keys()),
			perFile: (rel, fnRanges, mtime2) => {
				const cf = lcov.files.get(rel);
				return cf ? perFileCoverageFromCanonical(cf, rel, mtime2, fnRanges) : undefined;
			},
			linePct: (rel) => linePctFor(summary, rel),
		});
	}
	return sources;
}

/**
 * Public API — consumed by `metrics` (here) and the every-file-tested gate
 * (`harness/tested-file-policy.ts`). Single-sources the coverage-report loading
 * so the gate's coverage axis and the metrics command never disagree about a
 * file's line-coverage percentage.
 *
 * Both report formats are loaded and MERGED (finding 2026-06): unconditional
 * istanbul-over-LCOV precedence made a polyglot repo's non-istanbul files vanish
 * from metrics and the tested-file gate, and let a STALE istanbul report shadow
 * a fresh LCOV one. Per-file lookups try the FRESHER report first (report-file
 * mtime) and fall back to the other for files it lacks; the file set is the
 * union.
 */
export function loadMetricsCoverage(cwd: string): MetricsCoverage {
	const sources = [istanbulSource(cwd), ...lcovSources(cwd)].filter(
		(s): s is CoverageSource => s !== null,
	);
	const [primary] = sources;
	if (!primary) {
		return {
			available: false,
			source: null,
			fileSet: new Set(),
			perFile: () => undefined,
			linePct: () => null,
		};
	}
	const fileSet = new Set<string>();
	for (const s of sources) {
		for (const f of s.fileSet) fileSet.add(f);
	}
	// Each axis orders by ITS OWN backing file's freshness (finding 2026-06): a
	// fresh coverage-final.json must not let a STALE coverage-summary.json shadow
	// a fresher LCOV line percentage, and vice versa.
	const byPerFile = [...sources].sort((a, b) => b.perFileMtimeMs - a.perFileMtimeMs);
	const byLinePct = [...sources].sort((a, b) => b.linePctMtimeMs - a.linePctMtimeMs);
	// "istanbul+lcov" only when both FORMATS contributed — two per-language LCOV
	// files alone are still just "lcov".
	const kinds = new Set(sources.map((s) => s.kind));
	return {
		available: true,
		source: kinds.size > 1 ? "istanbul+lcov" : primary.kind,
		fileSet,
		perFile: (rel, fnRanges, mtime) => {
			for (const s of byPerFile) {
				const cov = s.perFile(rel, fnRanges, mtime);
				if (cov) return cov;
			}
			return undefined;
		},
		linePct: (rel) => {
			for (const s of byLinePct) {
				const pct = s.linePct(rel);
				if (pct !== null) return pct;
			}
			return null;
		},
	};
}

interface MetricsReport {
	scope: {
		files: number;
		functions: number;
		coverageAvailable: boolean;
		coverageSource: "istanbul" | "lcov" | "istanbul+lcov" | null;
		astComplexityAvailable: boolean;
	};
	gates: {
		functionsOverCrap: number;
		functionsCyclomaticReview: number;
		functionsCyclomaticBad: number;
		filesMissingCompanion: number;
		filesNoCoverage: number;
	};
	distributions: {
		cyclomatic: Record<string, number>;
		crap: Record<string, number>;
	};
	hotspots: FnMetric[];
	missingCompanion: string[];
	files: FileMetric[];
}

const JS_TS_METRIC_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

/**
 * Cyclomatic complexity per function for `interlinked metrics`, DISPATCHED by
 * extension. JS/TS use the AST pass directly (no test-file exemption — metrics
 * measures the harness's own checks/ tree), falling back to the regex walker only
 * when `typescript` is absent. Every other language goes through the
 * language-dispatching `computeCyclomaticComplexity` (Python/Rust/Go walkers).
 *
 * The old `computeCyclomaticAst(content, abs) ?? computeCyclomaticComplexity(...)`
 * silently reported ZERO functions for .py/.rs/.go: with `typescript` installed,
 * the AST pass returns an EMPTY array (not null) for a non-JS file, so the `??`
 * fallback never ran. Dispatch (not "output nonempty") is the contract — a real
 * source file may legitimately contain no functions. Exported for the conformance
 * probe (`analyzerForPath`-style: a branchy .py/.rs/.go fixture must score nonzero).
 */
export function cyclomaticForMetrics(content: string, filePath: string): FunctionComplexityEntry[] {
	if (JS_TS_METRIC_EXTS.has(extname(filePath).toLowerCase())) {
		return computeCyclomaticAst(content, filePath) ?? computeCyclomaticComplexity(content, filePath);
	}
	return computeCyclomaticComplexity(content, filePath);
}

function buildReport(cwd: string, topN: number): MetricsReport {
	const cov = loadMetricsCoverage(cwd);
	// discoverFiles returns absolute paths — normalize to repo-relative for
	// coverage lookup, companion paths, and display.
	const sourceFiles = discoverFiles(cwd)
		.map((f) => relative(cwd, f).replace(/\\/g, "/"))
		.filter((rel) => isAnalyzableSource(rel, cov.fileSet))
		.sort();

	const fns: FnMetric[] = [];
	const files: FileMetric[] = [];
	const missingCompanion: string[] = [];
	let filesNoCoverage = 0;

	for (const rel of sourceFiles) {
		const abs = join(cwd, rel);
		let content: string;
		try {
			content = readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		// Measure complexity on EVERY source file. The AST pass has no test-file
		// exemption — that exemption (in computeCyclomaticComplexity) is for
		// content-quality scans, not measurement, and would hide the harness's
		// own checks/ tree. Fall back to the guarded walker only sans typescript.
		const comps = cyclomaticForMetrics(content, abs);
		const perFile = cov.perFile(rel, comps, statSync(abs).mtimeMs);
		if (cov.available && !perFile) filesNoCoverage++;

		const fileFns: FnMetric[] = perFile
			? computeCrapForFile({
					complexities: comps,
					perFile,
					filePath: rel,
					fileMtime: statSync(abs).mtimeMs,
					threshold: 0,
					staleTolerance: "include",
				}).map((f) => ({
					file: rel,
					name: f.function,
					line: f.line,
					cyclomatic: f.complexity,
					coveragePct: f.coverage_pct,
					crap: f.crap_score,
				}))
			: comps.map((e) => ({
					file: rel,
					name: e.name,
					line: e.line,
					cyclomatic: e.cyclomatic,
					coveragePct: null,
					crap: null,
				}));
		fns.push(...fileFns);

		const companionExpected = !isTddExemptPath(rel);
		const companion = companionExpected
			? companionTestCandidates(abs).some((p) => existsSync(p))
			: null;
		if (companion === false) missingCompanion.push(rel);

		files.push({
			file: rel,
			functions: fileFns.length,
			linePct: cov.linePct(rel),
			maxCyclomatic: fileFns.reduce((m, f) => Math.max(m, f.cyclomatic), 0),
			maxCrap: perFile ? fileFns.reduce((m, f) => Math.max(m, f.crap ?? 0), 0) : null,
			companion,
			overGate: fileFns.filter((f) => (f.crap ?? 0) >= CRAP_GATE).length,
		});
	}

	const cycSorted = fns.map((f) => f.cyclomatic).sort((a, b) => a - b);
	const crapVals = fns
		.map((f) => f.crap)
		.filter((x): x is number => x !== null)
		.sort((a, b) => a - b);

	const hotspots = [...fns]
		.filter((f) => f.crap !== null)
		.sort((a, b) => (b.crap ?? 0) - (a.crap ?? 0))
		.slice(0, topN);

	return {
		scope: {
			files: files.length,
			functions: fns.length,
			coverageAvailable: cov.available,
			coverageSource: cov.source,
			astComplexityAvailable: astComplexityAvailable(),
		},
		gates: {
			functionsOverCrap: crapVals.filter((x) => x >= CRAP_GATE).length,
			functionsCyclomaticReview: fns.filter(
				(f) => f.cyclomatic > CYCLOMATIC_REVIEW && f.cyclomatic <= CYCLOMATIC_BAD,
			).length,
			functionsCyclomaticBad: fns.filter((f) => f.cyclomatic > CYCLOMATIC_BAD).length,
			filesMissingCompanion: missingCompanion.length,
			filesNoCoverage,
		},
		distributions: {
			cyclomatic: bucketize(cycSorted, [5, 10, 15, 25]),
			crap: bucketize(crapVals, [10, 30, 60, 100]),
		},
		hotspots,
		missingCompanion,
		files,
	};
}

/** Count values into "≤b0", "≤b1", …, ">last" buckets. */
function bucketize(sorted: number[], bounds: number[]): Record<string, number> {
	const out: Record<string, number> = {};
	let lo = -Infinity;
	for (const b of bounds) {
		out[`${lo === -Infinity ? "≤" : `${lo}–`}${b}`] = sorted.filter((x) => x > lo && x <= b).length;
		lo = b;
	}
	out[`>${bounds[bounds.length - 1]}`] = sorted.filter((x) => x > lo).length;
	return out;
}

export async function metricsCommand(opts: MetricsOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const topN = Math.max(1, Math.min(200, Number.parseInt(opts.top ?? "25", 10) || 25));
	const report = buildReport(cwd, topN);

	output(mode, report, {
		json: () => report,
		short: () => renderShort(report),
		normal: () => renderNormal(report),
	});
}

function renderShort(r: MetricsReport): string {
	const cov = r.scope.coverageAvailable ? "" : " (no coverage)";
	return `${r.scope.files} files · ${r.scope.functions} fns · CRAP≥${CRAP_GATE}: ${r.gates.functionsOverCrap} · cyc>${CYCLOMATIC_BAD}: ${r.gates.functionsCyclomaticBad} · no-companion: ${r.gates.filesMissingCompanion}${cov}`;
}

function renderNormal(r: MetricsReport): string {
	const lines: string[] = [];
	lines.push(header("Test-Quality Metrics"));
	lines.push(kvLine("Source files", String(r.scope.files)));
	lines.push(kvLine("Functions", String(r.scope.functions)));
	const covLabel = r.scope.coverageAvailable
		? c.green(`present (${r.scope.coverageSource})`)
		: c.yellow("absent (CRAP/coverage unavailable — run `npm run test:coverage`)");
	lines.push(kvLine("Coverage", covLabel));
	if (!r.scope.astComplexityAvailable) {
		lines.push(
			kvLine(
				"Complexity",
				c.yellow("regex fallback — `typescript` not resolvable; install it for AST-accurate metrics"),
			),
		);
	}
	lines.push("");
	lines.push(c.bold("  Gates"));
	lines.push(kvLine("  CRAP ≥ 30", gateStr(r.gates.functionsOverCrap), 22));
	lines.push(kvLine("  cyclomatic > 25", gateStr(r.gates.functionsCyclomaticBad), 22));
	lines.push(kvLine("  cyclomatic 16–25", String(r.gates.functionsCyclomaticReview), 22));
	lines.push(kvLine("  files no companion", gateStr(r.gates.filesMissingCompanion), 22));
	if (r.scope.coverageAvailable) {
		lines.push(kvLine("  files no coverage", String(r.gates.filesNoCoverage), 22));
	}
	lines.push("");
	lines.push(c.bold("  CRAP distribution"));
	for (const [bucket, n] of Object.entries(r.distributions.crap)) {
		lines.push(`    ${bucket.padEnd(10)} ${n}`);
	}
	lines.push("");
	lines.push(c.bold(`  Top ${r.hotspots.length} CRAP hotspots`));
	if (r.hotspots.length === 0) {
		lines.push(c.dim("    (no coverage data — CRAP unavailable)"));
	}
	for (const h of r.hotspots) {
		lines.push(
			`    ${String(Math.round(h.crap ?? 0)).padStart(6)}  cyc=${String(h.cyclomatic).padStart(3)}  cov=${String(Math.round(h.coveragePct ?? 0)).padStart(3)}%  ${h.file}::${h.name}`,
		);
	}
	if (r.missingCompanion.length > 0) {
		lines.push("");
		lines.push(c.bold(`  Files missing a companion test (${r.missingCompanion.length})`));
		for (const f of r.missingCompanion.slice(0, 25)) lines.push(`    ${c.yellow("✗")} ${f}`);
		if (r.missingCompanion.length > 25) {
			lines.push(c.dim(`    … and ${r.missingCompanion.length - 25} more`));
		}
	}
	return lines.join("\n");
}

function gateStr(n: number): string {
	return n === 0 ? c.green("0") : c.red(String(n));
}
