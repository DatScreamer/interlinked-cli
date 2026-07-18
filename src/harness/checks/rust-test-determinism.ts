// ===========================================
// `rust_test_nondeterminism` — unseeded RNG in Rust test spans (DW P0.4)
// ===========================================
// The Rust half of the determinism ban-list (the JS/TS half — Date.now /
// Math.random / crypto.randomUUID in test files — already ships as
// `test_nondeterminism`). Dicklesworthstone's `clippy.toml` disallows
// `rand::thread_rng` and `Uuid::new_v4` in his repos: both draw from
// process/OS entropy, so a test that asserts on their output is flaky and a
// replay can't reproduce a failure. Flag them ONLY inside a test span — a
// `tests/` integration file (whole file) or an inline `#[cfg(test)]` module
// (brace-matched) — so PRODUCTION randomness (legitimate) is never touched.
// post / warning / advisory (heuristic span detection).

import type { InlineMatch } from "./shared.js";

/** `rand::thread_rng()` / `thread_rng()` and `uuid::Uuid::new_v4()` /
 *  `Uuid::new_v4()` — the two entropy sources DW's clippy.toml bans. */
const RUST_NONDET_RE = /\b(?:rand::)?thread_rng\s*\(\s*\)|\b(?:uuid::)?Uuid::new_v4\s*\(\s*\)/;

/** Inclusive 1-based line ranges that are Rust TEST code. */
function rustTestSpans(lines: readonly string[], filePath: string): Array<[number, number]> {
	// Integration tests live under `tests/` — the whole file is test scope.
	if (/(?:^|\/)tests\//.test(filePath.replace(/\\/g, "/"))) return [[1, lines.length]];

	// Inline unit tests: each `#[cfg(test)]` mod, brace-matched from its `{`.
	const spans: Array<[number, number]> = [];
	for (let i = 0; i < lines.length; i++) {
		if (!/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(lines[i] ?? "")) continue;
		const openIdx = findModuleOpenBrace(lines, i);
		if (openIdx < 0) continue;
		const end = matchBrace(lines, openIdx);
		spans.push([i + 1, (end < 0 ? lines.length : end) + 1]);
		i = end < 0 ? lines.length : end;
	}
	return spans;
}

/** From the `#[cfg(test)]` line, find the line index of the `{` that opens the
 *  following `mod` block. Returns -1 if none within a few lines. */
function findModuleOpenBrace(lines: readonly string[], attrLine: number): number {
	for (let j = attrLine; j < Math.min(lines.length, attrLine + 4); j++) {
		if ((lines[j] ?? "").includes("{")) return j;
	}
	return -1;
}

/** Line index of the `}` matching the first `{` at/after `openLine`. -1 if
 *  unbalanced (fail-open: the caller then treats the span as running to EOF). */
function matchBrace(lines: readonly string[], openLine: number): number {
	let depth = 0;
	let started = false;
	for (let j = openLine; j < lines.length; j++) {
		for (const ch of stripLineComment(lines[j] ?? "")) {
			if (ch === "{") {
				depth++;
				started = true;
			} else if (ch === "}") {
				depth--;
				if (started && depth === 0) return j;
			}
		}
	}
	return -1;
}

/** Drop a `//` line comment (best-effort; string-embedded `//` is rare in the
 *  brace/RNG lines this scans and only risks a missed finding, not a false one). */
function stripLineComment(line: string): string {
	const idx = line.indexOf("//");
	return idx >= 0 ? line.slice(0, idx) : line;
}

/**
 * Flag `thread_rng()` / `Uuid::new_v4()` inside Rust test spans. Non-`.rs`
 * files and Rust files with no test span return nothing.
 */
export function checkRustTestDeterminism(content: string, filePath: string): InlineMatch[] {
	if (!filePath.endsWith(".rs")) return [];
	const lines = content.split("\n");
	const spans = rustTestSpans(lines, filePath);
	if (spans.length === 0) return [];

	const matches: InlineMatch[] = [];
	for (const [start, end] of spans) {
		for (let ln = start; ln <= end && matches.length < 10; ln++) {
			const code = stripLineComment(lines[ln - 1] ?? "");
			if (RUST_NONDET_RE.test(code)) {
				matches.push({ line: ln, text: code.trim().slice(0, 150) });
			}
		}
	}
	return matches;
}
