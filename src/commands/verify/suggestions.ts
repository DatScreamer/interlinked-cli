// ===========================================
// Scored regex suggestions
// ===========================================
// Non-deterministic heuristics (SQL injection patterns, perf smells, silent
// catches). Opt-in via `interlinked verify --suggestions`. Findings are
// scored and filtered against inline + file-level suppressions.

import { readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import {
	checkAwaitInLoop,
	checkMixedErrorStrategy,
	checkQueryInLoop,
	checkSilentCatch,
	checkSqlInjection,
	checkUnreachableCode,
} from "../../harness/generic-checks.js";
import { type Finding, scoreFindings } from "../../harness/suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../../harness/suppressions.js";

const JS_TS_CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

interface SuggestionCheck {
	check: string;
	source: "security" | "performance" | "quality";
	fn: () => Array<{ line: number; text: string }>;
}

function buildChecks(content: string, file: string): SuggestionCheck[] {
	return [
		{
			check: "sql-injection",
			source: "security",
			fn: () => checkSqlInjection(content, file),
		},
		{
			check: "perf-query-in-loop",
			source: "performance",
			fn: () => checkQueryInLoop(content, file),
		},
		{
			check: "perf-await-in-loop",
			source: "performance",
			fn: () => checkAwaitInLoop(content, file),
		},
		{
			check: "silent-catch",
			source: "quality",
			fn: () => checkSilentCatch(content, file),
		},
		{
			check: "unreachable-code",
			source: "quality",
			fn: () => checkUnreachableCode(content, file),
		},
		{
			check: "mixed-error-strategy",
			source: "quality",
			fn: () => checkMixedErrorStrategy(content, file),
		},
	];
}

function isTestFile(file: string, base: string): boolean {
	if (base.endsWith(".test")) return true;
	if (base.endsWith(".spec")) return true;
	if (file.includes("__tests__")) return true;
	return false;
}

interface RunSuggestionsArgs {
	files: string[];
	cwd: string;
	limit: number;
	threshold: number;
}

/**
 * Public API — consumed by `verify.ts` (opt-in `--suggestions` flag).
 *
 * Run scored regex suggestions (SQL injection, perf, silent catches, etc.) and
 * return one `Finding[]` per file that had surviving findings after scoring.
 */
export function runSuggestions(args: RunSuggestionsArgs): Map<string, Finding[]> {
	const { files, cwd, limit, threshold } = args;
	const interlinkedDir = join(cwd, ".interlinked");
	const resultsByFile = new Map<string, Finding[]>();

	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}

		const ext = extname(file).toLowerCase();
		if (!JS_TS_CODE_EXTS.includes(ext)) continue;

		const base = basename(file, ext);
		if (isTestFile(file, base)) continue;

		const relPath = relative(cwd, file);
		const inlineSup = scanInlineSuppressions(content);
		const fileSup = loadFileSuppressions(interlinkedDir, relPath);

		const findings: Finding[] = [];
		for (const { check, source, fn } of buildChecks(content, file)) {
			for (const m of fn()) {
				findings.push({ check, line: m.line, message: m.text, source });
			}
		}

		if (findings.length === 0) continue;
		const scored = scoreFindings(findings, {
			filePath: file,
			inlineSuppressions: inlineSup,
			fileSuppressions: fileSup,
			limit,
			threshold,
		});
		if (scored.length > 0) {
			resultsByFile.set(relPath, scored);
		}
	}

	return resultsByFile;
}
