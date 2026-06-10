// ===========================================
// PreToolUse Bash gate — COMMIT-TIME quality bar
// ===========================================
// The hard gate for repos whose suite is too big for per-edit enforcement
// (`evaluator/coverage-write-guard.ts` defers to a commit-time obligation when
// the rolling suite estimate exceeds `per_edit_coverage.budget_ms`). This gate
// intercepts a real `git commit` Bash tool call at PreToolUse and BLOCKS it when
// the working tree violates the quality bar:
//
//   (a) RED bar      — the full suite came back failing (`testsPassed === false`),
//                      when `block_on_test_failure` is on (the same opt-out the
//                      per-edit gate honors).
//   (b) UNCOVERED    — any changed source file has an executable-but-uncovered
//                      line after the suite ran (strict TDD at commit boundary).
//   (c) CRAP         — any changed function's CRAP score >= `crap_threshold`
//                      (REUSED `crapScore` / `computeCrap` from `checks/crap.ts`),
//                      when `block_on_crap` is on.
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
//   1. CONFIG-GATED (DEFAULT ON — see `rules/default-config.ts`). Runs only when
//      `rules.per_edit_coverage.enabled` is true AND `mode === "block"` — the
//      documented `mode: "warn"` / `block_on_test_failure: false` /
//      `block_on_crap: false` opt-outs are honored HERE exactly as at the
//      per-edit gate (finding 2026-06: only `enabled` was checked, so a repo's
//      opt-outs went ineffective precisely when per-edit checks deferred to
//      commit time). A repo that opts OUT returns at the first gate before any
//      git shell-out or suite run — zero cost. On a big suite (THIS repo) the
//      per-edit overlay defers to THIS commit gate, so it is the LIVE
//      enforcement surface here, not a dormant one.
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
// itself lives in the sibling `commit-parse.ts`; the changed-file selection
// (git queries, pathspec rebase, narrow filter, scan/deletion split) in
// `commit-gate-changes.ts` (both re-exported below).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { recordCoverageDischarge } from "../coverage-obligation-ledger.js";
import {
	type CoverageLanguage,
	type CoverageRunner,
	coverageRunnerFor,
} from "../coverage-runner.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	changedSetForCommit,
	defaultGitChangedFiles,
	defaultResolveRepoRoot,
	type EvalMode,
	type GitChangedFilesFn,
	rebaseConstructedPaths,
	selectChangedSources,
} from "./commit-gate-changes.js";
import {
	type ChangedSource,
	coverageViolation,
	crapViolation,
	cyclomaticViolation,
	isTypeOnlySource,
	missingCoverageViolation,
	type Violation,
} from "./commit-gate-scan.js";
import { parseGitCommit } from "./commit-parse.js";
import { materializeIndexSnapshot, type StagedSnapshot } from "./staged-snapshot.js";

export type { GitChangedFilesFn } from "./commit-gate-changes.js";
export { defaultGitChangedFiles, defaultResolveRepoRoot } from "./commit-gate-changes.js";
export type { CommitParse } from "./commit-parse.js";
// Re-export the parser + selection surfaces so existing call sites / tests import
// them from the gate module too.
export { parseGitCommit } from "./commit-parse.js";

/**
 * A per-function cyclomatic counter for one language. Returns `null` when the
 * backing analyzer is unavailable (typescript / radon absent) — the loud "do not
 * treat as simple" signal, which the cyclomatic + CRAP checks fail-open on.
 */
export type CyclomaticAnalyzer = (
	content: string,
	filePath: string,
) => FunctionComplexityEntry[] | null;

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
	/** Discharge a file's deferred coverage obligation on a clean pass (finding 12;
	 *  default: the real ledger append). Optional: tests that don't assert discharge
	 *  omit it and the discharge is a no-op. */
	recordDischarge?: (projectRoot: string, file: string, sessionId: string, timestamp: string) => void;
	/** Resolve a directory to its git repository TOPLEVEL (finding 2026-06: git emits
	 *  toplevel-relative paths, so a `cd src && git commit -a` must anchor at the
	 *  toplevel, not the subdirectory). Optional: when absent (or it returns null)
	 *  the gate uses the command's cwd — exactly the pre-fix behavior. Default: the
	 *  real `git rev-parse --show-toplevel`. */
	resolveRepoRoot?: (dir: string) => string | null;
	/**
	 * Materialize the would-be-committed tree so the gate evaluates the commit, not
	 * the raw working tree (finding 3). `includeTrackedWorktree` is true for `-a`
	 * (index + tracked worktree mods, still NO untracked files), false for a plain
	 * commit (the index only). `constructedPaths` (a NARROW `git add p && git
	 * commit` / `git commit p`) overlays ONLY those paths' worktree state onto the
	 * index — the actual snapshot such a command produces (finding 2026-06: the raw
	 * worktree let an untracked test mask the staged source's missing coverage).
	 * Optional: when absent (or it returns null) the gate falls back to the working
	 * tree. Default: the real `git checkout-index` materializer.
	 */
	materializeIndexSnapshot?: (
		projectRoot: string,
		includeTrackedWorktree?: boolean,
		constructedPaths?: string[],
	) => StagedSnapshot | null;
}

/** The default CRAP cutoff — the McCabe / SonarQube convention (matches the per-edit gate). */
const DEFAULT_CRAP_THRESHOLD = 30;

/**
 * Generous per-run timeout (ms) for the commit-time suite. Commit time is allowed
 * to run the full suite (no per-edit budget), so this is far above the per-edit
 * `DEFAULT_RUN_TIMEOUT_MS` — a large suite must have room to finish.
 */
export const COMMIT_RUN_TIMEOUT_MS = 600_000;

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
	recordDischarge: recordCoverageDischarge,
	resolveRepoRoot: defaultResolveRepoRoot,
	materializeIndexSnapshot,
};

// ===========================================
// Per-source violation detection
// ===========================================

/** Inputs to the per-file violation scan — explicit so it needs no broader ctx. */
interface ScanInput {
	source: ChangedSource;
	cov: PerFileCoverage | undefined;
	content: string;
	analyzer: CyclomaticAnalyzer | null;
	crapThreshold: number;
	/** `per_edit_coverage.block_on_crap` — CRAP violations count only when true
	 *  (finding 2026-06: the commit gate scored CRAP unconditionally, making the
	 *  documented opt-out ineffective at commit time). */
	blockOnCrap: boolean;
}

/**
 * Collect every violation for one changed file: an uncovered executable line, a
 * function over the cyclomatic cap, and a function over the CRAP threshold. The
 * cyclomatic + CRAP checks need the analyzer; when it is unavailable (null) they
 * are skipped for this file (the loud-degrade is logged once by the caller).
 * Coverage checks run whenever the file appears in the report.
 */
function scanFile(input: ScanInput): Violation[] {
	const { source, cov, content, analyzer, crapThreshold, blockOnCrap } = input;
	const violations: Violation[] = [];

	// The cyclomatic + CRAP checks need a per-function analysis. An UNAVAILABLE
	// analyzer (null) or one that returned null (typescript / radon absent, or a
	// parse failure) loud-degrades — exactly like the per-edit gate fail-opens on
	// an unmeasured suite — and those two checks are skipped for this file.
	const complexities = analyzer ? analyzer(content, source.relPath) : null;

	if (cov) {
		const covViolation = coverageViolation(source, cov);
		if (covViolation) violations.push(covViolation);
	} else if (!isTypeOnlySource(content)) {
		// The full suite ran, yet this changed source is ABSENT from the coverage
		// report → no test loaded it → its executable code is UNCOVERED. Block instead
		// of silently skipping (finding 4). The ONLY exemption is a genuinely type-only
		// file (imports / interfaces / type aliases / re-exports): gating on "the
		// analyzer found ≥1 function" let function-less top-level code — `console.log`,
		// an initializing call, an enum — pass untested (finding 2026-06).
		violations.push(missingCoverageViolation(source));
	}

	if (!complexities) {
		loudDegrade(`no cyclomatic analysis for ${source.relPath} — CRAP / cyclomatic checks skipped`);
		return violations;
	}
	const cycViolation = cyclomaticViolation(source, complexities);
	if (cycViolation) violations.push(cycViolation);
	if (cov && blockOnCrap) {
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
	/** Languages the suite runs for — every scanned source's language PLUS every
	 *  gated-language DELETION's language, so a delete-only commit still runs the
	 *  red-bar suite (finding 2026-06: it skipped enforcement entirely). */
	suiteLanguages: CoverageLanguage[];
	crapThreshold: number;
	/** `per_edit_coverage.block_on_test_failure` — a RED suite blocks only when
	 *  true; off, the red bar is surfaced as a warning and the scan proceeds
	 *  (finding 2026-06: the commit gate blocked red unconditionally, making the
	 *  documented opt-out ineffective exactly when per-edit checks defer here). */
	blockOnTestFailure: boolean;
	/** `per_edit_coverage.block_on_crap` — CRAP violations count only when true. */
	blockOnCrap: boolean;
	/** Gated-language paths DELETED by this commit. A clean green pass discharges
	 *  THEIR deferred obligations too: a budget-deferred delete-only edit records
	 *  an obligation for the deleted path, and no future coverage report can ever
	 *  contain a deleted file — without this the Stop warning stayed open forever
	 *  even after the gate verified the deletion (finding 2026-06). */
	deletedPaths: string[];
	warnings: string[];
	/** The REAL repo root (where the obligation ledger lives), session id, and event
	 *  timestamp — used to DISCHARGE deferred coverage obligations on a clean pass so
	 *  the Stop check stops warning "never enforced" (finding 12). Absent ⇒ no discharge. */
	ledgerRoot?: string;
	sessionId?: string;
	eventTs?: string;
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
	// Suite languages come from the SELECTION (scanned sources ∪ deletions), not
	// from `sources` alone — a delete-only commit has no scan sources yet must
	// still run its language's suite (finding 2026-06).
	const languages = ctx.suiteLanguages;
	const perFile = new Map<string, PerFileCoverage>();
	const failingTests: string[] = [];
	let anyRed = false;
	// Dedup by the runner's stable EXECUTION KEY, not by language: the Vitest runner
	// serves both `js` and `ts`, so a commit changing both must run the suite ONCE,
	// not twice against the same report dir (finding 2026-06). Falls back to the
	// language when a runner exposes no id (test stubs).
	const ranKeys = new Set<string>();

	for (const language of languages) {
		const runner = deps.runnerFor(language);
		if (!runner) {
			return { perFile, failingTests, anyRed, degradeReason: `no coverage runner for ${language}` };
		}
		const key = runner.id ?? language;
		if (ranKeys.has(key)) continue;
		ranKeys.add(key);
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
				blockOnCrap: ctx.blockOnCrap,
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
	// Only when opted in (`block_on_test_failure`, the same flag the per-edit gate
	// honors — finding 2026-06: the commit gate blocked red unconditionally). With
	// the flag off the red bar is SURFACED as a warning and the scan proceeds on
	// the red run's coverage — under-reporting can only ADD violations, never hide
	// one — while the clean-pass discharge below is withheld.
	if (outcome.anyRed) {
		if (ctx.blockOnTestFailure) return blockForRedBar(outcome.failingTests, ctx.warnings);
		ctx.warnings.push(
			"[interlinked:commit-gate] NOTE: the full suite is RED " +
				`(${failingTestPhrase(outcome.failingTests)}) but block_on_test_failure is off — ` +
				"not blocking on the red bar.",
		);
	}

	const violations = collectViolations(ctx, outcome.perFile, deps);
	if (violations.length > 0) return blockForViolations(violations, ctx.warnings);

	// CLEAN: the suite RAN (not degraded), came back GREEN, and every gated source
	// PASSED → discharge each source's deferred coverage obligation so the Stop
	// check stops warning "never enforced" (finding 12). Only reached on a measured
	// pass — never a degrade, and never the red-suite-with-flag-off path above
	// (an obligation must not be discharged by a red bar). DELETED paths discharge
	// too: their obligations name files no future coverage report can ever contain,
	// and the green suite IS the verification of the deletion — without this the
	// Stop warning stayed open permanently (finding 2026-06).
	if (!outcome.anyRed && ctx.ledgerRoot && ctx.sessionId && deps.recordDischarge) {
		const ts = ctx.eventTs ?? new Date().toISOString();
		for (const file of [...ctx.sources.map((s) => s.relPath), ...ctx.deletedPaths]) {
			deps.recordDischarge(ctx.ledgerRoot, file, ctx.sessionId, ts);
		}
	}

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

/** Where the gate evaluates the commit, plus an optional snapshot cleanup. */
interface EvalTarget {
	root: string;
	cleanup: (() => void) | null;
}

/**
 * Resolve where the commit gate evaluates the commit (findings 3 & 4):
 *   - `index`    — a plain commit captures the INDEX exactly (no unstaged, no untracked).
 *   - `tracked`  — `-a`/`--all`: index PLUS tracked worktree mods, still no untracked.
 *   - `worktree` — the commit CONSTRUCTS content at run time:
 *       - NARROW (specific constructed paths): the INDEX plus ONLY those paths'
 *         worktree state — the actual would-be snapshot. Evaluating the raw
 *         worktree let unrelated UNTRACKED tests and unstaged edits join the
 *         suite, so an untracked test could cover the staged source and approve
 *         a commit whose real tree stays uncovered (finding 2026-06). (For a
 *         pathspec `--only` commit the index base is a small superset of the
 *         HEAD-based truth — unrelated STAGED content may ride along — accepted:
 *         strictly tighter than the whole worktree.)
 *       - BROAD (`git add -A && git commit`): the raw working tree — a broad add
 *         stages untracked files too, so the worktree IS the would-be snapshot.
 * Fail-safe: if materialization is unavailable or fails, fall back to the working
 * tree — never worse than before the fix.
 */
function resolveEvalTarget(
	projectRoot: string,
	mode: EvalMode,
	deps: CommitGateDeps,
	constructedPaths?: string[] | null,
): EvalTarget {
	if (mode === "worktree") {
		if (constructedPaths && constructedPaths.length > 0) {
			const snap = deps.materializeIndexSnapshot?.(projectRoot, false, constructedPaths) ?? null;
			if (snap) return { root: snap.root, cleanup: snap.cleanup };
		}
		return { root: projectRoot, cleanup: null };
	}
	const snap = deps.materializeIndexSnapshot?.(projectRoot, mode === "tracked") ?? null;
	return snap ? { root: snap.root, cleanup: snap.cleanup } : { root: projectRoot, cleanup: null };
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
	// Gate 1: feature OFF, or mode is not "block" → pure no-op. `mode: "warn"` is
	// the documented loaded-but-non-blocking setting (see PerEditCoverageConfig) and
	// the per-edit guard already honors it — the commit gate checking only `enabled`
	// made the opt-out ineffective at commit time and unconditionally blocked
	// (finding 2026-06). Same contract on both enforcement surfaces.
	const cfg = rules.per_edit_coverage;
	if (!cfg?.enabled || cfg.mode !== "block") return null;

	const command = (event.tool_input?.command as string) || "";
	const parse = parseGitCommit(command);
	if (!parse?.isCommit) return null;

	// `--no-verify` is a bypass of git's hooks (not this gate). Note it so the
	// attempt is visible whether we end up blocking or allowing.
	const warnings = noVerifyWarnings(parse.noVerify);

	try {
		// Honor a `cd <dir>` / `git -C <dir>` redirect (finding 4): evaluate the
		// repository the commit actually runs in, not the shell's parent cwd. In a
		// monorepo `cd packages/x && git commit` must gate packages/x, not the root.
		const baseCwd = event.cwd || process.cwd();
		const commandCwd = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
		// Anchor at the git TOPLEVEL: git emits toplevel-relative changed paths, so a
		// commit run from an ordinary subdirectory (`cd src && git commit -a`) would
		// otherwise resolve `src/a.ts` against `/repo/src` → `/repo/src/src/a.ts` and
		// silently skip every changed source (finding 2026-06). Fail-open to the
		// command's own cwd when the toplevel can't be resolved.
		const projectRoot = deps.resolveRepoRoot?.(commandCwd) ?? commandCwd;
		// How to model the commit (findings 3 & 4): a commit that constructs content
		// at run time (preceding `git add`, or a pathspec) → the WORKTREE (the index is
		// stale pre-execution); `-a` → tracked snapshot; a plain commit → the INDEX.
		const mode: EvalMode = parse.constructsContent ? "worktree" : parse.all === true ? "tracked" : "index";
		// Changed files: staged-only ONLY for the plain index commit; the broader
		// worktree query for `-a` / constructed commits — and untracked files ONLY for
		// CONSTRUCTED commits, whose `git add` stages new files at run time (finding
		// 2026-06: `git diff` never lists untracked, so a brand-new source bypassed).
		const allChanged = deps.gitChangedFiles(projectRoot, mode === "index", mode === "worktree");
		if (allChanged === null) {
			return degradeWithWarnings("git diff unavailable — cannot determine changed files", warnings);
		}
		// A NARROW constructed-content commit (`git commit src/a.ts`, `git add src/a.ts
		// && git commit`) stages only specific paths — evaluate ONLY those, so an
		// UNRELATED dirty worktree file does not block the commit (finding 2026-06: the
		// round-3 worktree-everything approach over-blocked, breaking the zero-FP
		// contract) — UNIONED with the staged set when the commit also captures the
		// pre-existing index (`includesIndex` — finding 2026-06: staged files bypassed).
		// The specs are parsed relative to the COMMAND's directory while git's changed
		// paths are TOPLEVEL-relative — rebase first; an unrebasable spec degrades to
		// broad (finding 2026-06: `cd packages/app && git add src/a.ts && git commit`
		// filtered toplevel paths against the raw spec and the staged file bypassed).
		const constructed = parse.constructedPaths
			? rebaseConstructedPaths(parse.constructedPaths, commandCwd, projectRoot)
			: undefined;
		const changed = changedSetForCommit(
			allChanged,
			{
				...(constructed ? { constructedPaths: constructed } : {}),
				...(parse.includesIndex ? { includesIndex: true } : {}),
			},
			mode,
			() => deps.gitChangedFiles(projectRoot, true),
		);

		// A NARROW constructed commit evaluates the INDEX + its own staged paths,
		// not the raw worktree (finding 2026-06: an untracked test could cover the
		// staged source and approve a commit whose actual snapshot is uncovered).
		const target = resolveEvalTarget(projectRoot, mode, deps, constructed);
		try {
			const selected = selectChangedSources(changed, target.root, cfg.languages, deps.readFile);
			const { sources, deletedPaths, suiteLanguages } = selected;
			// Nothing gated changed at all (docs / config / declaration-only) → allow,
			// but still surface the --no-verify note if present. Test-only and
			// generated-only changes DO proceed: their language is in suiteLanguages
			// even though there is nothing to scan, because a failing test edit must
			// not be committed (finding 2026-06: it skipped the suite entirely) —
			// the same red-bar-only treatment delete-only commits already get.
			if (sources.length === 0 && suiteLanguages.length === 0) {
				return warnings.length > 0 ? { decision: "allow", warnings } : null;
			}
			// A red-bar-ONLY run (tests / generated / deletions, nothing scannable)
			// has exactly one decidable axis; with `block_on_test_failure` off no
			// block is possible, so no suite is spent (mirrors the per-edit
			// delete-only path's "no decidable axis" skip).
			if (sources.length === 0 && cfg.block_on_test_failure !== true) {
				return warnings.length > 0 ? { decision: "allow", warnings } : null;
			}

			return await runSuiteAndScan(
				{
					projectRoot: target.root,
					sources,
					suiteLanguages,
					crapThreshold: cfg.crap_threshold ?? DEFAULT_CRAP_THRESHOLD,
					blockOnTestFailure: cfg.block_on_test_failure === true,
					blockOnCrap: cfg.block_on_crap === true,
					deletedPaths,
					warnings,
					// Discharge obligations against the REAL repo root (where the ledger
					// lives), not the snapshot, on a clean pass (finding 12).
					ledgerRoot: projectRoot,
					sessionId: event.session_id,
					...(event.timestamp ? { eventTs: event.timestamp } : {}),
				},
				deps,
			);
		} finally {
			target.cleanup?.();
		}
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return degradeWithWarnings(why, warnings);
	}
}
