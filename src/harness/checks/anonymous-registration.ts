// `anonymous_registration` — a registry entry whose implementation has no name.
//
// Motivating incident, this repo, 2026-08-09: four check registrations passed
// an inline arrow as `fn`, so `fn.name` was the empty string and the Check
// Evidence Contract's name-based resolver could not find a detector file for
// any of them. They were the last four ids nobody could satisfy — not because
// the checks were weak, but because nothing could LOOK THEM UP. Retrieval
// hostility bit the harness's own tooling before it ever met a small model.
//
// The general shape: an object literal carries a string `id`/`name` — the
// lookup key every other file references — and an anonymous function as its
// implementation. The key is greppable; the implementation is not reachable
// from it in one hop, not by grep, not by an embedding search, and not by an
// agent asking "where is X implemented". This is the cheapest possible
// retrieval fix: naming the function costs one word and restores the edge.
//
// Deliberately narrow. It requires BOTH signals close together, so ordinary
// anonymous callbacks (`items.map((x) => …)`) are untouched — those are not
// registrations and nothing looks them up by key.

// `isStrictTestFile`, NOT `isTestFile`: the latter is an alias for
// `isPatternDataFile` (the vendored/generated/fixture predicate) and matches
// any path containing "example", which silently swallowed this check's own
// fixtures. The name genuinely lies — the same retrieval hazard this detector
// exists to catch, one layer down.
import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_EXTS } from "./shared.js";

/** How far after an `id:`/`name:` key an anonymous implementation still counts
 *  as part of the same entry. Registry entries put the two within a few lines;
 *  a wider window would start matching unrelated neighbouring code. */
const ENTRY_WINDOW_LINES = 12;

const MATCH_LIMIT = 10;

/** `id: "x"` / `name: 'x'` — the greppable lookup key. */
const LOOKUP_KEY_RE = /\b(?:id|name)\s*:\s*["'`][^"'`]+["'`]/;

/**
 * An implementation-shaped key bound to an ANONYMOUS function.
 *
 * `fn: (a) => …`, `handler: function (…)`, `detector: async (…) => …`.
 * A named reference (`fn: checkSomething`) does not match, which is the whole
 * point — that form is one hop from its id.
 */
const ANON_IMPL_RE =
	/\b(?:fn|handler|detector|check|run|execute|callback|impl)\s*:\s*(?:async\s+)?(?:function\s*\(|\()/;

/** True for a line that is entirely a comment — prose describing the shape. */
function isCommentLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Flag anonymous implementations bound to a lookup key.
 *
 * Scoped to JS/TS source; test files are exempt because a throwaway handler in
 * a fixture is not something anyone needs to resolve by id.
 */
export function checkAnonymousRegistration(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isStrictTestFile(filePath)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	/** Line of the most recent lookup key, or -1 when none is in range. */
	let lastKeyLine = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isCommentLine(line)) continue;
		if (LOOKUP_KEY_RE.test(line)) lastKeyLine = i;
		if (lastKeyLine === -1 || i - lastKeyLine > ENTRY_WINDOW_LINES) continue;
		if (!ANON_IMPL_RE.test(line)) continue;
		if (matches.length >= MATCH_LIMIT) break;
		matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
	}
	return matches;
}
