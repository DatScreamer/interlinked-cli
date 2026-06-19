// interlinked-tdd: exempt
// ===========================================
// interlinked search — human-readable renderers
// ===========================================
// Normal/full output formatters split out of search.ts. Pure string builders
// over the search result + optional file rankings; no engine or fs access.

import { c, header, truncate } from "../lib/formatter.js";
import type { FileRanking, SearchMatch, SearchResult } from "./search-query.js";

function renderRankingSummary(rankings: FileRanking[]): string[] {
	const lines: string[] = [];
	const top = rankings.slice(0, 10);
	if (top.length === 0) return lines;

	lines.push(c.bold("Most relevant files:"));
	const HIGH_MATCH_PCT = 75;
	const MEDIUM_MATCH_PCT = 50;
	for (const r of top) {
		const pct = Math.round((r.termsMatched / r.totalTerms) * 100);
		const label = `${pct}%`;
		let bar: string;
		if (pct >= HIGH_MATCH_PCT) {
			bar = c.green(label);
		} else if (pct >= MEDIUM_MATCH_PCT) {
			bar = c.yellow(label);
		} else {
			bar = c.dim(label);
		}
		const terms = c.dim(`[${r.matchedTerms.join(", ")}]`);
		lines.push(`  ${bar} ${c.bold(r.file)} ${terms}`);
	}
	lines.push("");
	return lines;
}

export function renderNormal(result: SearchResult, rankings?: FileRanking[]): string {
	const lines: string[] = [];
	lines.push(header(`Search: "${result.query}"`));
	lines.push(
		c.dim(
			`  ${result.engine} · ${result.total} match${result.total !== 1 ? "es" : ""} · ${result.searched_files} files · ${result.elapsed_ms}ms`,
		),
	);
	lines.push("");

	if (result.matches.length === 0) {
		lines.push(c.dim("  No matches found."));
		return lines.join("\n");
	}

	// Show file ranking summary for multi-term queries
	if (rankings) {
		lines.push(...renderRankingSummary(rankings));
	}

	// Group by file, ordered by ranking if available
	const byFile = new Map<string, SearchMatch[]>();
	if (rankings) {
		// Use ranking order
		for (const r of rankings) {
			byFile.set(r.file, []);
		}
	}
	for (const m of result.matches) {
		const existing = byFile.get(m.file) || [];
		existing.push(m);
		byFile.set(m.file, existing);
	}

	for (const [file, matches] of byFile) {
		if (matches.length === 0) continue;
		lines.push(c.bold(file));
		for (const m of matches) {
			const lineStr = c.dim(`${String(m.line).padStart(4)}:`);
			lines.push(`  ${lineStr} ${truncate(m.text, 120)}`);
		}
		lines.push("");
	}

	if (result.truncated) {
		lines.push(
			c.dim(
				`  … ${result.total - result.matches.length} more matches (use --limit to see more)`,
			),
		);
	}

	return lines.join("\n");
}

export function renderFull(result: SearchResult, rankings?: FileRanking[]): string {
	const lines: string[] = [];
	lines.push(header(`Search: "${result.query}"`));
	lines.push(
		c.dim(
			`  ${result.engine} · ${result.total} match${result.total !== 1 ? "es" : ""} · ${result.searched_files} files · ${result.elapsed_ms}ms`,
		),
	);
	lines.push("");

	if (result.matches.length === 0) {
		lines.push(c.dim("  No matches found."));
		return lines.join("\n");
	}

	// Show file ranking summary for multi-term queries
	if (rankings) {
		lines.push(...renderRankingSummary(rankings));
	}

	for (const m of result.matches) {
		lines.push(`${c.bold(m.file)}:${c.yellow(String(m.line))}`);
		if (m.context_before) {
			for (const ctx of m.context_before) {
				lines.push(c.dim(`    ${ctx}`));
			}
		}
		lines.push(`  > ${m.text}`);
		if (m.context_after) {
			for (const ctx of m.context_after) {
				lines.push(c.dim(`    ${ctx}`));
			}
		}
		lines.push("");
	}

	if (result.truncated) {
		lines.push(
			c.dim(
				`  … ${result.total - result.matches.length} more matches (use --limit to see more)`,
			),
		);
	}

	return lines.join("\n");
}
