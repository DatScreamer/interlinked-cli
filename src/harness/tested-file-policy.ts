// ===========================================
// Tested-file policy — the single source of truth for the every-file-tested gate
// ===========================================
// Modeled EXACTLY on `large-file-policy.ts`. One module, one verify surface:
//   - verify : the `untested_files` check (commands/verify/file-checks.ts),
//              a report-only finding in the same enforcement tier as
//              `large_files` (the finding-count harness, not a per-section
//              process exit).
//
// A source file is "untested" when it has NEITHER a companion test file NOR
// line coverage at/above the threshold. The threshold and the grandfather list
// live in a checked-in JSON file, `.interlinked/untested-files-baseline.json`,
// so the current offenders are recorded once and the gate becomes a RATCHET:
// the list may shrink (a file gets a test or coverage and drops off) but a new
// untested file that is NOT on the list fails immediately.
//
// Why a synthesis of companion-presence AND coverage (vs. the two existing
// advisory checks `no_test_file` / `files_without_test`, which are
// companion-only): a file can be thoroughly exercised by integration tests
// without owning a sibling `*.test.ts`, and conversely a sibling test file can
// be a near-empty stub. Requiring EITHER axis is the honest "is this file
// actually tested" question; the two advisory checks stay as-is for the deep
// `--all-checks` audit.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
	companionTestCandidates,
	isTddExemptPath,
} from "./evaluator/tdd-new-file-gate.js";

/**
 * Default minimum line-coverage percent that counts a companion-less file as
 * "tested" on the coverage axis.
 *
 * THE canonical threshold. This constant and the committed baseline's
 * `min_coverage_pct` (.interlinked/untested-files-baseline.json) are the SAME
 * number — a regression test in `tested-file-policy.test.ts` pins them equal so
 * the threshold can never be two different values depending on whether a
 * baseline loaded. `evaluateTestedFile` reads the baseline value when present
 * and falls back to this constant when absent; keeping them equal means the
 * fallback is never a *different* threshold.
 *
 * 60% is deliberately modest: the gate's job is to flag files with essentially
 * no test exposure (no companion AND thin coverage), not to enforce a coverage
 * target — `coverage-ratchet` / `metrics` own the "drive coverage up" work.
 */
export const DEFAULT_MIN_COVERAGE_PCT = 60;

/** Repo-relative path of the baseline file. Module-private — callers go
 *  through `loadUntestedFilesBaseline` / `minCoverageFor`. */
const UNTESTED_BASELINE_REL = ".interlinked/untested-files-baseline.json";

/**
 * Source extensions whose test exposure we judge. Mirrors metrics'
 * `ANALYZABLE_EXT_RE` (tsx?/jsx?/mjs/cjs/py/rs/go) deliberately — NOT
 * tdd-new-file-gate's TS-only `SOURCE_EXT_RE`, which would let the companion
 * axis over-fire on a `.go` file that has no `*.test.go` sibling convention we
 * model. Path exclusions (tests, fixtures, declarations, landing/, …) come
 * from `isTddExemptPath`; this regex is purely the language gate.
 */
const TESTABLE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)$/;

/** Per-file coverage threshold config + grandfather list. */
export interface UntestedFilesBaseline {
	/** Schema version. */
	version: number;
	/** Coverage % at/above which a companion-less file counts as tested. */
	min_coverage_pct: number;
	/**
	 * Grandfathered offenders: repo-relative POSIX paths currently untested.
	 * A listed file is allowed to stay untested; remove it once it gains a
	 * companion test or crosses the coverage threshold. The list may shrink
	 * but adding a new untested file (not listed) fails the gate.
	 */
	files: Set<string>;
}

let baselineCache = new Map<string, UntestedFilesBaseline | null>();

/**
 * Load `.interlinked/untested-files-baseline.json` for `cwd`. Memoized per
 * cwd (cheap for verify's hundreds of per-file calls). Fail-soft: a missing
 * or malformed file yields `null` — callers fall back to
 * `DEFAULT_MIN_COVERAGE_PCT` with no grandfathering.
 *
 * The cache is process-lifetime; the harness daemon picks up baseline edits on
 * restart (the standard post-edit `harness restart` flow). Tests can force a
 * reload via `resetUntestedFilesBaselineCache()`.
 */
export function loadUntestedFilesBaseline(cwd: string): UntestedFilesBaseline | null {
	const cached = baselineCache.get(cwd);
	if (cached !== undefined) return cached;

	let result: UntestedFilesBaseline | null = null;
	try {
		const path = join(cwd, UNTESTED_BASELINE_REL);
		if (existsSync(path)) {
			// `: unknown` annotation (not an `as` cast) narrows JSON.parse's
			// `any` return to `unknown` — normalizeBaseline validates it.
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			result = normalizeBaseline(raw);
		}
	} catch {
		result = null; // malformed JSON -> default threshold, no grandfathering
	}
	baselineCache.set(cwd, result);
	return result;
}

/** Expected raw shape of a parsed baseline file — every field is `unknown`
 *  until validated by `normalizeBaseline`. */
interface RawBaseline {
	version?: unknown;
	min_coverage_pct?: unknown;
	files?: unknown;
}

/** Validate + normalize a parsed baseline; returns null when unusable. */
function normalizeBaseline(raw: unknown): UntestedFilesBaseline | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as RawBaseline;
	if (typeof obj.min_coverage_pct !== "number" || obj.min_coverage_pct < 0) return null;
	const files = new Set<string>();
	if (Array.isArray(obj.files)) {
		for (const entry of obj.files) {
			if (typeof entry === "string" && entry.length > 0) {
				files.add(entry.replace(/\\/g, "/"));
			}
		}
	}
	return {
		version: typeof obj.version === "number" ? obj.version : 1,
		min_coverage_pct: obj.min_coverage_pct,
		files,
	};
}

/** Clear the memoized baseline (after writing/regenerating the file). */
export function resetUntestedFilesBaselineCache(): void {
	baselineCache = new Map();
}

/** The active coverage threshold for `cwd` (baseline override, else default). */
export function minCoverageFor(cwd: string): number {
	return loadUntestedFilesBaseline(cwd)?.min_coverage_pct ?? DEFAULT_MIN_COVERAGE_PCT;
}

/**
 * Whether the every-file-tested gate applies to this file. True only for
 * non-exempt source modules in a language we judge test exposure for. Path
 * exclusions (tests, fixtures, declarations, generated dirs, landing/web/site,
 * scripts, node_modules, .claude/.interlinked, config files) are delegated to
 * `isTddExemptPath` so the exempt set stays single-sourced with the TDD gate;
 * the extension gate widens beyond TS to all coverage-adapter languages.
 */
export function isTestableSourceFile(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (!TESTABLE_EXT_RE.test(norm)) return false;
	if (isTddExemptPath(norm)) return false;
	return true;
}

/** Whether a companion test file exists on disk for `relPath`. `cwd` resolves
 *  the relative path to the absolute one `companionTestCandidates` requires. */
export function hasCompanionTest(relPath: string, cwd: string): boolean {
	const abs = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
	return companionTestCandidates(abs).some((candidate) => existsSync(candidate));
}

/** Verify-side verdict for a single file's test exposure. */
export interface TestedFileVerdict {
	/** No companion test AND coverage below threshold (or absent). */
	untested: boolean;
	/** Listed in the baseline — recorded offender, does not fail the gate. */
	grandfathered: boolean;
}

/**
 * Judge a single file's test exposure against the companion-presence axis, the
 * coverage axis, and the grandfather list. Used by the `untested_files` verify
 * check.
 *
 * Untested iff there is NO companion test AND (coverage is absent — `null`,
 * meaning the file appears nowhere in the coverage report — OR coverage is
 * below the threshold). A `null` coverage is treated as untested rather than
 * fail-open: a source file the coverage report never mentions ran zero of its
 * lines under the suite, which is exactly the "essentially no test exposure"
 * case the gate targets. The companion axis is the escape hatch — a file with
 * a sibling test passes regardless of coverage data availability.
 */
export function evaluateTestedFile(args: {
	input: { relPath: string; hasCompanion: boolean; coveragePct: number | null };
	baseline: UntestedFilesBaseline | null;
}): TestedFileVerdict {
	const { relPath, hasCompanion, coveragePct } = args.input;
	const threshold = args.baseline?.min_coverage_pct ?? DEFAULT_MIN_COVERAGE_PCT;
	const coveredEnough = coveragePct !== null && coveragePct >= threshold;
	const untested = !hasCompanion && !coveredEnough;
	const grandfathered =
		untested && (args.baseline?.files.has(relPath.replace(/\\/g, "/")) ?? false);
	return { untested, grandfathered };
}
