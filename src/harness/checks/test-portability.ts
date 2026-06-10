// ===========================================
// Test portability — env-divergent test detection (finding 2026-06)
// ===========================================
// Born from a red CI run that local validation could not see: two tests passed
// on the dev Mac and failed on every CI runner. Both had a deterministic
// as-written signature this family now catches at edit time:
//
//   1. PLATFORM-CONDITIONAL NARRATION — a comment inside a test admits the
//      fixture behaves differently per platform ("On platforms where the temp
//      dir lives under a symlink…", "macOS-only") while the file never gates on
//      `process.platform` / `skipIf` / `runIf`. The assertion then encodes ONE
//      platform's outcome and fails on the others (the config-loosening test
//      leaned on macOS's /tmp symlink; on Linux the gate legitimately fired).
//      Fix: construct the condition explicitly (own symlink / fixture) or gate
//      the test on the platform it describes.
//
//   2. SILENT DEPENDENCY SKIP — `if (!X_AVAILABLE) return;` at the top of a
//      test records a PASS where the external binary is missing. On CI (no
//      ripgrep) nine such tests "passed" while running nothing — coverage
//      theater that hid the dependency gap until an unguarded sibling failed.
//      Fix: `it.skipIf(!X_AVAILABLE)(…)` so the skip is REPORTED and the
//      missing dependency is visible in every run's summary.

import { type InlineMatch, isTestFile } from "./shared.js";

/** Comment phrases that admit platform-variant behavior. Deliberately tight —
 *  neutral mentions ("works on every platform") must not fire. */
const PLATFORM_NARRATION_RES: readonly RegExp[] = [
	/\bon platforms? where\b/i,
	/\bplatform-(?:dependent|specific)\b/i,
	/\b(?:macos|os x|darwin|linux|windows)[- ]only\b/i,
	/\bonly on (?:macos|os x|darwin|linux|windows)\b/i,
];

/** Evidence the file actually gates on platform / environment somewhere. */
const PLATFORM_GATE_RE = /process\.platform|\.skipIf\s*\(|\.runIf\s*\(/;

/** A comment-ish line: `//`, `*` continuation, or `/*` opener. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Flag test files whose comments NARRATE platform-conditional behavior while
 * nothing in the file branches on it — the assertions silently encode one
 * platform's outcome. One match per narrating line.
 */
export function checkPlatformConditionalAssertion(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (PLATFORM_GATE_RE.test(content)) return []; // the file IS platform-aware
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!COMMENT_LINE_RE.test(line)) continue;
		if (!PLATFORM_NARRATION_RES.some((re) => re.test(line))) continue;
		matches.push({
			line: i + 1,
			text:
				"[comment narrates platform-conditional behavior but the file never gates on it — " +
				"the assertions encode ONE platform's outcome and will fail on the others (CI). " +
				"Construct the condition explicitly in the fixture, or gate with " +
				`skipIf/process.platform] ${line.trim().slice(0, 100)}`,
		});
	}
	return matches;
}

/** The silent availability guard: `if (!X_AVAILABLE) return;` (also the
 *  `=== null` / `=== false` spellings, flag or nullary call, inline or on its
 *  own line). The IDENTIFIER is the discriminator — only names that END in
 *  `_AVAILABLE`/`Available` match, so ordinary data-shaped early returns
 *  (`if (!result) return;`) never fire. */
const SILENT_SKIP_RES: readonly RegExp[] = [
	/\bif\s*\(\s*!\s*[A-Za-z_$][\w$]*(?:_AVAILABLE|Available)\s*(?:\(\s*\)\s*)?\)\s*return\b/,
	/\bif\s*\(\s*[A-Za-z_$][\w$]*(?:_AVAILABLE|Available)\s*(?:\(\s*\)\s*)?===?\s*(?:null|false)\s*\)\s*return\b/,
];

/**
 * Flag the silent early-return availability guard in test files. The guard
 * records a PASS where the dependency is absent — every environment without
 * the binary reports green while running nothing. `it.skipIf(...)` reports the
 * skip instead, so a dependency gap is visible in the run summary (the runtime
 * catch CI needs). One match per guard line.
 */
export function checkSilentDependencySkip(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!SILENT_SKIP_RES.some((re) => re.test(line))) continue;
		matches.push({
			line: i + 1,
			text:
				"[silent dependency skip — this early return records a PASS wherever the " +
				"dependency is missing (CI included), hiding the gap. Use it.skipIf(...)/" +
				`describe.skipIf(...) so the skip is REPORTED] ${line.trim().slice(0, 100)}`,
		});
	}
	return matches;
}
