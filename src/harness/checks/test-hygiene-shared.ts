// Shared internal primitives for the test-hygiene check families.
//
// Holds the two helpers needed by BOTH the isolation family
// (test-hygiene-isolation.ts) and the quality family
// (test-hygiene-quality.ts): the `it()` / `test()` call-opening regex and the
// brace/paren-balanced call-span scanner. Kept in a sibling module rather than
// in the public barrel so each family file imports them directly without an
// import cycle through the re-exporting barrel.

// `it` / `test` (with the usual modifier chain), capturing only the call
// opening. `specify` is intentionally excluded — vitest's slow-subprocess
// flake is `it`/`test`, and `specify` carries no `{ timeout }` overload.
export const IT_TEST_OPEN_RE =
	/\b(it|test)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|sequential|failing))*\s*\(/g;

/**
 * Brace/paren-balanced span of an `it(...)` / `test(...)` call argument list.
 * `from` is the index just inside the opening `(`. Returns the index of the
 * matching close `)` plus the comma offsets at depth 0 (argument separators),
 * or null if unbalanced (truncated file / regex artifact).
 */
export function findCallSpan(
	text: string,
	from: number,
): { end: number; topLevelCommas: number[] } | null {
	let depth = 1; // already inside the `it(` paren
	const topLevelCommas: number[] = [];
	const MAX_SCAN = 20_000; // a single test block past this is pathological
	const limit = Math.min(text.length, from + MAX_SCAN);
	for (let i = from; i < limit; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return { end: i, topLevelCommas };
		} else if (ch === "," && depth === 1) {
			topLevelCommas.push(i);
		}
	}
	return null;
}
