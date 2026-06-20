// ===========================================
// Edit Diagnostics — Near-miss span finder for failed Edit operations
// ===========================================
// When Edit fails because old_string was not found, the model has to guess
// or re-Read the whole file. This module finds the closest fuzzy-matching
// spans so the harness can return them as additionalContext, converting a
// dead round-trip into a fix.

import { nonNull } from "../lib/non-null.js";

export interface NearMiss {
	/** 1-based line number of the matching span's first line */
	line: number;
	/** First line of the matched span (trimmed, truncated to 120 chars) */
	snippet: string;
	/** Similarity score 0..1 (higher = closer match) */
	similarity: number;
}

/**
 * Find the top-N spans in `content` most similar to `target`.
 *
 * Algorithm: sliding window over file lines of the same line count as target,
 * scored by averaged Sørensen-Dice bigram similarity per line.
 *
 * Returns spans with similarity >= MIN_SIMILARITY, deduplicated so overlapping
 * windows collapse to the highest-scoring one.
 */
export function findClosestSpans(content: string, target: string, n = 3): NearMiss[] {
	if (!target || !content) return [];
	const targetLines = target.split("\n");
	const fileLines = content.split("\n");
	if (fileLines.length < targetLines.length) return [];

	// Heuristic: very short targets (single short line) get fuzzy matched
	// against single lines anywhere in the file rather than windowed.
	const targetIsShortSingleLine = targetLines.length === 1 && target.trim().length < 40;

	const candidates: NearMiss[] = [];
	const windowSize = targetLines.length;

	for (let i = 0; i + windowSize <= fileLines.length; i++) {
		const windowLines = fileLines.slice(i, i + windowSize);
		const sim = windowSimilarity(targetLines, windowLines);
		if (sim < MIN_SIMILARITY) continue;
		candidates.push({
			line: i + 1,
			snippet: nonNull(windowLines[0]).trim().slice(0, 120),
			similarity: sim,
		});
	}

	// For very short single-line targets, also scan all lines (in case the
	// match is at a line whose trimmed length differs significantly).
	if (targetIsShortSingleLine && candidates.length < n) {
		for (const [i, fileLine] of fileLines.entries()) {
			const sim = lineSimilarity(target, fileLine);
			if (sim < MIN_SIMILARITY) continue;
			if (candidates.some((c) => c.line === i + 1)) continue;
			candidates.push({
				line: i + 1,
				snippet: fileLine.trim().slice(0, 120),
				similarity: sim,
			});
		}
	}

	candidates.sort((a, b) => b.similarity - a.similarity);

	// Dedupe: collapse overlapping windows to the highest-scoring one
	const dedup: NearMiss[] = [];
	for (const c of candidates) {
		const overlap = dedup.some((d) => Math.abs(d.line - c.line) < Math.max(windowSize, 2));
		if (overlap) continue;
		dedup.push(c);
		if (dedup.length >= n) break;
	}
	return dedup;
}

/**
 * Format near-miss results as a multi-line hint suitable for warning text.
 * Empty string if no misses (caller can branch on truthy).
 */
export function formatNearMisses(misses: NearMiss[]): string {
	if (misses.length === 0) return "";
	return misses
		.map((m) => `  L${m.line} (${Math.round(m.similarity * 100)}% match): ${m.snippet}`)
		.join("\n");
}

// ===========================================
// Internals
// ===========================================

const MIN_SIMILARITY = 0.4;

function windowSimilarity(target: string[], window: string[]): number {
	if (target.length !== window.length) return 0;
	let total = 0;
	for (const [i, targetLine] of target.entries()) {
		total += lineSimilarity(targetLine, nonNull(window[i]));
	}
	return total / target.length;
}

function lineSimilarity(a: string, b: string): number {
	const ta = a.trim();
	const tb = b.trim();
	if (ta === tb) return 1;
	if (!ta && !tb) return 1;
	if (!ta || !tb) return 0;
	const bigA = bigrams(ta);
	const bigB = bigrams(tb);
	if (bigA.size === 0 || bigB.size === 0) return ta === tb ? 1 : 0;
	let intersect = 0;
	for (const g of bigA) if (bigB.has(g)) intersect++;
	return (2 * intersect) / (bigA.size + bigB.size);
}

function bigrams(s: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < s.length - 1; i++) {
		out.add(s.slice(i, i + 2));
	}
	return out;
}
