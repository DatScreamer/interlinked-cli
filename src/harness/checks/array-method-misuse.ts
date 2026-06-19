// Array-method misuse: mutator return-value used, and variadic-builtin iteratee.
//
// Two pattern-exact array bugs generalized from eslint-plugin-unicorn
// (no-return-array-push, and a narrowed slice of no-array-callback-reference):
//
//  (1) array_push_return_used — `Array#push()` / `Array#unshift()` return the
//      new LENGTH, not the element or the array. Returning that length, or
//      binding it to a variable, is almost always a mistake — it reads as if the
//      value were meaningful when it tells you nothing about what you added:
//        const added = items.push(item);   // `added` is a count, not the item
//        return list.push(value);           // returns a number, reads like the list
//      Fix: mutate, then return / use the array (or `.length`) explicitly.
//      Skipped: stream-style `this.push(chunk)` (Readable#push returns a
//      meaningful boolean) and chained `.push(x).length` (an explicit length
//      read). Arrow implicit-return bodies (`() => arr.push(x)`) are also NOT
//      flagged — they are overwhelmingly void event-handler callbacks whose
//      return value is discarded, so the regex form can't separate the rare real
//      bug (`const add = x => arr.push(x)`) from the common harmless callback.
//
//  (2) array_iteratee_variadic_builtin — passing `parseInt` directly as the
//      callback to `.map()` / `.flatMap()` / `Array.from(x, fn)` is the classic
//      `['1','2','3'].map(parseInt)` -> `[1, NaN, NaN]` bug: the iterator passes
//      the element index as the second argument, which `parseInt` reads as the
//      radix. Narrowed to `parseInt` (the only common builtin whose extra
//      argument is load-bearing — `Number`/`Boolean`/`String` ignore it), so it
//      is effectively zero-false-positive, unlike the full unicorn rule.
//      Fix: wrap it — `.map((s) => parseInt(s, 10))`.
//
// Both only fire on JS/TS source and run over comment/string-stripped source,
// so a `.push(` inside a string or comment never trips them. Regex shape
// detectors → the findings carry the [heuristic] determinism tag.

import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;

// ─── array_push_return_used ─────────────────────────────────────────────────

// `.push(…)` / `.unshift(…)` whose return value is returned or bound to a fresh
// binding. The receiver chain (e.g. `items`, `this.items`, `a.b[0]`) is captured
// in group 1 so we can exempt stream-style receivers.
const RECEIVER = String.raw`([\w.$[\]]+)`;
const PUSH_CALL = String.raw`\.(?:push|unshift)\s*\(\s*[^)\s]`;
const RETURN_PUSH_RE = new RegExp(String.raw`\breturn\s+${RECEIVER}${PUSH_CALL}`);
const DECL_PUSH_RE = new RegExp(
	String.raw`\b(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?=\s*${RECEIVER}${PUSH_CALL}`,
);

// A chained call (`arr.push(x).length`, `arr.push(x).at(-1)`) explicitly reads a
// real value off the mutated array — that is deliberate, not the length bug.
const CHAINED_PUSH_RE = /\.(?:push|unshift)\s*\([^;]*\)\s*\./;

/**
 * Node's `Readable#push(chunk)` returns a backpressure boolean that callers
 * legitimately consume. Exempt the bare `this.push(…)` form and receivers whose
 * name advertises a stream so the one common non-array `.push` stays quiet.
 */
function receiverIsStreamLike(receiver: string): boolean {
	if (receiver === "this") return true;
	return /(?:stream|readable|writable|duplex|socket|sink)/i.test(receiver);
}

/**
 * Detect `Array#push()` / `Array#unshift()` return values used as a return value
 * or a fresh variable binding.
 *
 * Check id: `array_push_return_used`. Only fires on JS/TS source.
 */
export function detectReturnArrayPush(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const line = strippedLines[i];
		if (line === undefined) continue;
		if (CHAINED_PUSH_RE.test(line)) continue;

		const hit = RETURN_PUSH_RE.exec(line) ?? DECL_PUSH_RE.exec(line);
		if (!hit) continue;
		if (receiverIsStreamLike(hit[1] ?? "")) continue;

		matches.push({ line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, REPORT_LINE_TRUNC) });
	}
	return matches;
}

// ─── array_iteratee_variadic_builtin ────────────────────────────────────────

// `.map(parseInt)` / `.flatMap(parseInt)` and `Array.from(x, parseInt)` — the
// element index flows into `parseInt`'s radix slot. `Number.parseInt` is the
// same function, so cover the namespaced form too.
const MAP_PARSEINT_RE = /\.(?:map|flatMap)\s*\(\s*(?:Number\.)?parseInt\s*\)/;
const ARRAY_FROM_PARSEINT_RE = /\bArray\.from\s*\([^,()]+,\s*(?:Number\.)?parseInt\s*\)/;

/**
 * Detect `parseInt` passed bare as an array iteratee (`.map`/`.flatMap`/
 * `Array.from`) — the `['1','2','3'].map(parseInt)` -> `[1, NaN, NaN]` bug.
 *
 * Check id: `array_iteratee_variadic_builtin`. Only fires on JS/TS source.
 */
export function detectArrayIterateeVariadicBuiltin(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const line = strippedLines[i];
		if (line === undefined) continue;
		if (MAP_PARSEINT_RE.test(line) || ARRAY_FROM_PARSEINT_RE.test(line)) {
			matches.push({ line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, REPORT_LINE_TRUNC) });
		}
	}
	return matches;
}
