// ReDoS — catastrophic-backtracking regex detector (a distinct algorithmic-
// complexity / DoS bug class). A quantified group whose body ALSO contains an
// unbounded quantifier — (a+)+, (\d*)*, ([a-z]+)* — matches adversarial input in
// exponential time, turning one crafted request into a CPU-pegging hang.
//
// FP discipline: we extract the actual regex BODY (from a `/.../ ` literal, a
// `new RegExp("…")`, or a Python `re.<fn>("…")`) and test the nested-quantifier
// signature ONLY on that body. Testing raw code would false-positive on ordinary
// arithmetic like `(x+1)*2`. Ext-gated to JS/TS (literals + RegExp) and Python
// (re.*). Returns InlineMatch[].

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
} from "./shared.js";

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const MATCH_LIMIT = 10;

/** A quantified group `(…+…)` or `(…*…)` immediately re-quantified by `+ * {n,}`.
 *  Bodies are bounded (no nested parens, ≤80 chars) so the detector is itself
 *  linear — never a ReDoS. */
const NESTED_QUANT = /\([^()]{0,80}?[+*][^()]{0,80}?\)\s*(?:[*+]|\{\d+,\}?)/;

/** Pull candidate regex bodies out of one line for the given language. */
function regexBodies(line: string, isPy: boolean): string[] {
	const bodies: string[] = [];
	if (isPy) {
		// re.compile / match / search / fullmatch / sub / split / findall("…")
		const re =
			/\bre\.(?:compile|match|search|fullmatch|sub|subn|split|findall|finditer)\s*\(\s*r?(['"])((?:\\.|(?!\1)[^\\]){0,200})\1/g;
		for (const m of line.matchAll(re)) if (m[2]) bodies.push(m[2]);
		return bodies;
	}
	// JS: new RegExp("…") / RegExp('…')
	const rr = /\bRegExp\s*\(\s*(['"])((?:\\.|(?!\1)[^\\]){0,200})\1/g;
	for (const m of line.matchAll(rr)) if (m[2]) bodies.push(m[2]);
	// JS regex literal /…/flags — not preceded by an identifier/`)` (avoids division).
	const lit = /(?<![\w)$\]])\/((?:\\.|[^/\\\n]){1,200})\/[gimsuy]*/g;
	for (const m of line.matchAll(lit)) if (m[1]) bodies.push(m[1]);
	return bodies;
}

export function checkRedosCatastrophic(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isPy = PY_EXTS.has(ext);
	if (!isPy && !JS_EXTS.has(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = lines[i] ?? "";
		if (!line.includes("(")) continue; // every ReDoS signature needs a group
		let hit = false;
		for (const body of regexBodies(line, isPy)) {
			if (NESTED_QUANT.test(body)) {
				hit = true;
				break;
			}
		}
		if (!hit) continue;
		if (lineHasNoqaSuppression(line, "redos_catastrophic")) continue;
		matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
	}
	return matches;
}
