// ===========================================
// Verify Command — deterministic codebase verification
// ===========================================
// Runs tsc + biome on a project and reports errors. Optionally runs scored
// regex suggestions (--suggestions). Respects interlinked-ignore comments.
//
// Usage:
//   interlinked verify                     # tsc + biome on current project
//   interlinked verify --suggestions       # + scored regex heuristics
//   interlinked verify --json              # Machine-readable output
//   interlinked verify --details           # Show file paths for all findings
//   interlinked verify --file foo.ts       # Single file
//   interlinked verify --changed           # Changed files only
//   interlinked verify --staged            # Staged files only
//   interlinked verify https://github.com/owner/repo  # Remote repo
//
// Implementation is split across `src/commands/verify/`:
//   - advisory.ts          — DEFAULT_ADVISORY_SKIPS, TOOL_IDS, skip-set helpers
//   - clone-repo.ts        — git URL detection + `git clone`
//   - file-discovery.ts    — CODE_EXTENSIONS + discoverFiles
//   - suppressions.ts      — inline suppression-comment detection
//   - tool-results-types.ts — shared type definitions
//   - tool-results.ts      — runCodeQualityChecks + runSuggestions
//   - output-json.ts       — JSON batch output
//   - section-table.ts     — declarative list of streaming sections
//   - streaming-output.ts  — human-readable streaming output
//   - structure.ts         — structure verification (graph, rules, adoption)

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CheckEngine, type CheckResult, formatToolReport } from "../harness/check-engine/index.js";
import type { Finding } from "../harness/suggestion-scorer.js";
import {
	type RegistryDriftFinding,
	runRegistryParityCheck,
} from "../harness/registry-parity.js";
import {
	addSuppressions,
	loadFileSuppressions,
	loadSuppressionFile,
	parseSuppressionEntry,
} from "../harness/suppressions.js";

import {
	DEFAULT_ADVISORY_SKIPS,
	getEffectiveSkipChecks,
	getSkipTools,
	TOOL_IDS,
} from "./verify/advisory.js";
import { cloneRepo, isGitUrl, normalizeGitUrl, repoDisplayName } from "./verify/clone-repo.js";
import { discoverFiles } from "./verify/file-discovery.js";
import { outputJson } from "./verify/output-json.js";
import {
	runToolSilent,
	runToolWithSpinner,
	SPINNER_FRAMES,
	setActiveSkipChecks,
	streamAllCqSections,
} from "./verify/streaming-output.js";
import { buildStructureJsonSection, runStructureVerify } from "./verify/structure.js";
import {
	checkProjectSetup,
	filterCodeQualityResults,
	runCodeQualityChecks,
	runSuggestions,
} from "./verify/tool-results.js";

// Re-export for consumers (tests + external scripts that imported these
// names historically from this file). These names are load-bearing — the
// `__tests__/verify.test.ts` regression pin imports `DEFAULT_ADVISORY_SKIPS`
// directly from here.
export { DEFAULT_ADVISORY_SKIPS } from "./verify/advisory.js";
export { cloneRepo, isGitUrl, normalizeGitUrl, repoDisplayName } from "./verify/clone-repo.js";
export { CODE_EXTENSIONS, discoverFiles } from "./verify/file-discovery.js";

interface ToolSpec {
	id: import("../harness/check-engine/types.js").ToolId;
	label: string;
	passLabel: string;
	noun: string;
	severity: string;
	cmd: string[];
}

const TOOLS_TO_RUN: readonly ToolSpec[] = [
	{
		id: "oxlint",
		label: "oxlint",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "oxlint", "--format=json", "."],
	},
	{
		id: "gitleaks",
		label: "gitleaks (secrets)",
		passLabel: "no secrets detected",
		noun: "secrets",
		severity: "31",
		cmd: [
			"gitleaks",
			"detect",
			"--no-git",
			"--no-banner",
			"--report-format",
			"json",
			"--report-path",
			"/dev/stdout",
			"--source",
			".",
		],
	},
	{
		id: "biome",
		label: "biome",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: [
			"npx",
			"--yes",
			"--package",
			"@biomejs/biome",
			"biome",
			"check",
			"--no-errors-on-unmatched",
			".",
		],
	},
	{
		id: "eslint",
		label: "eslint",
		passLabel: "no issues",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "eslint", "--no-error-on-unmatched-pattern", "--format", "unix", "."],
	},
	{
		id: "tsc",
		label: "typescript",
		passLabel: "no errors",
		noun: "errors",
		severity: "31",
		cmd: ["npx", "tsc", "--noEmit", "--pretty", "false"],
	},
	{
		id: "semgrep",
		label: "semgrep (SAST)",
		passLabel: "no findings",
		noun: "findings",
		severity: "31",
		cmd: [
			"semgrep",
			"scan",
			"--quiet",
			"--no-git-ignore",
			"--metrics",
			"off",
			"--config",
			"p/default",
			"--json",
			".",
		],
	},
	{
		id: "knip",
		label: "knip (dead code)",
		passLabel: "no unused exports or files",
		noun: "issues",
		severity: "33",
		cmd: ["npx", "knip", "--no-progress", "--reporter", "json"],
	},
];

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_DEP_AUDIT_TIMEOUT_MS = 30_000;
const SPINNER_FRAME_MS = 80;
const MAX_LISTED_FILES = 20;
const MAX_FILE_DETAIL_LINES = 5;
const MESSAGE_MAX_LENGTH = 120;
const CHECK_ENGINE_TIMEOUT_MS = 30_000;
const SUGGESTIONS_LIMIT = 3;
const SUGGESTIONS_THRESHOLD = 0.5;
const MAX_ENV_FILES = 10;

// Some checks report project-wide findings that aren't tied to any real file.
// They go into `allFlaggedFiles` under a synthetic token so the per-check
// section still renders, but they must not inflate the "X / Y files flagged"
// ratio (numerator > denominator was the visible symptom). Extend this set if
// another check introduces a new sentinel.
const SYNTHETIC_FILE_TOKENS = new Set<string>(["<project>"]);

/** Normalize a flagged-file entry to a path relative to `cwd`. Leaves synthetic
 *  tokens unchanged so callers can filter them out by identity. */
function normalizeFlaggedPath(cwd: string, p: string): string {
	if (SYNTHETIC_FILE_TOKENS.has(p)) return p;
	return isAbsolute(p) ? relative(cwd, p) : p;
}

/** Pure helper for the tail summary line. Exported for unit tests.
 *
 *  Inputs:
 *    - `cwd`           — the project root the scan ran against.
 *    - `files`         — paths from `discoverFiles()` (absolute; `.ts`/`.py`/… only).
 *    - `flagged`       — raw entries that accumulated in `allFlaggedFiles`;
 *                        a mix of absolute/relative/sentinel strings produced
 *                        by various checks.
 *
 *  Output:
 *    - `flaggedFiles`    — count of real files with at least one finding.
 *    - `totalFiles`      — size of the universe the numerator is taken against.
 *                          Equals |discovered ∪ real-flagged| so config files
 *                          that only external tools care about (e.g.
 *                          `tsconfig.json`) count on both sides.
 *    - `projectFindings` — count of non-file, project-wide findings (e.g. the
 *                          prod/test LOC ratio). Reported separately.
 */
export function summarizeFlaggedFiles(
	cwd: string,
	files: readonly string[],
	flagged: Iterable<string>,
): { flaggedFiles: number; totalFiles: number; projectFindings: number } {
	const discovered = new Set(files.map((f) => normalizeFlaggedPath(cwd, f)));
	const flaggedReal = new Set<string>();
	let projectFindings = 0;
	for (const p of flagged) {
		if (SYNTHETIC_FILE_TOKENS.has(p)) {
			projectFindings++;
			continue;
		}
		flaggedReal.add(normalizeFlaggedPath(cwd, p));
	}
	const universe = new Set<string>([...discovered, ...flaggedReal]);
	return {
		flaggedFiles: flaggedReal.size,
		totalFiles: universe.size,
		projectFindings,
	};
}

interface VerifyOpts {
	target?: string;
	file?: string;
	changed?: boolean;
	staged?: boolean;
	cwd?: string;
	only?: string;
	json?: boolean;
	details?: boolean;
	suggestions?: boolean;
	branch?: string;
	subdir?: string;
	suppress?: string[];
	showSuppressions?: boolean;
	structure?: boolean;
	structureOnly?: boolean;
	adoptionGate?: boolean;
	allChecks?: boolean;
	skip?: string;
}

/**
 * Public API — consumed by `src/index.ts` and tests.
 *
 * Top-level entry point dispatched from `interlinked verify`. Handles
 * suppression-management subflags, remote-repo cloning, and local-path
 * scanning. Actual checks live in `runVerify`.
 */
export async function verifyCommand(opts: VerifyOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const interlinkedDir = join(cwd, ".interlinked");

	if (opts.showSuppressions) {
		displaySuppressions(interlinkedDir);
		return;
	}

	if (opts.suppress && opts.suppress.length > 0) {
		const ok = applySuppressions(opts.suppress, interlinkedDir);
		if (!ok) return;
		// Continue to run verify so user sees updated results
	}

	if (opts.structureOnly) {
		await runStructureVerify(opts.cwd || process.cwd(), opts);
		return;
	}

	if (opts.target && isGitUrl(opts.target)) {
		await runRemoteVerify(opts.target, opts);
		return;
	}

	if (opts.target) {
		const targetPath = isAbsolute(opts.target)
			? opts.target
			: resolve(opts.cwd || process.cwd(), opts.target);
		if (!existsSync(targetPath)) {
			process.stderr.write(
				`Target not found: ${opts.target}\n` +
					"  For remote repos, use a full URL: interlinked verify https://github.com/owner/repo\n",
			);
			process.exitCode = 1;
			return;
		}
		const stat = statSync(targetPath);
		if (stat.isDirectory()) {
			await runVerify(targetPath, opts);
		} else {
			process.stderr.write(`Target is not a directory: ${opts.target}\n`);
			process.exitCode = 1;
		}
		return;
	}

	await runVerify(cwd, opts);
}

function displaySuppressions(interlinkedDir: string): void {
	const data = loadSuppressionFile(interlinkedDir);
	const entries = Object.entries(data);
	if (entries.length === 0) {
		process.stderr.write("\n  No suppressions configured.\n");
		process.stderr.write("  Add one with: interlinked verify --suppress file:check\n\n");
		return;
	}
	process.stderr.write(
		"\n  \x1b[1mActive suppressions\x1b[0m (.interlinked/verify-suppressions.json)\n\n",
	);
	for (const [filePath, checks] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		process.stderr.write(`  \x1b[36m${filePath}\x1b[0m\n`);
		for (const [checkName, entry] of Object.entries(checks).sort((a, b) =>
			a[0].localeCompare(b[0]),
		)) {
			const reason = entry.reason ? ` \x1b[2m— ${entry.reason}\x1b[0m` : "";
			process.stderr.write(`    ${checkName}${reason}\n`);
		}
	}
	process.stderr.write("\n");
}

function applySuppressions(suppress: string[], interlinkedDir: string): boolean {
	const parsed: Array<{ file: string; check: string; reason: string }> = [];
	for (const entry of suppress) {
		const result = parseSuppressionEntry(entry);
		if (!result) {
			process.stderr.write(
				`  \x1b[31merror\x1b[0m: invalid suppression format: "${entry}"\n` +
					"  Expected: file:check or file:check:reason\n",
			);
			process.exitCode = 1;
			return false;
		}
		parsed.push(result);
	}

	let added: ReturnType<typeof addSuppressions>;
	try {
		added = addSuppressions(interlinkedDir, parsed);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`\n  \x1b[31mSuppression rejected:\x1b[0m ${msg}\n` +
				"  Edit .interlinked/verify-suppressions.json directly to add the required `ticket` or `expires_at` fields.\n\n",
		);
		process.exitCode = 1;
		return false;
	}
	if (added.length > 0) {
		process.stderr.write("\n  \x1b[32mSuppressions added:\x1b[0m\n");
		for (const entry of added) {
			const reason = entry.reason ? ` \x1b[2m— ${entry.reason}\x1b[0m` : "";
			process.stderr.write(`    ${entry.file}:${entry.check}${reason}\n`);
		}
		process.stderr.write("\n  Written to .interlinked/verify-suppressions.json\n");
	} else {
		process.stderr.write("\n  All entries already suppressed.\n");
	}
	process.stderr.write("\n");
	return true;
}

async function runRemoteVerify(target: string, opts: VerifyOpts): Promise<void> {
	const url = normalizeGitUrl(target);
	if (!opts.json) process.stderr.write(`\n  cloning ${repoDisplayName(url)}...\n`);

	let cloneResult: { dir: string; elapsed_ms: number };
	try {
		cloneResult = cloneRepo(url, { branch: opts.branch });
	} catch (err: unknown) {
		process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
		return;
	}

	if (!opts.json) {
		process.stderr.write(`  cloned in ${(cloneResult.elapsed_ms / 1000).toFixed(1)}s\n`);
	}
	const scanDir = opts.subdir ? join(cloneResult.dir, opts.subdir) : cloneResult.dir;

	try {
		await runVerify(scanDir, opts);
	} finally {
		rmSync(cloneResult.dir, { recursive: true, force: true });
	}
}

async function runVerify(cwd: string, opts: VerifyOpts): Promise<void> {
	const files = discoverFiles(cwd);
	const engine = new CheckEngine(cwd);
	const details = opts.details ?? false;
	const skipChecks = getEffectiveSkipChecks(opts.skip, opts.allChecks);
	setActiveSkipChecks(skipChecks);
	const scope = { projectRoot: cwd, mode: "project" as const };

	if (opts.json) {
		await runVerifyBatchJson(engine, files, cwd, opts, scope);
		return;
	}

	process.stderr.write(`\n  ${formatToolReport(engine.discoverTools())}\n`);
	process.stderr.write(`\n  \x1b[1minterlinked verify\x1b[0m · ${files.length} files\n`);

	const summary: Array<{ label: string; count: number; color: string }> = [];
	const allFlaggedFiles = new Set<string>();

	streamProjectSetup(cwd, allFlaggedFiles);
	streamRegistryParity(cwd, allFlaggedFiles);

	const cqStart = Date.now();
	process.stderr.write("  \x1b[2mscanning files...\x1b[0m");
	const cq = filterCodeQualityResults(runCodeQualityChecks(files, cwd), skipChecks);
	const cqElapsed = ((Date.now() - cqStart) / 1000).toFixed(1);
	process.stderr.write("\r\x1b[K");

	streamAllCqSections(cq, details, allFlaggedFiles);
	streamUndocumentedEnvVars(cq.undocumentedEnvVars, allFlaggedFiles);

	process.stderr.write(`\x1b[2m  code quality checks completed in ${cqElapsed}s\x1b[0m\n`);

	await streamExternalTools({
		engine,
		cwd,
		opts,
		skipChecks,
		summary,
		allFlaggedFiles,
		details,
	});

	if (opts.suggestions) {
		streamSuggestionsSummary(files, cwd);
	}

	if (opts.structure) {
		await runStructureVerify(cwd, opts);
	}

	const tally = summarizeFlaggedFiles(cwd, files, allFlaggedFiles);
	process.stderr.write(`\n  ${tally.flaggedFiles} / ${tally.totalFiles} files flagged`);
	if (tally.projectFindings > 0) {
		const noun =
			tally.projectFindings === 1 ? "project-level finding" : "project-level findings";
		process.stderr.write(` · \x1b[33m${tally.projectFindings} ${noun}\x1b[0m`);
	}
	if (summary.length > 0) {
		process.stderr.write(
			` · ${summary.map((s) => `\x1b[${s.color}m${s.label}\x1b[0m`).join(" · ")}`,
		);
	}
	process.stderr.write("\n\n");

	emitVerifyRun(cwd, {
		mode: opts.allChecks ? "all-checks" : "default",
		files_scanned: files.length,
		flagged_files: tally.flaggedFiles,
		project_findings: tally.projectFindings,
		summary,
		duration_ms: Date.now() - cqStart,
	});
}

// Emit a row into .interlinked/verify-runs.jsonl so successive verify
// invocations build a longitudinal record of error counts. Used to
// bisect when regressions entered the codebase without re-running tools.
function emitVerifyRun(
	cwd: string,
	data: {
		mode: string;
		files_scanned: number;
		flagged_files: number;
		project_findings: number;
		summary: Array<{ label: string; count: number; color: string }>;
		duration_ms: number;
	},
): void {
	try {
		const path = join(cwd, ".interlinked", "verify-runs.jsonl");
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const branch = safeGitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		const head = safeGitOutput(["rev-parse", "HEAD"], cwd);
		const dirty = safeGitOutput(["status", "--porcelain"], cwd) ? true : false;
		const record = {
			ts: new Date().toISOString(),
			cwd,
			branch: branch || null,
			head: head || null,
			dirty,
			mode: data.mode,
			files_scanned: data.files_scanned,
			flagged_files: data.flagged_files,
			project_findings: data.project_findings,
			counts: data.summary.map((s) => ({ label: s.label, count: s.count })),
			duration_ms: data.duration_ms,
			exit_code: process.exitCode || 0,
		};
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch (_err) {
		/* intentional: verify-runs is best-effort observability */
	}
}

function safeGitOutput(args: string[], cwd: string): string {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
		return out.trim();
	} catch (_err) {
		return "";
	}
}

function streamProjectSetup(cwd: string, allFlaggedFiles: Set<string>): void {
	const setupIssues = checkProjectSetup(cwd);
	process.stderr.write("\n  \x1b[1mproject setup\x1b[0m\n");
	if (setupIssues.length === 0) {
		process.stderr.write("    \x1b[32m✓\x1b[0m configuration valid\n");
		return;
	}
	for (const issue of setupIssues) {
		process.stderr.write(`    \x1b[31m✗\x1b[0m ${issue.message}\n`);
		process.stderr.write(`\x1b[2m         fix: ${issue.fix}\x1b[0m\n`);
		allFlaggedFiles.add(issue.file);
	}
}

function streamRegistryParity(cwd: string, allFlaggedFiles: Set<string>): void {
	let findings: RegistryDriftFinding[];
	try {
		findings = runRegistryParityCheck(cwd);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write("\n  \x1b[1mregistry parity\x1b[0m\n");
		process.stderr.write(`    \x1b[31m✗\x1b[0m config error: ${msg}\n`);
		return;
	}
	if (findings.length === 0) return;
	process.stderr.write("\n  \x1b[1mregistry parity\x1b[0m\n");
	for (const f of findings) {
		process.stderr.write(`    \x1b[31m✗\x1b[0m ${f.message}\n`);
		allFlaggedFiles.add(f.source_file);
	}
}

function streamUndocumentedEnvVars(
	undocumentedEnvVars: Array<{ file: string; message: string }>,
	allFlaggedFiles: Set<string>,
): void {
	process.stderr.write("\n  \x1b[1menv/config integrity\x1b[0m\n");
	if (undocumentedEnvVars.length === 0) {
		process.stderr.write("    \x1b[32m✓\x1b[0m all env vars documented\n");
		return;
	}
	const envNames = new Set(
		undocumentedEnvVars.map((r) => {
			const m = r.message.match(/"([^"]+)"/);
			return m ? m[1] : "";
		}),
	);
	const envFiles = new Set(undocumentedEnvVars.map((r) => r.file));
	for (const f of envFiles) allFlaggedFiles.add(f);
	process.stderr.write(
		`    \x1b[33m!\x1b[0m \x1b[33m${envNames.size}\x1b[0m undocumented env vars in \x1b[33m${envFiles.size}\x1b[0m files\n`,
	);
	for (const file of [...envFiles].sort().slice(0, MAX_ENV_FILES)) {
		process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
	}
	if (envFiles.size > MAX_ENV_FILES) {
		process.stderr.write(
			`\x1b[2m         ... and ${envFiles.size - MAX_ENV_FILES} more files\x1b[0m\n`,
		);
	}
}

function streamSuggestionsSummary(files: string[], cwd: string): void {
	process.stderr.write("  \x1b[2mscoring suggestions...\x1b[0m");
	const suggestions = runSuggestions({
		files,
		cwd,
		limit: SUGGESTIONS_LIMIT,
		threshold: SUGGESTIONS_THRESHOLD,
	});
	process.stderr.write("\r\x1b[K");
	if (suggestions.size === 0) {
		process.stderr.write("\n  \x1b[1msuggestions\x1b[0m\n");
		process.stderr.write("    \x1b[32m✓\x1b[0m no suggestions\n");
		return;
	}
	let total = 0;
	for (const f of suggestions.values()) total += f.length;
	process.stderr.write("\n  \x1b[1msuggestions\x1b[0m (scored heuristics)\n");
	process.stderr.write(
		`    \x1b[36m·\x1b[0m \x1b[36m${total}\x1b[0m suggestions in \x1b[36m${suggestions.size}\x1b[0m files\n`,
	);
	for (const [file] of [...suggestions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
	}
}

type AuditResult = import("../harness/check-engine/types.js").AuditResult;

interface StreamExternalToolsArgs {
	engine: CheckEngine;
	cwd: string;
	opts: VerifyOpts;
	skipChecks: Set<string>;
	summary: Array<{ label: string; count: number; color: string }>;
	allFlaggedFiles: Set<string>;
	details: boolean;
}

async function streamExternalTools(args: StreamExternalToolsArgs): Promise<void> {
	const { engine, cwd, opts, skipChecks, summary, allFlaggedFiles, details } = args;
	const {
		parseTscOutput,
		parseBiomeOutput,
		parseEslintOutput,
		parseKnipJson,
		parseSemgrepJson,
		parseGitleaksJson,
		parseOxlintJson,
		parseNpmAuditJson,
	} = await import("../harness/check-engine/output-parsers.js");

	const toolParsers: Record<string, (output: string) => CheckResult[]> = {
		tsc: (out) => parseTscOutput(out),
		biome: (out) => parseBiomeOutput(out),
		eslint: (out) => parseEslintOutput(out),
		oxlint: (out) => parseOxlintJson(out),
		knip: (out) => parseKnipJson(out),
		semgrep: (out) => parseSemgrepJson(out, cwd),
		gitleaks: (out) => parseGitleaksJson(out),
	};

	const availableTools = TOOLS_TO_RUN.filter((tool) => {
		if (opts.only && opts.only !== tool.id && opts.only !== tool.label) return false;
		if (skipChecks.has(tool.id)) return false;
		const avail = engine.discoverTools().find((t) => t.id === tool.id);
		return avail?.available;
	});

	const runDepAudit =
		(!opts.only || opts.only === "sca") &&
		!skipChecks.has("sca") &&
		!skipChecks.has("dep-audit");
	const interlinkedDir = join(cwd, ".interlinked");
	const parallelStart = Date.now();
	const toolCount = availableTools.length + (runDepAudit ? 1 : 0);

	function displayToolResult(
		tool: ToolSpec,
		rawResults: { items: CheckResult[]; elapsedMs: string },
	): void {
		const filteredItems = rawResults.items.filter((item) => {
			const fileSup = loadFileSuppressions(interlinkedDir, item.file);
			return !fileSup.has(tool.id);
		});
		const elapsed = rawResults.elapsedMs;

		if (filteredItems.length === 0) {
			process.stderr.write(`\n  \x1b[1m${tool.label}\x1b[0m \x1b[2m${elapsed}\x1b[0m\n`);
			process.stderr.write(`    \x1b[32m✓\x1b[0m ${tool.passLabel}\n`);
			return;
		}
		const toolFiles = new Set(filteredItems.map((r) => r.file));
		for (const f of toolFiles) allFlaggedFiles.add(f);
		process.stderr.write(`\n  \x1b[1m${tool.label}\x1b[0m \x1b[2m${elapsed}\x1b[0m\n`);
		process.stderr.write(
			`    \x1b[${tool.severity}m✗\x1b[0m \x1b[${tool.severity}m${filteredItems.length}\x1b[0m ${tool.noun} in \x1b[${tool.severity}m${toolFiles.size}\x1b[0m files\n`,
		);
		summary.push({
			label: `${filteredItems.length} ${tool.label} ${tool.noun}`,
			count: filteredItems.length,
			color: tool.severity,
		});
		for (const file of [...toolFiles].sort().slice(0, MAX_LISTED_FILES)) {
			process.stderr.write(`\x1b[2m         ${file}\x1b[0m\n`);
			if (details) {
				for (const r of filteredItems
					.filter((r) => r.file === file)
					.slice(0, MAX_FILE_DETAIL_LINES)) {
					process.stderr.write(
						`\x1b[2m           L${r.line}: ${r.message.slice(0, MESSAGE_MAX_LENGTH)}\x1b[0m\n`,
					);
				}
			}
		}
		if (toolFiles.size > MAX_LISTED_FILES) {
			process.stderr.write(
				`\x1b[2m         ... and ${toolFiles.size - MAX_LISTED_FILES} more files\x1b[0m\n`,
			);
		}
	}

	function displayDepAuditResult(result: { items: AuditResult[]; elapsedMs: string }): void {
		const auditResult = result.items[0] ?? null;
		if (auditResult) {
			const sc = auditResult.critical > 0 || auditResult.high > 0 ? "31" : "33";
			process.stderr.write(
				`\n  \x1b[1mdependency audit (SCA)\x1b[0m \x1b[2m${result.elapsedMs}\x1b[0m\n`,
			);
			process.stderr.write(
				`    \x1b[${sc}m✗\x1b[0m \x1b[${sc}m${auditResult.total}\x1b[0m vulnerabilities (${auditResult.detail})\n`,
			);
			summary.push({
				label: `${auditResult.total} dep vulnerabilities`,
				count: auditResult.total,
				color: sc,
			});
		} else {
			process.stderr.write(
				`\n  \x1b[1mdependency audit (SCA)\x1b[0m \x1b[2m${result.elapsedMs}\x1b[0m\n`,
			);
			process.stderr.write("    \x1b[32m✓\x1b[0m no known vulnerabilities\n");
		}
	}

	function parseToolOutput(tool: ToolSpec, output: string, status: number | null): CheckResult[] {
		if (
			tool.id === "gitleaks" &&
			status === 1 &&
			(output.includes("FTL") || output.includes("no such file"))
		) {
			return [];
		}
		if ((tool.id === "semgrep" || tool.id === "knip") && status === 2) return [];
		if (status === 0 && tool.id !== "tsc") return [];
		const parser = toolParsers[tool.id];
		return parser ? parser(output) : [];
	}

	if (toolCount <= 1 && availableTools.length === 1 && !runDepAudit) {
		const tool = availableTools[0];
		const rawResults = await runToolWithSpinner({
			label: tool.label,
			cmd: tool.cmd,
			cwd,
			timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
			parseOutput: (output, status) => parseToolOutput(tool, output, status),
		});
		displayToolResult(tool, rawResults);
		return;
	}
	if (toolCount === 0) return;

	let frame = 0;
	let completed = 0;
	const remaining = new Set(availableTools.map((t) => t.label));
	if (runDepAudit) remaining.add("dep audit");

	const spinner = setInterval(() => {
		const secs = ((Date.now() - parallelStart) / 1000).toFixed(0);
		const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
		const pending = [...remaining].join(", ");
		process.stderr.write(
			`\r\x1b[K  \x1b[36m${f}\x1b[0m \x1b[1m${completed}/${toolCount}\x1b[0m \x1b[2m${secs}s — waiting: ${pending}\x1b[0m`,
		);
		frame++;
	}, SPINNER_FRAME_MS);

	const allDone: Promise<void>[] = [];

	for (const tool of availableTools) {
		allDone.push(
			runToolSilent({
				cmd: tool.cmd,
				cwd,
				timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
				parseOutput: (output, status) => parseToolOutput(tool, output, status),
			}).then((rawResults) => {
				process.stderr.write("\r\x1b[K");
				displayToolResult(tool, rawResults);
				completed++;
				remaining.delete(tool.label);
			}),
		);
	}

	if (runDepAudit) {
		allDone.push(
			runToolSilent({
				cmd: ["npm", "audit", "--json", "--audit-level=moderate"],
				cwd,
				timeoutMs: DEFAULT_DEP_AUDIT_TIMEOUT_MS,
				parseOutput: (output) => {
					const audit = parseNpmAuditJson(output);
					return audit ? [audit] : [];
				},
			}).then((depResult) => {
				process.stderr.write("\r\x1b[K");
				displayDepAuditResult(depResult);
				completed++;
				remaining.delete("dep audit");
			}),
		);
	}

	await Promise.all(allDone);
	clearInterval(spinner);
	process.stderr.write("\r\x1b[K");

	const parallelElapsed = ((Date.now() - parallelStart) / 1000).toFixed(1);
	process.stderr.write(`\x1b[2m  all tools completed in ${parallelElapsed}s (parallel)\x1b[0m\n`);
}

async function runVerifyBatchJson(
	engine: CheckEngine,
	files: string[],
	cwd: string,
	opts: VerifyOpts,
	scope: import("../harness/check-engine/types.js").CheckScope,
): Promise<void> {
	const only = opts.only;
	const onlySkipTools = only
		? TOOL_IDS.filter((t) => t !== only && t !== only.replace("_", "-"))
		: [];
	const skipChecks = getEffectiveSkipChecks(opts.skip, opts.allChecks);
	const skipTools = [...new Set([...onlySkipTools, ...getSkipTools(skipChecks)])];
	setActiveSkipChecks(skipChecks);

	const report = engine.runChecks(scope, {
		timeoutMs: CHECK_ENGINE_TIMEOUT_MS,
		skipTools: skipTools as import("../harness/check-engine/types.js").ToolId[],
	});

	const interlinkedDir = join(cwd, ".interlinked");
	const filterToolResults = (results: CheckResult[]): CheckResult[] =>
		results.filter((r) => {
			const fileSup = loadFileSuppressions(interlinkedDir, r.file);
			return !fileSup.has(r.tool);
		});

	const tscResults = filterToolResults(report.results.filter((r) => r.tool === "tsc"));
	const biomeResults = filterToolResults(report.results.filter((r) => r.tool === "biome"));
	const eslintResults = filterToolResults(report.results.filter((r) => r.tool === "eslint"));
	const semgrepResults = filterToolResults(report.results.filter((r) => r.tool === "semgrep"));
	const gitleaksResults = filterToolResults(report.results.filter((r) => r.tool === "gitleaks"));
	const linterResults = [...biomeResults, ...eslintResults];
	const linterName = eslintResults.length > 0 ? "eslint" : "biome";
	const auditResult = opts.only && opts.only !== "sca" ? null : engine.runDepAudit();
	const cq = filterCodeQualityResults(runCodeQualityChecks(files, cwd), skipChecks);
	const setupIssues = checkProjectSetup(cwd);
	let registryDrift: RegistryDriftFinding[] = [];
	try {
		registryDrift = runRegistryParityCheck(cwd);
	} catch (e) {
		void e;
	}
	let suggestions: Map<string, Finding[]> | null = null;
	if (opts.suggestions) {
		suggestions = runSuggestions({
			files,
			cwd,
			limit: SUGGESTIONS_LIMIT,
			threshold: SUGGESTIONS_THRESHOLD,
		});
	}

	outputJson({
		tscResults,
		linterResults,
		linterName,
		semgrepResults,
		gitleaksResults,
		auditResult,
		cq,
		suggestions,
		totalFiles: files.length,
		setupIssues,
		registryDrift,
		structureSection: opts.structure ? buildStructureJsonSection(cwd, opts) : undefined,
	});
}

// Keep `DEFAULT_ADVISORY_SKIPS` in the exported namespace via import below
// so the regression test's import path keeps working even after the refactor.
// (The `export { DEFAULT_ADVISORY_SKIPS } from "./verify/advisory.js"` above
// handles runtime; this reference keeps the name bundled in any build output
// that tree-shakes aggressively.)
void DEFAULT_ADVISORY_SKIPS;
