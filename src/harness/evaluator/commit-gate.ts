// ===========================================
// PreToolUse Bash gate — COMMIT-TIME quality bar
// ===========================================
// The hard gate for repos whose suite is too big for per-edit enforcement
// (`evaluator/coverage-write-guard.ts` defers to a commit-time obligation when
// the rolling suite estimate exceeds `per_edit_coverage.budget_ms`). This gate
// intercepts a real `git commit` Bash tool call at PreToolUse and BLOCKS it when
// the working tree violates the quality bar:
//
//   (a) RED bar      — the full suite came back failing (`testsPassed === false`).
//   (b) UNCOVERED    — any changed source file has an executable-but-uncovered
//                      line after the suite ran (strict TDD at commit boundary).
//   (c) CRAP         — any changed function's CRAP score >= `crap_threshold`
//                      (REUSED `crapScore` / `computeCrap` from `checks/crap.ts`).
//   (d) CYCLOMATIC   — any changed function's cyclomatic complexity > 25 (the
//                      hard cap; the strict per-edit gate caps lower but commit
//                      time is a coarser net — a function this branchy is a
//                      maintenance hazard regardless of coverage).
//
// Unlike `coverage-write-guard.ts` (apply-before-disk OVERLAY of the proposed
// edit), the commit gate runs against the REAL working tree — every changed file
// is already on disk, so no overlay is needed. It runs the project's FULL suite
// under coverage via the same language {@link CoverageRunner}.
//
// Safety properties (mirror the per-edit gate):
//   1. CONFIG-GATED, DEFAULT OFF. Runs only when `rules.per_edit_coverage.enabled`
//      is true. A repo that does not opt in returns at the first gate before any
//      git shell-out or suite run — zero cost. This gate is DORMANT today
//      (per_edit_coverage defaults OFF).
//   2. GENEROUS TIMEOUT. Commit time is allowed to run the full suite — there is
//      NO ~25s per-edit budget here. The runner gets {@link COMMIT_RUN_TIMEOUT_MS}.
//   3. FAIL-OPEN. A runner that is unavailable / can't measure, a git-diff that
//      can't run, or any thrown error all loud-degrade (stderr warn, allow). A
//      commit must never be blocked by the gate's OWN failure — only by a clean,
//      definitive measurement.
//   4. `--no-verify` is NOTED. The agent can pass `--no-verify` to skip git's own
//      hooks; the gate still evaluates (it is not a git hook) but surfaces a
//      warning that the bypass was requested, so it is visible in the trail.
//
// Every dependency (CoverageRunner factory, git-diff fn, cyclomatic analyzer,
// clock, file reader) is INJECTED via {@link CommitGateDeps} so the unit tests
// stub them and NO real suite / git / analyzer runs. The `git commit` detection
// itself lives in the sibling `commit-parse.ts` (re-exported below).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { computeCrap, crapScore } from "../checks/crap.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import {
	type CoverageLanguage,
	type CoverageRunner,
	coverageRunnerFor,
} from "../coverage-runner.js";
import { isCappableFile } from "../large-file-policy.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { parseGitCommit } from "./commit-parse.js";

// Re-export the parser surface so existing call sites / tests import it from the
// gate module too.
export { parseGitCommit } from "./commit-parse.js";
export type { CommitParse } from "./commit-parse.js";

/**
 * A per-function cyclomatic counter for one language. Returns `null` when the
 * backing analyzer is unavailable (typescript / radon absent) — the loud "do not
 * treat as simple" signal, which the cyclomatic + CRAP checks fail-open on.
 */
export type CyclomaticAnalyzer = (
	content: string,
	filePath: string,
) => FunctionComplexityEntry[] | null;

/**
 * List the repo-relative POSIX paths of source files changed since HEAD (working
 * tree + staged), for the commit about to run. Returns `null` when the diff could
 * not be taken (git missing, not a repo) — the gate fail-opens on `null`.
 */
export type GitChangedFilesFn = (projectRoot: string) => string[] | null;

/** Injectable seams so unit tests run with NO real suite / git / analyzer. */
export interface CommitGateDeps {
	/** Resolve a CoverageRunner for a language (default: the real factory). */
	runnerFor: (language: CoverageLanguage) => CoverageRunner | null;
	/** List changed source files vs HEAD (default: the real `git diff`). */
	gitChangedFiles: GitChangedFilesFn;
	/** The per-function cyclomatic analyzer for a language (default: TS AST / radon). */
	cyclomaticFor: (language: CoverageLanguage) => CyclomaticAnalyzer | null;
	/** Wall clock — injected for deterministic timestamps in tests. */
	clock: () => number;
	/** Read a file's current content from disk (default: `fs.readFileSync`). */
	readFile: (absPath: string) => string | null;
}

/** The default CRAP cutoff — the McCabe / SonarQube convention (matches the per-edit gate). */
const DEFAULT_CRAP_THRESHOLD = 30;

/**
 * The hard commit-time cyclomatic cap. A changed function above this blocks the
 * commit. Deliberately looser than the strict per-edit cyclomatic gate: the
 * commit gate is the coarse safety net for big-suite repos, not the fine-grained
 * per-edit lever, so it only fires on genuinely pathological complexity.
 */
const COMMIT_CYCLOMATIC_CAP = 25;

/**
 * Generous per-run timeout (ms) for the commit-time suite. Commit time is allowed
 * to run the full suite (no per-edit budget), so this is far above the per-edit
 * `DEFAULT_RUN_TIMEOUT_MS` — a large suite must have room to finish.
 */
export const COMMIT_RUN_TIMEOUT_MS = 600_000;

/** Shared timeout for the short-lived read-only `git` invocations the gate runs. */
const GIT_TIMEOUT_MS = 5_000;

/** Cap on the number of named violations in a block reason (keep it scannable). */
const MAX_NAMED_VIOLATIONS = 8;

/** The real cyclomatic analyzer for a coverage language, or null to skip. */
function defaultCyclomaticFor(language: CoverageLanguage): CyclomaticAnalyzer | null {
	switch (language) {
		case "js":
		case "ts":
			return computeCyclomaticAst;
		case "python":
			return computeCyclomaticPython;
		default:
			return null;
	}
}

/** Run one read-only `git` command, returning its trimmed nonempty lines or null. */
function gitLines(projectRoot: string, args: string[]): string[] | null {
	try {
		const out = execFileSync("git", args, {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
		});
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch {
		return null;
	}
}

/**
 * The real changed-files function: `git diff --name-only HEAD` (working tree vs
 * HEAD, which already includes staged changes) UNION `git diff --cached
 * --name-only` (staged, to cover the edge case where a path is staged but the
 * working copy was reverted). Read-only. Returns `null` only when BOTH git
 * invocations fail so the gate fail-opens rather than blocking when git can't
 * answer at all.
 */
function defaultGitChangedFiles(projectRoot: string): string[] | null {
	const worktree = gitLines(projectRoot, ["diff", "--name-only", "HEAD"]);
	const staged = gitLines(projectRoot, ["diff", "--cached", "--name-only"]);
	if (worktree === null && staged === null) return null; // git unusable → fail-open
	return [...new Set<string>([...(worktree ?? []), ...(staged ?? [])])];
}

/** Production defaults — real runner factory, git diff, analyzer, clock, reader. */
const DEFAULT_DEPS: CommitGateDeps = {
	runnerFor: (language) => coverageRunnerFor(language),
	gitChangedFiles: defaultGitChangedFiles,
	cyclomaticFor: defaultCyclomaticFor,
	clock: Date.now,
	readFile: (absPath) => {
		try {
			return existsSync(absPath) ? readFileSync(absPath, "utf-8") : null;
		} catch {
			return null;
		}
	},
};

// ===========================================
// Language mapping (shared shape with the per-edit gate)
// ===========================================

/** Map a file extension to the coverage language, or null when unsupported. */
function languageForExt(ext: string): CoverageLanguage | null {
	switch (ext.toLowerCase()) {
		case ".ts":
		case ".tsx":
		case ".mts":
		case ".cts":
			return "ts";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "js";
		case ".py":
		case ".pyi":
			return "python";
		default:
			return null;
	}
}

/** A changed source file the gate will evaluate, with its resolved language. */
interface ChangedSource {
	relPath: string;
	language: CoverageLanguage;
}

/**
 * Filter the raw changed-path list to the source files the gate evaluates: a
 * supported language, in the configured `languages` set, and a "cappable" file
 * (the same predicate the line cap uses — excludes test files, generated code,
 * `.d.ts`, non-code). Reads each file's content to apply `isCappableFile`; a path
 * that no longer exists on disk (a pure deletion) is dropped.
 */
function selectChangedSources(
	rawPaths: string[],
	projectRoot: string,
	languages: string[],
	readFile: CommitGateDeps["readFile"],
): ChangedSource[] {
	const out: ChangedSource[] = [];
	for (const relPath of rawPaths) {
		const language = languageForExt(extname(relPath));
		if (!language || !languages.includes(language)) continue;
		const abs = isAbsolute(relPath) ? relPath : resolve(projectRoot, relPath);
		const content = readFile(abs);
		if (content === null) continue; // deleted / unreadable — nothing to gate
		if (!isCappableFile({ filePath: relPath, content })) continue;
		out.push({ relPath, language });
	}
	return out;
}

// ===========================================
// Per-source violation detection
// ===========================================

/** True when the runner reported native per-line coverage (coverage.py path). */
function hasPerLineData(cov: PerFileCoverage): boolean {
	return cov.uncoveredLines !== undefined || cov.coveredLines !== undefined;
}

/** The lowest uncovered executable line for a per-line (coverage.py) report, or null. */
function firstUncoveredLine(cov: PerFileCoverage): number | null {
	const uncovered = cov.uncoveredLines ?? new Set<number>();
	let lowest: number | null = null;
	for (const ln of uncovered) {
		if (lowest === null || ln < lowest) lowest = ln;
	}
	return lowest;
}

/** The first uncovered function for a per-function (istanbul / JS) report, or null. */
function firstUncoveredFunction(cov: PerFileCoverage): { name: string; line: number } | null {
	for (const fn of cov.functions) {
		if (fn.hits === 0 || fn.statement_pct === 0) return { name: fn.name, line: fn.line };
	}
	return null;
}

/** Count how many of [start,end] (inclusive) appear in `lines`. */
function countInRange(lines: ReadonlySet<number>, start: number, end: number): number {
	let n = 0;
	for (const ln of lines) {
		if (ln >= start && ln <= end) n++;
	}
	return n;
}

/** One CRAP violation for a changed file (worst-first ranked by the callers). */
interface CrapHit {
	function: string;
	line: number;
	cyclomatic: number;
	coverage_pct: number;
	crap_score: number;
}

/**
 * CRAP violations for a PER-FUNCTION (istanbul / JS) coverage report. REUSES
 * `computeCrap` — exact formula + the ±3-line name/line matching — never
 * reimplemented here. Returns the worst-first list at/above `threshold`.
 */
function crapHitsPerFunction(
	relPath: string,
	complexities: FunctionComplexityEntry[],
	cov: PerFileCoverage,
	threshold: number,
): CrapHit[] {
	const findings = computeCrap({
		complexities,
		coverage: cov.functions,
		filePath: relPath,
		fileMtime: 0,
		coverageMtime: null, // fresh: this is THIS run's coverage
		threshold,
		staleTolerance: "include",
	});
	return findings.map((f) => ({
		function: f.function,
		line: f.line,
		cyclomatic: f.complexity,
		coverage_pct: f.coverage_pct,
		crap_score: f.crap_score,
	}));
}

/**
 * CRAP violations for a PER-LINE (Python / coverage.py) coverage report. No
 * function ranges exist, so per-function coverage is the covered lines inside each
 * analyzer-reported body range over its executable lines. Scores via the REUSED
 * `crapScore`. Sorted worst-first.
 */
function crapHitsPerLine(
	complexities: FunctionComplexityEntry[],
	cov: PerFileCoverage,
	threshold: number,
): CrapHit[] {
	const covered = cov.coveredLines ?? new Set<number>();
	const uncovered = cov.uncoveredLines ?? new Set<number>();
	const hits: CrapHit[] = [];
	for (const fn of complexities) {
		const inCovered = countInRange(covered, fn.line, fn.endLine);
		const inUncovered = countInRange(uncovered, fn.line, fn.endLine);
		const executable = inCovered + inUncovered;
		if (executable === 0) continue;
		const covPct = (inCovered / executable) * 100;
		const score = crapScore(fn.cyclomatic, covPct);
		if (score < threshold) continue;
		hits.push({
			function: fn.name,
			line: fn.line,
			cyclomatic: fn.cyclomatic,
			coverage_pct: covPct,
			crap_score: score,
		});
	}
	hits.sort((a, b) => b.crap_score - a.crap_score);
	return hits;
}

/** A single named violation for the block reason. */
interface Violation {
	kind: "uncovered" | "crap" | "cyclomatic";
	file: string;
	detail: string;
}

/** The worst (first) over-cap cyclomatic function for a file, or null. */
function firstOverCapCyclomatic(
	complexities: FunctionComplexityEntry[],
): FunctionComplexityEntry | null {
	let worst: FunctionComplexityEntry | null = null;
	for (const fn of complexities) {
		if (fn.cyclomatic <= COMMIT_CYCLOMATIC_CAP) continue;
		if (!worst || fn.cyclomatic > worst.cyclomatic) worst = fn;
	}
	return worst;
}

/** Inputs to the per-file violation scan — explicit so it needs no broader ctx. */
interface ScanInput {
	source: ChangedSource;
	cov: PerFileCoverage | undefined;
	content: string;
	analyzer: CyclomaticAnalyzer | null;
	crapThreshold: number;
}

/** The uncovered-line / uncovered-function coverage violation for a file, or null. */
function coverageViolation(source: ChangedSource, cov: PerFileCoverage): Violation | null {
	if (hasPerLineData(cov)) {
		const line = firstUncoveredLine(cov);
		if (line !== null) {
			return {
				kind: "uncovered",
				file: source.relPath,
				detail: `line ${line} is executable but uncovered`,
			};
		}
		return null;
	}
	const fn = firstUncoveredFunction(cov);
	if (fn) {
		return {
			kind: "uncovered",
			file: source.relPath,
			detail: `\`${fn.name}\` (line ${fn.line}) is executable but uncovered`,
		};
	}
	return null;
}

/** The over-cap cyclomatic violation for a file, or null. */
function cyclomaticViolation(
	source: ChangedSource,
	complexities: FunctionComplexityEntry[],
): Violation | null {
	const overCap = firstOverCapCyclomatic(complexities);
	if (!overCap) return null;
	return {
		kind: "cyclomatic",
		file: source.relPath,
		detail: `\`${overCap.name}\` (line ${overCap.line}) has cyclomatic complexity ${overCap.cyclomatic} (cap ${COMMIT_CYCLOMATIC_CAP})`,
	};
}

/** The worst CRAP violation for a file, or null. */
function crapViolation(
	source: ChangedSource,
	complexities: FunctionComplexityEntry[],
	cov: PerFileCoverage,
	threshold: number,
): Violation | null {
	const hits = hasPerLineData(cov)
		? crapHitsPerLine(complexities, cov, threshold)
		: crapHitsPerFunction(source.relPath, complexities, cov, threshold);
	const worst = hits[0];
	if (!worst) return null;
	return {
		kind: "crap",
		file: source.relPath,
		detail: `\`${worst.function}\` (line ${worst.line}) has a CRAP score of ${Math.round(worst.crap_score)} (cyclomatic ${worst.cyclomatic}, coverage ${Math.round(worst.coverage_pct)}%)`,
	};
}

/**
 * Collect every violation for one changed file: an uncovered executable line, a
 * function over the cyclomatic cap, and a function over the CRAP threshold. The
 * cyclomatic + CRAP checks need the analyzer; when it is unavailable (null) they
 * are skipped for this file (the loud-degrade is logged once by the caller).
 * Coverage checks run whenever the file appears in the report.
 */
function scanFile(input: ScanInput): Violation[] {
	const { source, cov, content, analyzer, crapThreshold } = input;
	const violations: Violation[] = [];

	if (cov) {
		const covViolation = coverageViolation(source, cov);
		if (covViolation) violations.push(covViolation);
	}

	// The cyclomatic + CRAP checks need a per-function analysis. An UNAVAILABLE
	// analyzer (null) or one that returned null (typescript / radon absent, or a
	// parse failure) loud-degrades — exactly like the per-edit gate fail-opens on
	// an unmeasured suite — and those two checks are skipped for this file. The
	// coverage check above already ran regardless.
	const complexities = analyzer ? analyzer(content, source.relPath) : null;
	if (!complexities) {
		loudDegrade(
			`no cyclomatic analysis for ${source.relPath} — CRAP / cyclomatic checks skipped`,
		);
		return violations;
	}
	const cycViolation = cyclomaticViolation(source, complexities);
	if (cycViolation) violations.push(cycViolation);
	if (cov) {
		const crapV = crapViolation(source, complexities, cov, crapThreshold);
		if (crapV) violations.push(crapV);
	}

	return violations;
}

// ===========================================
// Block / degrade builders
// ===========================================

/** Loud-degrade: warn on stderr, then allow (return null). Fail-open. */
function loudDegrade(why: string): null {
	process.stderr.write(
		`[interlinked:commit-gate] WARNING: commit-time quality gate degraded (${why}) — ` +
			"allowing the commit (fail-open). The quality bar was NOT enforced for this commit.\n",
	);
	return null;
}

/** The red-bar (failing-suite) phrase for the block reason. */
function failingTestPhrase(failingTests: string[]): string {
	if (failingTests.length === 0) return "one or more tests are failing";
	const shown = failingTests.slice(0, 3);
	const suffix = failingTests.length > shown.length ? ", …" : "";
	return `failing test(s): ${shown.join(", ")}${suffix}`;
}

/** Attach warnings to a decision only when there are any (exactOptionalPropertyTypes). */
function withWarnings(decision: HarnessDecision, warnings: string[]): HarnessDecision {
	return warnings.length > 0 ? { ...decision, warnings } : decision;
}

/** Build the red-bar commit block — a failing suite is the hardest failure. */
function blockForRedBar(failingTests: string[], warnings: string[]): HarnessDecision {
	return withWarnings(
		{
			decision: "block",
			reason:
				"[interlinked:commit-gate] BLOCKED: the full test suite is RED on the working tree " +
				`you are about to commit — ${failingTestPhrase(failingTests)}. ` +
				"Fix the failing test(s) before committing — a commit must not capture a red bar.",
			rule_id: "commit-gate",
			severity: "high",
			category: "coverage",
		},
		warnings,
	);
}

/** Build the violations commit block, naming each violation. */
function blockForViolations(violations: Violation[], warnings: string[]): HarnessDecision {
	const shown = violations.slice(0, MAX_NAMED_VIOLATIONS);
	const more =
		violations.length > shown.length ? `\n  … and ${violations.length - shown.length} more` : "";
	const lines = shown.map((v) => `  - [${v.kind}] ${v.file}: ${v.detail}`).join("\n");
	return withWarnings(
		{
			decision: "block",
			reason:
				"[interlinked:commit-gate] BLOCKED: the working tree you are about to commit violates " +
				`the quality bar (${violations.length} issue${violations.length === 1 ? "" : "s"}):\n` +
				lines +
				more +
				"\n\nResolve these in the changed files (add coverage, decompose complex functions) " +
				"before committing — this repo enforces the quality bar at commit time because its " +
				"suite is too large for per-edit enforcement.",
			rule_id: "commit-gate",
			severity: "high",
			category: "coverage",
		},
		warnings,
	);
}

// ===========================================
// Suite run + scan
// ===========================================

/** Resolved, validated inputs for the suite run + scan. */
interface GateContext {
	projectRoot: string;
	sources: ChangedSource[];
	crapThreshold: number;
	warnings: string[];
}

/** The merged outcome of running every changed language's suite. */
interface SuiteOutcome {
	perFile: Map<string, PerFileCoverage>;
	failingTests: string[];
	anyRed: boolean;
	/** Set to a loud-degrade reason when any language's run could not be measured. */
	degradeReason: string | null;
}

/**
 * Run the full suite once per distinct changed-source language and merge the
 * per-file coverage maps. A runner that is missing or could not measure sets
 * `degradeReason` (the caller fail-opens). Red is OR-ed across languages.
 */
async function runSuites(ctx: GateContext, deps: CommitGateDeps): Promise<SuiteOutcome> {
	const languages = [...new Set(ctx.sources.map((s) => s.language))];
	const perFile = new Map<string, PerFileCoverage>();
	const failingTests: string[] = [];
	let anyRed = false;

	for (const language of languages) {
		const runner = deps.runnerFor(language);
		if (!runner) {
			return { perFile, failingTests, anyRed, degradeReason: `no coverage runner for ${language}` };
		}
		const result = await runner.run({
			projectRoot: ctx.projectRoot,
			coverageDir: `${ctx.projectRoot}/.interlinked/commit-gate-coverage`,
			timeoutMs: COMMIT_RUN_TIMEOUT_MS,
		});
		if (!result.ok) {
			const why = result.error ?? `coverage run failed for ${language}`;
			return { perFile, failingTests, anyRed, degradeReason: why };
		}
		if (result.testsPassed === false) {
			anyRed = true;
			if (result.failingTests) failingTests.push(...result.failingTests);
		}
		for (const [k, v] of result.perFile) perFile.set(k, v);
	}
	return { perFile, failingTests, anyRed, degradeReason: null };
}

/** Scan every changed source for violations against the merged coverage map. */
function collectViolations(
	ctx: GateContext,
	perFile: Map<string, PerFileCoverage>,
	deps: CommitGateDeps,
): Violation[] {
	const violations: Violation[] = [];
	for (const source of ctx.sources) {
		const abs = isAbsolute(source.relPath)
			? source.relPath
			: resolve(ctx.projectRoot, source.relPath);
		const content = deps.readFile(abs);
		if (content === null) continue; // raced deletion — skip
		violations.push(
			...scanFile({
				source,
				cov: perFile.get(source.relPath),
				content,
				analyzer: deps.cyclomaticFor(source.language),
				crapThreshold: ctx.crapThreshold,
			}),
		);
	}
	return violations;
}

/**
 * Run the FULL suite under coverage for the languages spanned by the changed
 * sources, then scan each changed file for violations. Returns a block decision
 * or null (allow). Split out of {@link checkCommitGate} so the entry stays
 * low-complexity. Throwing is contained by the entry's try/catch (loud-degrade).
 */
async function runSuiteAndScan(
	ctx: GateContext,
	deps: CommitGateDeps,
): Promise<HarnessDecision | null> {
	const outcome = await runSuites(ctx, deps);
	if (outcome.degradeReason !== null) return loudDegrade(outcome.degradeReason);

	// Red bar first — a failing suite is a harder failure than a coverage gap.
	if (outcome.anyRed) return blockForRedBar(outcome.failingTests, ctx.warnings);

	const violations = collectViolations(ctx, outcome.perFile, deps);
	if (violations.length > 0) return blockForViolations(violations, ctx.warnings);

	// Clean tree → allow. Carry any accumulated warnings (e.g. the `--no-verify`
	// note) so the bypass attempt stays visible; otherwise a clean no-op (null).
	return ctx.warnings.length > 0 ? { decision: "allow", warnings: ctx.warnings } : null;
}

// ===========================================
// Entry point
// ===========================================

/** The `--no-verify` advisory warning, surfaced whenever the bypass is requested. */
function noVerifyWarnings(noVerify: boolean): string[] {
	if (!noVerify) return [];
	return [
		"[interlinked:commit-gate] NOTE: `--no-verify` was passed — it bypasses git's own " +
			"commit hooks. The interlinked commit-time quality gate still evaluated this commit.",
	];
}

/**
 * Loud-degrade (allow) that still carries any accumulated warnings (e.g. the
 * `--no-verify` note). Returns an allow decision with warnings when present, else
 * the bare `loudDegrade` null — so the no-warning path stays a clean no-op.
 */
function degradeWithWarnings(why: string, warnings: string[]): HarnessDecision | null {
	loudDegrade(why);
	return warnings.length > 0 ? { decision: "allow", warnings } : null;
}

/**
 * PreToolUse commit gate. Returns a `block` HarnessDecision when the command is a
 * real `git commit` AND `per_edit_coverage.enabled` AND the working tree fails the
 * quality bar (red suite / uncovered changed line / CRAP-over / cyclomatic-over);
 * otherwise `null` (allow / not applicable). A pure no-op — no git, no suite — when
 * the feature is OFF, the command isn't a commit, or no changed file is a gated
 * source. Never throws (fail-open). `--no-verify` is surfaced as a warning on the
 * decision (block or allow) so the bypass attempt is visible.
 */
export async function checkCommitGate(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	deps: CommitGateDeps = DEFAULT_DEPS,
): Promise<HarnessDecision | null> {
	// Gate 1: feature OFF → pure no-op (default today).
	const cfg = rules.per_edit_coverage;
	if (!cfg?.enabled) return null;

	const command = (event.tool_input?.command as string) || "";
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;

	// `--no-verify` is a bypass of git's hooks (not this gate). Note it so the
	// attempt is visible whether we end up blocking or allowing.
	const warnings = noVerifyWarnings(parse.noVerify);

	try {
		const projectRoot = event.cwd || process.cwd();
		const changed = deps.gitChangedFiles(projectRoot);
		if (changed === null) {
			return degradeWithWarnings("git diff unavailable — cannot determine changed files", warnings);
		}
		const sources = selectChangedSources(changed, projectRoot, cfg.languages, deps.readFile);
		// Nothing gated changed (only tests / docs / config) → allow, but still
		// surface the --no-verify note if present.
		if (sources.length === 0) return warnings.length > 0 ? { decision: "allow", warnings } : null;

		return await runSuiteAndScan(
			{
				projectRoot,
				sources,
				crapThreshold: cfg.crap_threshold ?? DEFAULT_CRAP_THRESHOLD,
				warnings,
			},
			deps,
		);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return degradeWithWarnings(why, warnings);
	}
}
