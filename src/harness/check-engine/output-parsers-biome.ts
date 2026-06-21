// ===========================================
// Output parser — Biome (extracted from output-parsers.ts for the line cap)
// ===========================================
// Diagnostic headers: `file:line:col <category> ━━━`. Categories are lint
// rules (`lint/...`), `assist/...` (e.g. `assist/source/organizeImports` —
// unsorted imports/exports), `format`, and `parse`/`syntax`. Two families were
// each missing once and each caused a SILENT fail-open: `parse`/`syntax` (round
// 6) and `assist/*` (finding 2026-06) — when biome's ONLY finding was an assist
// diagnostic the parser returned [] while biome still exited non-zero, so the
// runner reported "no diagnostics parsed — lint NOT validated" and waved the
// edit through (it never caught unsorted imports, which CI `biome check` fails).
// Re-exported through output-parsers.ts — import from there.

import type { CheckResult } from "./types.js";

export function parseBiomeOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(
			/^(.+?):(\d+):(\d+)\s+(lint\S+|assist\S+|suppressions\S+|format|parse|syntax)\s/,
		);
		if (match) {
			const [, file, lineNo, col, rule] = match;
			if (file === undefined || lineNo === undefined || col === undefined || rule === undefined) {
				continue;
			}
			const isParse = rule === "parse" || rule === "syntax";
			results.push({
				tool: "biome",
				severity: isParse ? "error" : "warning",
				file,
				line: Number.parseInt(lineNo, 10),
				column: Number.parseInt(col, 10),
				message: isParse ? `${rule}: file does not parse` : rule,
				ruleId: rule,
			});
		}
	}
	return results;
}
