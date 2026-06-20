// ============================================================
// node-fetch / undici / global fetch footgun detectors
// ============================================================
// Real anti-patterns the global fetch API encourages:
//
//   - `fetch(url)` with no AbortSignal / timeout — hangs forever
//     if the server stalls; the function never settles.
//   - `fetch(url).then(r => r.json())` without first checking
//     `r.ok` — a 500-with-JSON-body is silently treated as data.
//
// Mythos's curl analysis specifically flagged "third-party API
// misuse through contextual library knowledge" as a high-signal
// class. These detectors are the deterministic equivalent for one
// of the most-misused APIs in the Node / Workers ecosystem.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isGeneratedFile, isTestFile, JS_TS_EXTS } from "../checks/shared.js";
import type { LibraryFootgunCheck } from "./types.js";

const FETCH_CALL_RE = /(?<![.\w$])fetch\s*\(([^)]*)\)/g;

function shouldSkip(filePath: string, content: string): boolean {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return true;
	if (isTestFile(filePath)) return true;
	if (isGeneratedFile(content)) return true;
	return false;
}

/** Detect `fetch(url)` calls whose argument list does not mention
 *  `signal`, `AbortSignal`, or `timeout`. Bare `fetch(url)` with no
 *  options object hangs indefinitely on a stalled server. */
function detectNoTimeout(content: string, filePath: string): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	FETCH_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = FETCH_CALL_RE.exec(content);
	while (m !== null) {
		const args = nonNull(m[1]);
		// Single-line argument check. Multi-line option objects (the
		// hard case) we skip — the regex above only captures the first
		// paren-group on a single line. False negatives are acceptable;
		// false positives on real timeout configs are not.
		if (!/\b(?:signal|AbortSignal|timeout)\b/.test(args)) {
			const lineNo = content.slice(0, m.index).split("\n").length;
			out.push({
				line: lineNo,
				text: (lines[lineNo - 1] || "").trim().slice(0, 150),
			});
		}
		m = FETCH_CALL_RE.exec(content);
	}
	return out;
}

const FETCH_THEN_JSON_RE = /\bfetch\s*\([^)]*\)\s*\.then\s*\(\s*([\w$]+)\s*=>\s*\1\.json\s*\(/g;

/** Detect `fetch(url).then(r => r.json())` with no preceding `r.ok`
 *  check. A 500 with a JSON body looks like success otherwise. */
function detectNoOkCheck(content: string, filePath: string): InlineMatch[] {
	if (shouldSkip(filePath, content)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	FETCH_THEN_JSON_RE.lastIndex = 0;
	let m: RegExpExecArray | null = FETCH_THEN_JSON_RE.exec(content);
	while (m !== null) {
		// Inspect the 200-char window around the match for an `.ok`
		// reference. Tolerant — false negative is OK; the false-positive
		// cost of flagging legit `if (r.ok)` patterns is higher.
		const windowStart = Math.max(0, m.index - 100);
		const windowEnd = Math.min(content.length, m.index + m[0].length + 100);
		const window = content.slice(windowStart, windowEnd);
		if (!/\.ok\b/.test(window)) {
			const lineNo = content.slice(0, m.index).split("\n").length;
			out.push({
				line: lineNo,
				text: (lines[lineNo - 1] || "").trim().slice(0, 150),
			});
		}
		m = FETCH_THEN_JSON_RE.exec(content);
	}
	return out;
}

export const NODE_FETCH_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "node_fetch_no_timeout",
		name: "fetch() without timeout",
		library: "node-fetch",
		detect: detectNoTimeout,
		fixInstruction:
			"Bare `fetch(url)` hangs indefinitely when the server stalls — the promise never settles. Pass `{ signal: AbortSignal.timeout(<ms>) }` so a slow upstream returns control to your code.",
	},
	{
		id: "node_fetch_no_ok_check",
		name: "fetch().then(r => r.json()) without r.ok check",
		library: "node-fetch",
		detect: detectNoOkCheck,
		fixInstruction:
			"`fetch(...).then(r => r.json())` treats a 5xx response with a JSON body as success — `.json()` happily parses the error envelope into your downstream data. Check `r.ok` (or `r.status < 400`) and throw / branch on failure before reading the body.",
	},
];
