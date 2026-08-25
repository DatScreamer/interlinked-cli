// ===========================================
// Bash write detection — shared parsing primitives
// ===========================================
// Leaf module both `pre-checks-bash-write-detect.ts` and
// `pre-checks-bash-write-verbs.ts` import, so the two scanners cannot form an
// import cycle (they did, briefly, on 2026-08-25 — this split is the fix).

/** File extensions the harness's content-gate checks care about. */
export const CODE_FILE_EXT_RE =
	/\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|swift|c|cc|cpp|cxx|h|hpp|hxx|rb|php|cs|scala|clj|sh|bash|zsh)$/i;

export function splitCommandSegments(cmd: string): string[] {
	return cmd.split(/\s+(?:&&|\|\||;|\|)\s+/).filter(Boolean);
}

export function splitShellWordsLoose(segment: string): string[] {
	// Flatten nested-quantifier alternation: `(?:[^"\\]|\\[\s\S])*` advances
	// one character per iteration with no backtracking, avoiding the
	// catastrophic-backtracking shape of `[^"\\]*(?:\\.[^"\\]*)*`.
	const words: string[] = [];
	const re = /"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|(\S+)/g;
	for (const match of segment.matchAll(re)) {
		words.push(match[0]);
	}
	return words;
}

export function stripOuterQuotes(value: string): string {
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("\"") && value.endsWith("\""))
	) {
		return value.slice(1, -1);
	}
	return value;
}
