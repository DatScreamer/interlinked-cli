// interlinked-tdd: exempt
// ===========================================
// interlinked search — query parsing + ranking helpers
// ===========================================
// Pure helpers split out of search.ts: regex/glob escaping, multi-term
// query splitting, OR-pattern building, and term-density file ranking.
// Shared result/match/ranking types live here so siblings import one source.

import { nonNull } from "../lib/non-null.js";

// ===========================================
// Types
// ===========================================

export interface SearchMatch {
	file: string;
	line: number;
	column?: number | undefined;
	text: string;
	context_before?: string[] | undefined;
	context_after?: string[] | undefined;
}

export interface SearchResult {
	query: string;
	engine: "ripgrep" | "native";
	matches: SearchMatch[];
	total: number;
	truncated: boolean;
	searched_files: number;
	elapsed_ms: number;
}

export interface FileRanking {
	file: string;
	termsMatched: number;
	totalTerms: number;
	matchedTerms: string[];
	matchCount: number;
}

// ===========================================
// Helpers
// ===========================================

export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{DOUBLESTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\{\{DOUBLESTAR\}\}/g, ".*");
	// Reason: all regex metacharacters are escaped above; only glob wildcards
	// are expanded into bounded patterns. No attacker-controllable source.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return new RegExp(escaped);
}

/**
 * Split a natural language query into searchable terms.
 * Filters out short noise words and returns individual terms.
 */
export function splitQueryTerms(query: string): string[] {
	const STOP_WORDS = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"do",
		"does",
		"did",
		"has",
		"have",
		"had",
		"will",
		"would",
		"can",
		"could",
		"should",
		"may",
		"might",
		"shall",
		"in",
		"on",
		"at",
		"to",
		"for",
		"of",
		"with",
		"by",
		"from",
		"it",
		"its",
		"this",
		"that",
		"these",
		"those",
		"and",
		"or",
		"but",
		"not",
		"no",
		"if",
		"then",
		"so",
		"how",
		"what",
		"when",
		"where",
		"which",
		"who",
		"why",
	]);

	return query
		.split(/\s+/)
		.map((t) => t.replace(/[^a-zA-Z0-9_.-]/g, ""))
		.filter((t) => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
}

/**
 * Determine if a query should use smart multi-term search.
 * Returns true for multi-word natural language queries.
 */
export function isMultiTermQuery(query: string): boolean {
	const terms = splitQueryTerms(query);
	return terms.length >= 2;
}

/**
 * Build a ripgrep-compatible OR pattern from multiple terms.
 * e.g., ["OAuth", "token", "validation"] → "OAuth|token|validation"
 */
export function buildOrPattern(terms: string[]): string {
	return terms.map(escapeRegex).join("|");
}

/**
 * Rank files by how many distinct query terms they contain.
 */
export function rankFilesByTermDensity(matches: SearchMatch[], terms: string[]): FileRanking[] {
	const fileData = new Map<string, { lines: Set<string>; count: number }>();

	for (const m of matches) {
		const entry = fileData.get(m.file) || { lines: new Set(), count: 0 };
		entry.lines.add(m.text);
		entry.count++;
		fileData.set(m.file, entry);
	}

	const rankings: FileRanking[] = [];
	const lowerTerms = terms.map((t) => t.toLowerCase());

	for (const [file, data] of Array.from(fileData.entries())) {
		const allText = [...data.lines].join("\n").toLowerCase();
		const matchedTerms: string[] = [];
		for (let i = 0; i < lowerTerms.length; i++) {
			if (allText.includes(nonNull(lowerTerms[i]))) {
				matchedTerms.push(nonNull(terms[i]));
			}
		}

		rankings.push({
			file,
			termsMatched: matchedTerms.length,
			totalTerms: terms.length,
			matchedTerms,
			matchCount: data.count,
		});
	}

	// Sort by: most terms matched, then most total matches
	return rankings.sort((a, b) => b.termsMatched - a.termsMatched || b.matchCount - a.matchCount);
}
