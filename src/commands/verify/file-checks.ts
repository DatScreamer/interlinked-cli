// ===========================================
// Per-file check battery
// ===========================================
// Applies every generic + taste check to a single file's content and
// appends findings to the shared `CodeQualityResults`. This is the bulk of
// `runCodeQualityChecks` — extracted into its own module so `tool-results.ts`
// stays under the 800-line file-size threshold.
//
// `runPerFileChecks` is a thin orchestrator: it runs the core checks that
// need shared local state (large-file cap, JSON-validity early return, strong
// typing, phantom imports, env-ref accumulation, mock drift) inline, then
// fans the remaining ~200 stateless detectors out to per-group helpers in the
// sibling `file-checks-<group>.ts` modules. Each helper takes the shared
// `FileCheckContext` and mutates `r` in place. Because every `r.<bucket>`
// array is independent, the only ordering that matters is per-bucket
// statement order — preserved verbatim across the split.

import { basename, extname, relative } from "node:path";

import {
	checkConsoleDebug,
	checkFunctionComplexity,
	checkMissingReturnTypes,
	checkSilentCatch,
	checkTestFileExists,
	checkTestRegressions,
	checkTsconfigStrictness,
	extractEnvReferences,
	extractMockDefinitions,
} from "../../harness/generic-checks.js";
import { parseImports, resolveImportPath } from "../../harness/project-graph.js";
import { findAnyTypes } from "../../harness/quality-checks.js";
import { isGeneratedFile } from "../../harness/checks/shared.js";
import {
	countLines,
	DEFAULT_MAX_LINES,
	evaluateLargeFile,
	isCappableFile,
	loadLargeFileBaseline,
} from "../../harness/large-file-policy.js";
import {
	type InlineSuppressions,
	isSuppressed,
	scanInlineSuppressions,
} from "../../harness/suppressions.js";
import { JS_TS_EXTS } from "./advisory.js";
import { runAgentSafetyChecks, runCrapCheck } from "./file-checks-agent-safety.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { runReactAndTasteChecks } from "./file-checks-react-test.js";
import { toIssues } from "./file-checks-shared.js";
import type { FileCheckContext, PiiOpts } from "./file-checks-shared.js";
import { runUbsChecks } from "./file-checks-ubs.js";
import { collectSuppressionFindings } from "./suppressions.js";
import { CQ_RESULT_KEYS } from "./tool-results-types.js";
import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";

// Re-exported for the `file-checks-<group>.test.ts` files, which import these
// names from `./file-checks.js`. The definitions now live in
// `./file-checks-shared.js` to break the file-checks ↔ group-file cycle.
export { toIssues };
export type { FileCheckContext, PiiOpts };

const JSON_EXT = ".json";
const TS_EXT = ".ts";
const TSX_EXT = ".tsx";
const DTS_SUFFIX = ".d.ts";
const ANY_KIND = "any";
const JSON_PARSE_ERR_SLICE = 150;

interface MockDriftArgs {
	mocks: ReturnType<typeof extractMockDefinitions>;
	moduleExportsCache: Map<string, string[]>;
	file: string;
	relPath: string;
	cwd: string;
	out: CodeQualityIssue[];
}

/**
 * Compare mock definitions in a test file against the real module exports we
 * cached earlier, and emit a finding when a mock references a name that is
 * NOT exported.
 */
function collectMockDriftFindings(args: MockDriftArgs): void {
	const { mocks, moduleExportsCache, file, relPath, cwd, out } = args;
	for (const mock of mocks) {
		const resolved = resolveImportPath(file, mock.modulePath);
		if (!resolved) continue;
		const cachedExports = moduleExportsCache.get(resolved);
		if (!cachedExports) continue;
		const exportSet = new Set(cachedExports);
		const missing = mock.mockedNames.filter((name) => !exportSet.has(name));
		if (missing.length === 0) continue;
		for (const name of missing) {
			out.push({
				check: "mock_drift",
				file: relPath,
				line: mock.line,
				message: `mock references "${name}" which is not exported by "${relative(cwd, resolved)}"`,
			});
		}
	}
}

interface RunFileChecksArgs {
	file: string;
	content: string;
	cwd: string;
	r: CodeQualityResults;
	moduleExportsCache: Map<string, string[]>;
	allEnvRefs: Map<string, Array<{ file: string; line: number }>>;
	piiOpts: PiiOpts;
}

/**
 * Public API — consumed by `tool-results.ts`.
 *
 * Run every per-file check against a single file. Mutates `r` in place.
 * Returns early for `.d.ts` files and for JSON files (after validating them).
 *
 * Inline `// interlinked-ignore: <check> — <reason>` comments are honored on
 * the DEFAULT gate here (previously only the scored `--suggestions` path
 * respected them). We snapshot every result bucket's length before running the
 * per-file detectors, then drop any newly-added finding whose `(line, check)`
 * pair is suppressed by an inline-ignore on that line. Tool-based findings
 * (tsc/biome/etc.) are produced elsewhere and are untouched.
 */
export function runPerFileChecks(args: RunFileChecksArgs): void {
	const { content, r } = args;

	// Snapshot bucket lengths so the post-pass only re-examines findings this
	// file contributed — accumulated findings from earlier files are left alone.
	// Production callers pass the full `emptyResults()` object; the `?? 0` guard
	// only matters for partial test fixtures that omit some buckets.
	const before = new Map<keyof CodeQualityResults, number>();
	for (const key of CQ_RESULT_KEYS) before.set(key, r[key]?.length ?? 0);

	collectPerFileFindings(args);

	// Files with no ignore comments take a fast path: scanInlineSuppressions
	// returns an empty map and we change nothing.
	const inlineSuppressions = scanInlineSuppressions(content);
	if (inlineSuppressions.size === 0) return;

	dropInlineSuppressed(r, before, inlineSuppressions);
}

/**
 * Drop the just-added inline-check findings (per bucket, from each bucket's
 * pre-run length onward) whose `(line, check)` matches an inline-ignore comment.
 * The check-name match is case-insensitive — `scanInlineSuppressions`
 * lower-cases the names it parses, so we lower-case the finding's `check` too.
 */
function dropInlineSuppressed(
	r: CodeQualityResults,
	before: Map<keyof CodeQualityResults, number>,
	inlineSuppressions: InlineSuppressions,
): void {
	const NO_FILE_SUPPRESSIONS = new Set<string>();
	for (const key of CQ_RESULT_KEYS) {
		const start = before.get(key) ?? 0;
		const bucket = r[key];
		// Defensive: production passes the full `emptyResults()`; a partial test
		// fixture may omit a bucket entirely.
		if (!bucket || bucket.length === start) continue; // nothing new for this file
		const kept = bucket
			.slice(start)
			.filter(
				(issue) =>
					!isSuppressed(
						issue.check.toLowerCase(),
						issue.line,
						inlineSuppressions,
						NO_FILE_SUPPRESSIONS,
					),
			);
		bucket.length = start;
		bucket.push(...kept);
	}
}

function collectPerFileFindings(args: RunFileChecksArgs): void {
	const { file, content, cwd, r, moduleExportsCache, allEnvRefs, piiOpts } = args;

	const ext = extname(file).toLowerCase();
	const relPath = relative(cwd, file);
	const isDts = file.endsWith(DTS_SUFFIX);

	// Oversized written-code files — enforced cap (default gate). Generated,
	// test, .d.ts and non-code files are exempt; files in the baseline are
	// grandfathered up to their recorded size (a ratchet — they may shrink
	// or hold but not grow). See harness/large-file-policy.ts.
	if (isCappableFile({ filePath: file, content })) {
		const baseline = loadLargeFileBaseline(cwd);
		const verdict = evaluateLargeFile({ relPath, lines: countLines(content), baseline });
		if (verdict.overCap && !verdict.grandfathered) {
			const cap = baseline?.max_lines ?? DEFAULT_MAX_LINES;
			r.largeFiles.push({
				check: "large_files",
				file: relPath,
				line: 0,
				message: `${verdict.lines} lines — over the ${cap}-line cap for hand-written code. Split into smaller, focused modules.`,
			});
		}
	}

	// JSON validity
	if (ext === JSON_EXT) {
		try {
			JSON.parse(content);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			r.jsonValidity.push({
				check: "json_validity",
				file: relPath,
				line: 0,
				message: msg.slice(0, JSON_PARSE_ERR_SLICE),
			});
		}
		// tsconfig*.json strictness check — runs BEFORE the early return so
		// tsconfig files surface in `interlinked verify` the same way they
		// surface at PostToolUse. The detector handles its own basename
		// filter (`tsconfig.json` / `tsconfig.*.json`) and node_modules skip
		// internally, so we can call it unconditionally for any .json file.
		r.tsconfigStrictness.push(
			...toIssues("tsconfig_strictness", relPath, checkTsconfigStrictness(content, file)),
		);
		return;
	}

	if (isDts) return;

	// Strong typing — shared findAnyTypes (non-test, non-generated only)
	const base = basename(file, ext);
	const isTest = base.endsWith(".test") || base.endsWith(".spec") || file.includes("__tests__");
	if (!isTest && (ext === TS_EXT || ext === TSX_EXT) && !isGeneratedFile(content)) {
		for (const m of findAnyTypes(content)) {
			if (m.kind === ANY_KIND) {
				r.strongTyping.push({
					check: "strong_typing",
					file: relPath,
					line: m.line,
					message: m.text,
				});
			}
		}
	}

	r.consoleStatements.push(
		...toIssues("console_statements", relPath, checkConsoleDebug(content, file)),
	);
	r.silentCatches.push(...toIssues("silent_catches", relPath, checkSilentCatch(content, file)));

	if (JS_TS_EXTS.has(ext) && !isGeneratedFile(content)) {
		collectSuppressionFindings(content, relPath, r.suppressions);
	}

	// Phantom imports
	if (JS_TS_EXTS.has(ext)) {
		for (const imp of parseImports(content, file)) {
			if (!imp.specifier.startsWith(".") && !imp.specifier.startsWith("/")) continue;
			if (imp.specifier.endsWith(JSON_EXT)) continue;
			if (!resolveImportPath(file, imp.specifier)) {
				r.phantomImports.push({
					check: "phantom_imports",
					file: relPath,
					line: 0,
					message: `imports "${imp.specifier}" which does not resolve to any file`,
				});
			}
		}
	}

	const testResult = checkTestRegressions(content, file);
	if (testResult.skipped.length > 0) {
		r.testRegressions.push(...toIssues("test_regressions", relPath, testResult.skipped));
	}

	for (const ref of extractEnvReferences(content, file)) {
		const entry = allEnvRefs.get(ref.name) || [];
		entry.push({ file: relPath, line: ref.line });
		allEnvRefs.set(ref.name, entry);
	}

	if (JS_TS_EXTS.has(ext)) {
		const mocks = extractMockDefinitions(content, file);
		collectMockDriftFindings({
			mocks,
			moduleExportsCache,
			file,
			relPath,
			cwd,
			out: r.mockDrift,
		});
	}

	r.missingReturnTypes.push(
		...toIssues("missing_return_types", relPath, checkMissingReturnTypes(content, file)),
	);
	r.noTestFile.push(...toIssues("no_test_file", relPath, checkTestFileExists(file, content)));
	r.complexity.push(...toIssues("complexity", relPath, checkFunctionComplexity(content, file)));

	// Remaining stateless detector groups — fanned out to sibling modules. The
	// shared context carries everything they need; each group mutates `r` in
	// place, preserving the original inline statement order per bucket.
	const ctx: FileCheckContext = { file, content, relPath, cwd, r, piiOpts };
	runCrapCheck(ctx);
	runAgentSafetyChecks(ctx);
	runReactAndTasteChecks(ctx);
	runUbsChecks(ctx);
	runEndpointAndLazinessChecks(ctx);
}
