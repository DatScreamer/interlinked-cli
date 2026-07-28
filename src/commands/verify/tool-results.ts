// ===========================================
// Per-tool code quality check collection
// ===========================================
// Runs the battery of inline checks (from `../../harness/generic-checks.ts`
// and siblings) across every discovered file and returns a big bucket per
// check. The shape (`CodeQualityResults`) is consumed by:
//   - `output-json.ts` (JSON formatter)
//   - `streaming-output.ts` (human-readable streaming)
//   - `verify.ts` (passes through to both)
//
// The per-file check battery (~80 inline checks) lives in `./file-checks.ts`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { parseEnvDocumentation } from "../../harness/generic-checks.js";
import { parseExports } from "../../harness/project-graph.js";
import { type FileSuppressions, loadFileSuppressions } from "../../harness/suppressions.js";

// `validateSuppressionFile` lived in an upstream branch that enforces
// rationale/expiry on persisted suppressions. It's not in this repo, so the
// hygiene-findings pipe is disabled until that helper lands.
const validateSuppressionFile = (
	_interlinkedDir: string,
): Array<{ name: string; file: string; message: string }> => [];

import { runVerifyParityChecks } from "../../harness/verify-parity.js";
import { readSharedConfig } from "../../lib/config.js";
import { nonNull } from "../../lib/non-null.js";
import { JS_TS_EXTS } from "./advisory.js";
import { runPerFileChecks } from "./file-checks.js";
import {
	type CodeQualityIssue,
	type CodeQualityResults,
	CQ_RESULT_KEYS,
	emptyResults,
} from "./tool-results-types.js";

/**
 * Public API — consumed by `verify.ts`.
 *
 * Drop every issue whose `check` name appears in `skipChecks`. Returns a fresh
 * `CodeQualityResults` object; does not mutate the input.
 */
export function filterCodeQualityResults(
	results: CodeQualityResults,
	skipChecks: Set<string>,
): CodeQualityResults {
	const filtered = {} as CodeQualityResults;
	for (const key of CQ_RESULT_KEYS) {
		filtered[key] = results[key].filter((issue) => !skipChecks.has(issue.check));
	}
	return filtered;
}

function buildUndocumentedEnvIssues(
	allEnvRefs: Map<string, Array<{ file: string; line: number }>>,
	documentedEnvVars: Set<string>,
): CodeQualityIssue[] {
	const issues: CodeQualityIssue[] = [];

	for (const [envVar, refs] of [...allEnvRefs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (documentedEnvVars.has(envVar)) continue;
		const firstRef = refs
			.slice()
			.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)[0];
		const fileCount = new Set(refs.map((ref) => ref.file)).size;
		issues.push({
			check: "undocumented_env_vars",
			file: nonNull(firstRef).file,
			line: nonNull(firstRef).line,
			message: `env var "${envVar}" is undocumented (${refs.length} references across ${fileCount} files)`,
		});
	}

	return issues;
}

function collectModuleExports(files: string[], moduleExportsCache: Map<string, string[]>): void {
	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const ext = extname(file).toLowerCase();
		if (JS_TS_EXTS.has(ext) && !file.endsWith(".d.ts")) {
			const exports = parseExports(content);
			moduleExportsCache.set(
				file,
				exports.map((e) => e.name),
			);
		}
	}
}

function applyParityFindings(r: CodeQualityResults, files: string[], cwd: string): void {
	const parity = runVerifyParityChecks(files);
	for (const sr of parity.crossFileSwitchDiscriminant) {
		r.crossFileSwitchDiscriminant.push({
			check: "cross_file_switch_discriminant",
			file: relative(cwd, sr.file),
			line: 0,
			message: sr.message,
		});
	}
	for (const sr of parity.singleImplementationInterface) {
		r.singleImplementationInterface.push({
			check: "single_implementation_interface",
			file: relative(cwd, sr.file),
			line: 0,
			message: sr.message,
		});
	}
	for (const fw of parity.filesWithoutTest) {
		r.filesWithoutTest.push({
			check: "files_without_test",
			file: relative(cwd, fw.file),
			line: 0,
			message: `No test file on disk (expected ${relative(cwd, fw.expectedTest)}).`,
		});
	}
	if (parity.projectLocRatio?.exceeded) {
		r.projectLocRatio.push({
			check: "project_loc_ratio",
			file: "<project>",
			line: 0,
			message: `Project prod/test LOC ratio is ${
				Number.isFinite(parity.projectLocRatio.ratio)
					? parity.projectLocRatio.ratio.toFixed(1)
					: "∞"
			}:1 (limit ${parity.projectLocRatio.limit}:1). Prod ${parity.projectLocRatio.prodLoc} LOC, test ${parity.projectLocRatio.testLoc} LOC.`,
		});
	}
}

function applyPersistedSuppressions(r: CodeQualityResults, interlinkedDir: string): void {
	const suppressionCache = new Map<string, FileSuppressions>();
	function getFileSuppressions(relPath: string): FileSuppressions {
		let cached = suppressionCache.get(relPath);
		if (!cached) {
			cached = loadFileSuppressions(interlinkedDir, relPath);
			suppressionCache.set(relPath, cached);
		}
		return cached;
	}

	for (const key of CQ_RESULT_KEYS) {
		r[key] = r[key].filter((issue) => {
			const fileSup = getFileSuppressions(issue.file);
			return !fileSup.has(issue.check);
		});
	}

	const hygieneFindings = validateSuppressionFile(interlinkedDir);
	for (const f of hygieneFindings) {
		r.suppressionHygiene.push({
			check: f.name,
			file: f.file,
			line: 0,
			message: f.message,
		});
	}
}

/**
 * Public API — consumed by `verify.ts` (batch JSON + streaming modes).
 *
 * Run all code quality checks using shared functions from generic-checks.ts
 * and quality-checks.ts. These are the SAME functions the harness evaluator
 * uses, ensuring verify and PostToolUse always agree.
 */
export function runCodeQualityChecks(files: string[], cwd: string): CodeQualityResults {
	const r = emptyResults();

	// Load PII config from shared config (if available). Build with conditional
	// spreads so absent keys stay absent rather than being set to `undefined`
	// — `PiiOpts` (derived from checkPiiInSource) is exact-optional.
	const sharedConfig = readSharedConfig(cwd);
	const piiOpts = {
		...(sharedConfig?.pii_opt_in ? { optIn: sharedConfig.pii_opt_in } : {}),
		...(sharedConfig?.pii_patterns ? { customPatterns: sharedConfig.pii_patterns } : {}),
	};

	// Project-level data needed for cross-file checks
	const documentedEnvVars = parseEnvDocumentation(
		cwd,
		{ existsSync, readFileSync, readdirSync },
		join,
	);
	const allEnvRefs = new Map<string, Array<{ file: string; line: number }>>();
	const moduleExportsCache = new Map<string, string[]>();

	// Pass 1: collect all project exports (used by mock-drift check)
	collectModuleExports(files, moduleExportsCache);

	// Pass 2: per-file checks (delegated to file-checks.ts)
	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		runPerFileChecks({
			file,
			content,
			cwd,
			r,
			moduleExportsCache,
			allEnvRefs,
			piiOpts,
		});
	}

	// Pass 3: verify-parity project-wide scans
	applyParityFindings(r, files, cwd);

	// Post-loop: emit one issue per undocumented env var instead of one per reference.
	r.undocumentedEnvVars.push(...buildUndocumentedEnvIssues(allEnvRefs, documentedEnvVars));

	// Apply suppressions + hygiene findings
	applyPersistedSuppressions(r, join(cwd, ".interlinked"));

	return r;
}

/** Public API — consumed by `verify.ts` and tests. Re-exports helper. */
export { checkProjectSetup } from "../../harness/generic-checks.js";

/** Public API — consumed by `verify.ts` and tests. Re-export from ./suggestions.js. */
export { runSuggestions } from "./suggestions.js";
