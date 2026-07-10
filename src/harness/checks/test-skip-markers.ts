// ===========================================
// Polyglot skipped/disabled-test markers
// ===========================================
// Single source of truth for three consumers: the `disabled_tests` inline
// check (js-ts-general.ts delegates here), the skipped-tests water-line
// counter (skipped-tests-policy.ts), and `interlinked adopt`'s seeding.
//
// Why: Bun's Rust-rewrite merge bar was "0 tests skipped or deleted"
// (docs/external-pulse/bun-in-rust.md §2.5) — and our skip detection was
// JS/TS + Swift only, so `@pytest.mark.skip`, Rust `#[ignore]`, and Go
// `t.Skip()` were invisible (docs/design/test-oracle-integrity.md §3.4).
//
// Deliberately conservative per language: only UNCONDITIONAL skips count.
// Conditional platform/dependency skips (`skipif`, `skipUnless`,
// `cfg_attr(…, ignore)`, `if testing.Short() { t.Skip() }`) are legitimate
// engineering, not oracle erosion, and are excluded by construction.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

/** Cap matches per file — mirrors checkDisabledTests' historical cap. */
const MAX_MARKERS_PER_FILE = 15;

interface SkipMarkerLanguage {
	/** Extensions this marker set applies to. */
	exts: readonly string[];
	/**
	 * Whether the file must look like a test file. Rust is `false`: `#[ignore]`
	 * only ever annotates `#[test]` fns, which live in ordinary `.rs` source
	 * files under `#[cfg(test)]` — there is no Rust test-file naming convention
	 * to predicate on (isStrictTestFile has no Rust rule; deliberate).
	 */
	requireTestFile: boolean;
	/** The unconditional-skip marker. Matched against comment/string-stripped lines. */
	marker: RegExp;
	/**
	 * When set and the marker line (or the line above) matches, the marker is
	 * treated as conditional and NOT counted (e.g. Go's `if testing.Short()`).
	 */
	guardExempt?: RegExp;
	/**
	 * Match against ORIGINAL lines instead of stripped ones. Needed for Rust:
	 * both shared strip helpers treat `#` as a comment starter (Python/shell
	 * style) and blank `#[ignore]` entirely. The Rust marker is line-anchored
	 * (`^\s*#\[…`), which by construction cannot match a `// prose` mention.
	 */
	matchOriginal?: boolean;
}

const SKIP_MARKER_LANGUAGES: readonly SkipMarkerLanguage[] = [
	{
		// Exact historical checkDisabledTests pattern — no JS/TS behavior change.
		exts: JS_TS_ALL_EXTS,
		requireTestFile: true,
		marker: /\b(?:it\.skip|describe\.skip|test\.skip|xit|xdescribe|xtest)\s*\(/,
	},
	{
		// Decorator forms only. `@pytest.mark.skipif` and `@unittest.skipIf` /
		// `skipUnless` are conditional; runtime `pytest.skip(...)` calls are
		// almost always platform guards — all excluded.
		exts: [".py"],
		requireTestFile: true,
		marker: /@pytest\.mark\.skip\b(?!if)|@unittest\.skip\b(?!If|Unless)/,
	},
	{
		exts: [".rs"],
		requireTestFile: false,
		marker: /^\s*#\[ignore\b/,
		// `#[cfg_attr(miri, ignore)]` and friends are conditional by definition.
		guardExempt: /cfg_attr/,
		matchOriginal: true,
	},
	{
		exts: [".go"],
		requireTestFile: true,
		marker: /\bt\.Skip(?:Now|f)?\s*\(/,
		// The dominant legitimate idiom: `if testing.Short() { t.Skip(...) }`.
		guardExempt: /\bif\b/,
	},
];

function languageFor(filePath: string): SkipMarkerLanguage | null {
	const ext = getExtension(filePath);
	for (const lang of SKIP_MARKER_LANGUAGES) {
		if (lang.exts.includes(ext)) return lang;
	}
	return null;
}

function lineIsExempt(lang: SkipMarkerLanguage, lines: string[], idx: number): boolean {
	if (!lang.guardExempt) return false;
	const line = lines[idx] ?? "";
	const prev = idx > 0 ? (lines[idx - 1] ?? "") : "";
	return lang.guardExempt.test(line) || lang.guardExempt.test(prev);
}

/**
 * Public API — every unconditional skip marker in the file, as InlineMatch[].
 * Consumed by `checkDisabledTests` (the `disabled_tests` inline check).
 */
export function findSkipMarkers(content: string, filePath: string): InlineMatch[] {
	const lang = languageFor(filePath);
	if (!lang) return [];
	if (lang.requireTestFile && !isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const scanLines = lang.matchOriginal
		? originalLines
		: stripCommentsAndStrings(content).split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < scanLines.length; i++) {
		if (matches.length >= MAX_MARKERS_PER_FILE) break;
		if (!lang.marker.test(scanLines[i] ?? "")) continue;
		if (lineIsExempt(lang, scanLines, i)) continue;
		matches.push({
			line: i + 1,
			text: (originalLines[i] ?? "").trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Public API — how many unconditional skip markers the file carries. The
 * skipped-tests water-line (skipped-tests-policy.ts) and `interlinked adopt`
 * count with exactly the same rules the check fires with, so the baseline and
 * the detector can never disagree about what a "skip" is.
 */
export function countSkippedTests(content: string, filePath: string): number {
	return findSkipMarkers(content, filePath).length;
}
