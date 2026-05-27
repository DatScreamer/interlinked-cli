// Cleanup-skipped-on-early-exit check.
//
// Detects: a resource (timer / event listener / subscription) is acquired,
// a `throw` or `return` happens before the matching release on at least one
// path, and there's no `try/finally` between the acquisition and the
// release.
//
// JS analog of Firefox 2024653 / 2027298 (UAF via re-entry / early exit
// during teardown). The bug shape is "the cleanup line exists, but a path
// reaches `throw`/`return` before it can run." Distinct from
// `lifecycle_cleanup` (which fires when cleanup is missing entirely).

import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

/** Lookahead window from acquisition to cleanup. Larger than typical
 * function bodies, smaller than file size. */
const LOOKAHEAD_CHARS = 5000;
const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

interface NamedAcquisition {
	/** Regex that captures the bound name in group 1. */
	acqRe: RegExp;
	/** Build a regex that matches the cleanup call for the given name. */
	cleanupReFor: (name: string) => RegExp;
}

const NAMED_ACQUISITIONS: NamedAcquisition[] = [
	{
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*setInterval\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\bclearInterval\\s*\\(\\s*${n}\\s*\\)`),
	},
	{
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*setTimeout\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\bclearTimeout\\s*\\(\\s*${n}\\s*\\)`),
	},
	{
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*[\w.]+\.subscribe\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.unsubscribe\\s*\\(`),
	},
	// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.5):
	// file/socket/process handles. Same semantic as the original three — cleanup
	// call exists somewhere in the function, but an early throw/return bypasses
	// it. Bare-name variants cover destructured imports (`import { spawn } from
	// 'node:child_process'`); the `fs.openSync` form ALSO matches `openSync` via
	// the optional `(?:\w+\.)?` qualifier.
	{
		// fs.openSync (closed by separate fs.closeSync(fd) call, NOT a method on fd)
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?openSync\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b(?:\\w+\\.)?closeSync\\s*\\(\\s*${n}\\s*\\)`),
	},
	{
		// fs.createReadStream — close/destroy method on the stream
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?createReadStream\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.(?:close|destroy)\\s*\\(`),
	},
	{
		// fs.createWriteStream — close/destroy/end method on the stream
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?createWriteStream\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.(?:close|destroy|end)\\s*\\(`),
	},
	{
		// net.connect / net.createConnection — destroy/end method on the socket
		acqRe:
			/\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?(?:connect|createConnection)\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.(?:destroy|end)\\s*\\(`),
	},
	{
		// dgram.createSocket — close method on the socket
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?createSocket\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.close\\s*\\(`),
	},
	{
		// child_process.spawn / fork — kill method on the child
		acqRe: /\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:\w+\.)?(?:spawn|fork)\s*\(/g,
		cleanupReFor: (n) => new RegExp(`\\b${n}\\.kill\\s*\\(`),
	},
];

/**
 * Detect resource acquisitions whose paired cleanup is bypassed on a
 * throw/return path with no try/finally wrap.
 *
 * Up to 10 matches per file. Conservative: if we see a `try` keyword
 * between the acquisition and the cleanup, we assume the cleanup is in
 * a finally block and don't fire.
 */
export function checkCleanupSkippedOnEarlyExit(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	const recordExit = (exitOffset: number): boolean => {
		const lineNo = stripped.slice(0, exitOffset).split("\n").length;
		if (seen.has(lineNo)) return false;
		seen.add(lineNo);
		matches.push({
			line: lineNo,
			text: (lines[lineNo - 1] || "").trim().slice(0, REPORT_LINE_TRUNC),
		});
		return matches.length >= MAX_MATCHES_PER_FILE;
	};

	for (const { acqRe, cleanupReFor } of NAMED_ACQUISITIONS) {
		const re = new RegExp(acqRe.source, "g");
		let acqHit: RegExpExecArray | null;
		while ((acqHit = re.exec(stripped))) {
			if (matches.length >= MAX_MATCHES_PER_FILE) return matches;
			const name = acqHit[1];
			const acqEnd = acqHit.index + acqHit[0].length;
			const windowEnd = Math.min(stripped.length, acqHit.index + LOOKAHEAD_CHARS);
			const window = stripped.slice(acqEnd, windowEnd);

			const cleanupMatch = window.match(cleanupReFor(name));
			if (!cleanupMatch || cleanupMatch.index === undefined) continue;

			const between = window.slice(0, cleanupMatch.index);
			if (/\btry\s*\{/.test(between)) continue;

			const exitMatch = between.match(/\b(?:throw|return)\b/);
			if (!exitMatch || exitMatch.index === undefined) continue;

			const exitOffset = acqEnd + exitMatch.index;
			if (recordExit(exitOffset)) return matches;
		}
	}

	// addEventListener / removeEventListener pairing — no const-binding,
	// match by receiver. Strings have been stripped, so we can't match the
	// event name; receiver-equality is a sufficient pairing heuristic.
	const addRe = /\b([\w$.]+)\.addEventListener\s*\(/g;
	let addHit: RegExpExecArray | null;
	while ((addHit = addRe.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return matches;
		const receiver = addHit[1].replace(/[.]/g, "\\.");
		const acqEnd = addHit.index + addHit[0].length;
		const windowEnd = Math.min(stripped.length, addHit.index + LOOKAHEAD_CHARS);
		const window = stripped.slice(acqEnd, windowEnd);

		const removeRe = new RegExp(`\\b${receiver}\\.removeEventListener\\s*\\(`);
		const removeMatch = window.match(removeRe);
		if (!removeMatch || removeMatch.index === undefined) continue;

		const between = window.slice(0, removeMatch.index);
		if (/\btry\s*\{/.test(between)) continue;

		const exitMatch = between.match(/\b(?:throw|return)\b/);
		if (!exitMatch || exitMatch.index === undefined) continue;

		const exitOffset = acqEnd + exitMatch.index;
		if (recordExit(exitOffset)) return matches;
	}

	return matches;
}
