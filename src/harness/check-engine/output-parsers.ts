// ===========================================
// Check Engine — Output Parsers
// ===========================================
// Pure functions: raw tool output string → CheckResult[].
// Extracted from verify.ts and evaluator.ts so both can reuse them.

import { relative } from "node:path";
import type { AuditResult, CheckResult } from "./types.js";

// -------------------------------------------
// TypeScript (tsc --noEmit --pretty false)
// -------------------------------------------
// Format: "path/file.ts(line,col): error TS1234: message"

export function parseTscOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		// File-level errors: "file(line,col): error TSxxxx: message"
		const fileMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/);
		if (fileMatch) {
			const [, file, lineNo, col, code, msg] = fileMatch;
			if (file === undefined || lineNo === undefined || col === undefined || code === undefined) {
				continue;
			}
			results.push({
				tool: "tsc",
				severity: "error",
				file,
				line: Number.parseInt(lineNo, 10),
				column: Number.parseInt(col, 10),
				message: `${code}: ${msg ?? ""}`,
				ruleId: code,
			});
			continue;
		}
		// Project-level errors: "error TSxxxx: message" (no file reference)
		// e.g. "error TS2688: Cannot find type definition file for 'node'."
		const projectMatch = line.match(/^error\s+(TS\d+):\s*(.+)/);
		if (projectMatch) {
			const [, code, msg] = projectMatch;
			if (code === undefined) continue;
			results.push({
				tool: "tsc",
				severity: "error",
				file: "tsconfig.json",
				line: 0,
				message: `${code}: ${msg ?? ""}`,
				ruleId: code,
			});
		}
	}
	return results;
}

// -------------------------------------------
// Biome (biome check)
// -------------------------------------------
// Format: "path/file.ts:line:col <category> ━━━..." — implementation lives in
// output-parsers-biome.ts (line-cap extraction, round 6: the parse/syntax
// diagnostic family joined the pattern there).

export { parseBiomeOutput } from "./output-parsers-biome.js";

// -------------------------------------------
// ESLint (eslint --format unix)
// -------------------------------------------
// Format: "path/file.ts:line:col: message [rule]"

export function parseEslintOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+?):(\d+):(\d+):\s+(.+)/);
		if (match) {
			const [, file, lineNo, col, rawMsg] = match;
			if (file === undefined || lineNo === undefined || col === undefined || rawMsg === undefined) {
				continue;
			}
			const msg = rawMsg.trim();
			const ruleMatch = msg.match(/\[(.+)\]$/);
			results.push({
				tool: "eslint",
				severity: "warning",
				file,
				line: Number.parseInt(lineNo, 10),
				column: Number.parseInt(col, 10),
				message: msg,
				ruleId: ruleMatch?.[1],
			});
		}
	}
	return results;
}

// -------------------------------------------
// Semgrep (semgrep scan --json)
// -------------------------------------------
// JSON format: { results: [{ path, start: { line, col }, check_id, extra: { message } }] }

export function parseSemgrepJson(output: string, projectRoot: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		const results: CheckResult[] = [];
		for (const finding of parsed.results || []) {
			results.push({
				tool: "semgrep",
				severity: "warning",
				file: relative(projectRoot, finding.path || ""),
				line: finding.start?.line || 0,
				column: finding.start?.col,
				message: `${finding.check_id || "unknown"}: ${finding.extra?.message || ""}`.trim(),
				ruleId: finding.check_id,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// Gitleaks (gitleaks detect --json)
// -------------------------------------------
// JSON format: [{ File, StartLine, RuleID, Description }]

export function parseGitleaksJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!Array.isArray(parsed)) return [];
		const results: CheckResult[] = [];
		for (const finding of parsed) {
			results.push({
				tool: "gitleaks",
				severity: "error",
				file: finding.File || "",
				line: finding.StartLine || 0,
				message: `${finding.RuleID || "secret"}: ${finding.Description || "secret detected"}`,
				ruleId: finding.RuleID,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// npm audit (npm audit --json)
// -------------------------------------------
// JSON format: { metadata: { vulnerabilities: { critical, high, moderate, low } } }

export function parseNpmAuditJson(output: string): AuditResult | null {
	try {
		const parsed = JSON.parse(output);
		const v = parsed.metadata?.vulnerabilities;
		if (!v) return null;
		const total = (v.critical || 0) + (v.high || 0) + (v.moderate || 0) + (v.low || 0);
		if (total === 0) return null;

		const counts = [];
		if (v.critical) counts.push(`${v.critical} critical`);
		if (v.high) counts.push(`${v.high} high`);
		if (v.moderate) counts.push(`${v.moderate} moderate`);
		if (v.low) counts.push(`${v.low} low`);

		return {
			tool: "npm audit",
			total,
			critical: v.critical || 0,
			high: v.high || 0,
			moderate: v.moderate || 0,
			low: v.low || 0,
			detail: counts.join(", "),
		};
	} catch {
		return null;
	}
}

// -------------------------------------------
// docs:check (node scripts/check-docs.mjs)
// -------------------------------------------
// Format (one block per drift, lines are NOT JSON):
//   [docs:fail] /abs/path/to/file: <marker> drift
//     expected: 106
//     actual:   105
//   ...
//   N doc-accuracy failure(s). Run 'npm run docs:build' to ...
//
// Each `[docs:fail]` line becomes one CheckResult. The following
// `expected:` / `actual:` lines are folded into the message so the
// drift is visible in summary output. The trailing summary line is
// ignored — it's a count, not a finding.

export function parseDocsCheckOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const header = lines[i].match(/^\[docs:fail\]\s+(.+?):\s*(.+)$/);
		if (!header) continue;
		const file = header[1];
		let message = header[2];
		// Fold expected/actual lines into the message when present.
		const exp = lines[i + 1]?.match(/^\s*expected:\s*(.+)$/);
		const act = lines[i + 2]?.match(/^\s*actual:\s*(.+)$/);
		if (exp && act) {
			message = `${message} (expected ${exp[1].trim()}, actual ${act[1].trim()})`;
		}
		results.push({
			tool: "docs-check",
			severity: "error",
			file,
			line: 0,
			message,
		});
	}
	return results;
}

// -------------------------------------------
// Secondary-language parsers + osv-scanner
// -------------------------------------------
// Implementations live in output-parsers-extra.ts (line-cap extraction).
// Re-exported here so all existing import sites stay unchanged.

export {
	parseOsvScannerJson,
	parseMypyOutput,
	parseRuffJson,
	parseCargoJson,
	parseGoBuildOutput,
	parseGolangciLintJson,
	parseGccOutput,
	parseClangTidyOutput,
} from "./output-parsers-extra.js";


// -------------------------------------------
// oxlint (oxlint --format=json)
// -------------------------------------------
// JSON format: { diagnostics: [{ message, code, severity, filename, labels: [{ span: { line, column } }] }] }

export function parseOxlintJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		const diagnostics = parsed.diagnostics;
		if (!Array.isArray(diagnostics)) return [];
		const results: CheckResult[] = [];
		for (const d of diagnostics) {
			const span = d.labels?.[0]?.span;
			results.push({
				tool: "oxlint",
				severity: d.severity === "error" ? "error" : "warning",
				file: d.filename || "",
				line: span?.line || 0,
				column: span?.column,
				message: d.message || "",
				ruleId: d.code,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// knip (knip --reporter json)
// -------------------------------------------
// JSON: { files: string[], issues: [{ file, exports: [{name,line}], types: [{name,line}], dependencies: [], unlisted: [] }] }

export function parseKnipJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		const results: CheckResult[] = [];

		// Unused files
		if (Array.isArray(parsed.files)) {
			for (const file of parsed.files) {
				results.push({
					tool: "knip",
					severity: "warning",
					file,
					line: 0,
					message: "unused file — not imported by any other module",
					ruleId: "unused-file",
				});
			}
		}

		// Per-file issues
		if (Array.isArray(parsed.issues)) {
			for (const issue of parsed.issues) {
				const file = issue.file || "";
				for (const exp of issue.exports || []) {
					results.push({
						tool: "knip",
						severity: "warning",
						file,
						line: exp.line || 0,
						message: `unused export: ${exp.name}`,
						ruleId: "unused-export",
					});
				}
				for (const t of issue.types || []) {
					results.push({
						tool: "knip",
						severity: "warning",
						file,
						line: t.line || 0,
						message: `unused type export: ${t.name}`,
						ruleId: "unused-type",
					});
				}
				for (const dep of issue.unlisted || []) {
					results.push({
						tool: "knip",
						severity: "warning",
						file,
						line: 0,
						message: `unlisted dependency: ${dep.name || dep}`,
						ruleId: "unlisted-dep",
					});
				}
			}
		}

		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// ShellCheck (shellcheck --format=json1)
// -------------------------------------------
// JSON1 format: { comments: [{ file, line, column, level, code, message }] }

export function parseShellcheckJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		const comments = parsed.comments;
		if (!Array.isArray(comments)) return [];
		const results: CheckResult[] = [];
		for (const c of comments) {
			const level = c.level as string;
			if (level === "style" || level === "info") continue;
			results.push({
				tool: "shellcheck",
				severity: level === "error" ? "error" : "warning",
				file: c.file || "",
				line: c.line || 0,
				column: c.column,
				message: c.message || "",
				ruleId: c.code ? `SC${c.code}` : undefined,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// actionlint (actionlint <file>)
// -------------------------------------------
// Format: "file:line:col: message [rule-name]"

export function parseActionlintOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+?):(\d+):(\d+):\s*(.+?)(?:\s+\[(.+?)\])?\s*$/);
		if (match) {
			results.push({
				tool: "actionlint",
				severity: "warning",
				file: match[1],
				line: Number.parseInt(match[2], 10),
				column: Number.parseInt(match[3], 10),
				message: match[4].trim(),
				ruleId: match[5],
			});
		}
	}
	return results;
}

// -------------------------------------------
// Hadolint (hadolint --format json)
// -------------------------------------------
// JSON format: [{ line, code, message, level, file }]

export function parseHadolintJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!Array.isArray(parsed)) return [];
		const results: CheckResult[] = [];
		for (const finding of parsed) {
			const level = finding.level as string;
			results.push({
				tool: "hadolint",
				severity: level === "error" ? "error" : "warning",
				file: finding.file || "",
				line: finding.line || 0,
				message: `${finding.code || ""}: ${finding.message || ""}`.trim(),
				ruleId: finding.code,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// Taplo (taplo check <file>)
// -------------------------------------------
// Stderr format: "error: ... at line:col" or "error[rule]: message\n  --> file:line:col"

export function parseTaploOutput(output: string, filePath?: string): CheckResult[] {
	const results: CheckResult[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Format: "error[rule]: message" followed by "  --> file:line:col"
		const errorMatch = line.match(/^error(?:\[(.+?)\])?:\s*(.+)/);
		if (errorMatch) {
			let file = filePath || "";
			let lineNum = 0;
			let col: number | undefined;
			// Check next line for location
			const nextLine = lines[i + 1] || "";
			const locMatch = nextLine.match(/^\s*-->\s*(.+?):(\d+):(\d+)/);
			if (locMatch) {
				file = locMatch[1];
				lineNum = Number.parseInt(locMatch[2], 10);
				col = Number.parseInt(locMatch[3], 10);
				i++; // skip the location line
			}
			results.push({
				tool: "taplo",
				severity: "error",
				file,
				line: lineNum,
				column: col,
				message: errorMatch[2].trim(),
				ruleId: errorMatch[1],
			});
		}
	}
	return results;
}

/**
 * Filter CheckResult[] to only results matching a specific file.
 * Used when a project-wide tool (tsc) runs but we only want one file's results.
 */
export function filterResultsToFile(results: CheckResult[], filePath: string): CheckResult[] {
	return results.filter((r) => r.file === filePath || r.file.endsWith(filePath));
}
