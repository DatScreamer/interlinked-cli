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
//   1. CONFIG-GATED (DEFAULT ON — see `rules/default-config.ts`). Runs only when
//      `rules.per_edit_coverage.enabled` is true. A repo that opts OUT returns at
//      the first gate before any git shell-out or suite run — zero cost. On a big
//      suite (THIS repo) the per-edit overlay defers to THIS commit gate, so it is
//      the LIVE enforcement surface here, not a dormant one.
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
import { isCappableFile } from "../large-file-policy.js";
import {
	type ChangedSource,
	coverageViolation,
	crapViolation,
	cyclomaticViolation,
	isTypeOnlySource,
	missingCoverageViolation,
	type Violation,
} from "./commit-gate-scan.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { parseGitCommit } from "./commit-parse.js";
import { materializeIndexSnapshot, type StagedSnapshot } from "./staged-snapshot.js";

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
 * List the repo-relative POSIX paths of source files changed for the commit about
 * to run. `stagedOnly` (a plain `git commit`) returns ONLY the staged set — the
 * exact files the commit captures; otherwise (`-a`/`--all`) it returns the working
 * tree's tracked changes too. Returns `null` when the diff could not be taken (git
 * missing, not a repo) — the gate fail-opens on `null`.
 */
export type GitChangedFilesFn = (
	projectRoot: string,
	stagedOnly?: boolean,
	includeUntracked?: boolean,
) => string[] | null;

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
	 * commit (the index only). Optional: when absent (or it returns null) the gate
	 * falls back to the working tree. Default: the real `git checkout-index` materializer.
	 */
	materializeIndexSnapshot?: (projectRoot: string, includeTrackedWorktree?: boolean) => StagedSnapshot | null;
}

/** The default CRAP cutoff — the McCabe / SonarQube convention (matches the per-edit gate). */
const DEFAULT_CRAP_THRESHOLD = 30;

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
 * The real changed-files function. `stagedOnly` (a plain `git commit`) returns
 * just `git diff --cached --name-only` — the staged set the commit will capture.
 * Otherwise (`-a`/`--all`, which stages tracked edits first) it UNIONs `git diff
 * --name-only HEAD` (working tree vs HEAD) with the staged set. `includeUntracked`
 * (CONSTRUCTED commits only — `git add … && git commit`) additionally unions
 * `git ls-files --others --exclude-standard`: the add stages NEW files at run time,
 * while `git diff` never lists them, so without this a brand-new uncovered source
 * sailed through the gate (finding 2026-06). Plain `-a` never stages untracked
 * files, so `tracked` mode keeps them excluded. Read-only. Returns `null` only when
 * every needed git invocation fails so the gate fail-opens rather than blocking
 * when git can't answer at all.
 */
export function defaultGitChangedFiles(
	projectRoot: string,
	stagedOnly = false,
	includeUntracked = false,
): string[] | null {
	const staged = gitLines(projectRoot, ["diff", "--cached", "--name-only"]);
	if (stagedOnly) return staged; // a plain commit captures the index only
	const worktree = gitLines(projectRoot, ["diff", "--name-only", "HEAD"]);
	const untracked = includeUntracked
		? gitLines(projectRoot, ["ls-files", "--others", "--exclude-standard"])
		: [];
	if (worktree === null && staged === null && untracked === null) return null; // git unusable
	return [...new Set<string>([...(worktree ?? []), ...(staged ?? []), ...(untracked ?? [])])];
}

/**
 * The git repository TOPLEVEL for a directory (`git rev-parse --show-toplevel`),
 * or null when not a repo / git fails. Git emits changed-file paths relative to the
 * TOPLEVEL, so the gate must anchor there: evaluating from a subdirectory
 * (`cd src && git commit -a`) would otherwise resolve `src/a.ts` against
 * `/repo/src` → `/repo/src/src/a.ts` and silently skip every changed source
 * (finding 2026-06).
 */
export function defaultResolveRepoRoot(dir: string): string | null {
	const lines = gitLines(dir, ["rev-parse", "--show-toplevel"]);
	return lines !== null && lines.length > 0 ? (lines[0] ?? null) : null;
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

/** Inputs to the per-file violation scan — explicit so it needs no broader ctx. */
interface ScanInput {
	source: ChangedSource;
	cov: PerFileCoverage | undefined;
	content: string;
	analyzer: CyclomaticAnalyzer | null;
	crapThreshold: number;
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
	const languages = [...new Set(ctx.sources.map((s) => s.language))];
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

	// CLEAN: the suite RAN (not degraded) and every gated source PASSED → discharge
	// each source's deferred coverage obligation so the Stop check stops warning
	// "never enforced" (finding 12). Only reached on a measured pass, never a degrade.
	if (ctx.ledgerRoot && ctx.sessionId && deps.recordDischarge) {
		const ts = ctx.eventTs ?? new Date().toISOString();
		for (const source of ctx.sources) {
			deps.recordDischarge(ctx.ledgerRoot, source.relPath, ctx.sessionId, ts);
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

/** How the gate models the commit's would-be tree. */
type EvalMode = "index" | "tracked" | "worktree";

/**
 * Resolve where the commit gate evaluates the commit (findings 3 & 4):
 *   - `index`    — a plain commit captures the INDEX exactly (no unstaged, no untracked).
 *   - `tracked`  — `-a`/`--all`: index PLUS tracked worktree mods, still no untracked.
 *   - `worktree` — the commit CONSTRUCTS content at run time (a preceding `git add`,
 *                  or a pathspec): the index is stale at PreToolUse, so evaluate the
 *                  raw working tree — the inclusive superset of what will be staged,
 *                  so content is never left UNevaluated (never a false-allow).
 * Fail-safe: if materialization is unavailable or fails, fall back to the working
 * tree — never worse than before the fix.
 */
function resolveEvalTarget(projectRoot: string, mode: EvalMode, deps: CommitGateDeps): EvalTarget {
	if (mode === "worktree") return { root: projectRoot, cleanup: null };
	const snap = deps.materializeIndexSnapshot?.(projectRoot, mode === "tracked") ?? null;
	return snap ? { root: snap.root, cleanup: snap.cleanup } : { root: projectRoot, cleanup: null };
}

/**
 * Restrict changed files to those a NARROW constructed-content commit actually stages
 * — an exact pathspec, or a file under a named directory pathspec. Repo-relative on
 * both sides (the pathspecs resolve against the same projectRoot as the changed-files
 * query). This is what keeps an unrelated dirty file from blocking the commit.
 */
function filterToConstructedPaths(files: string[], specs: string[]): string[] {
	const norms = specs.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, ""));
	return files.filter((f) => norms.some((p) => f === p || f.startsWith(`${p}/`)));
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
		// round-3 worktree-everything approach over-blocked, breaking the zero-FP contract).
		const changed =
			mode === "worktree" && parse.constructedPaths
				? filterToConstructedPaths(allChanged, parse.constructedPaths)
				: allChanged;

		const target = resolveEvalTarget(projectRoot, mode, deps);
		try {
			const sources = selectChangedSources(changed, target.root, cfg.languages, deps.readFile);
			// Nothing gated changed (only tests / docs / config) → allow, but still
			// surface the --no-verify note if present.
			if (sources.length === 0) return warnings.length > 0 ? { decision: "allow", warnings } : null;

			return await runSuiteAndScan(
				{
					projectRoot: target.root,
					sources,
					crapThreshold: cfg.crap_threshold ?? DEFAULT_CRAP_THRESHOLD,
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
