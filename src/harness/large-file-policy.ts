// ===========================================
// Large-file policy — the single source of truth for the per-file line cap
// ===========================================
// One module, consumed by three surfaces:
//   - PreToolUse  : `checkLargeFileLineCountWrite` (pre-checks.ts) blocks a
//                   Write/Edit that grows a capped file past the cap.
//   - PostToolUse : the `[interlinked:file-size]` nudge (evaluator/post-tool.ts).
//   - verify      : the `large_files` check (commands/verify/file-checks.ts).
//
// The cap applies only to HAND-WRITTEN CODE MODULES. Generated files, .d.ts
// declarations, test/spec files, and non-code files (docs, structured data,
// lockfiles, vector art) are exempt — a high line count there is not a
// code-legibility signal.
//
// The active cap and the grandfather list live in a checked-in JSON file,
// `.interlinked/large-files-baseline.json`, so lowering the cap over time
// (1500 -> 1200 -> 1000 -> 800 as the grandfather list empties) is a one-number
// edit, not a code change.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isGeneratedFile } from "./checks/shared.js";
import { maxLinesOverride } from "./metric-caps.js";

/**
 * Default per-file line cap, used when no baseline file overrides it.
 *
 * THE canonical cap. This constant and the committed baseline's `max_lines`
 * (.interlinked/large-files-baseline.json) are the SAME number — a regression
 * test in `large-file-policy.test.ts` pins them equal so the cap can never be
 * two different values depending on whether a baseline loaded. `maxLinesFor`
 * returns the baseline value when present and falls back to this constant when
 * absent; keeping them equal means the fallback is never a *different* cap.
 *
 * Line count is a coarse proxy for the real cost — agent legibility and edit
 * reliability — so the cap sits above the ~300-500 line aspirational module
 * size: a gate that false-alarms gets ignored. The fine-grained `complexity` /
 * `cyclomatic` checks do the nuanced "is this file actually bad" work. To
 * ratchet the cap down (800 → 500 → …) as the grandfather list shrinks,
 * change BOTH this constant and the baseline's `max_lines` together — the
 * pinning test enforces it and the change shows up in one diff.
 */
export const DEFAULT_MAX_LINES = 500;

/** Repo-relative path of the baseline file. Module-private — callers go
 *  through `loadLargeFileBaseline` / `maxLinesFor`. */
const LARGE_FILE_BASELINE_REL = ".interlinked/large-files-baseline.json";

/**
 * Extensions where a high line count is not a code-legibility problem:
 * prose/docs, structured data, lockfiles, vector art, minified bundles.
 * Module-private — reached via `isCappableFile`.
 */
const FILE_SIZE_SKIP_EXT_RE =
	/\.(?:md|mdx|markdown|txt|rst|adoc|json|jsonc|json5|jsonl|ndjson|ya?ml|toml|csv|tsv|lock|log|diff|patch|svg|min\.[a-z]+)$/i;

/**
 * Path markers for generated code: a `.gen.`/`.generated.` infix on a
 * source file, or a `generated/` / `__generated__/` directory segment.
 * Module-private — reached via `isCappableFile`.
 */
const GENERATED_PATH_RE =
	/(?:\.gen|\.generated)\.(?:tsx?|jsx?|mjs|cjs|py)$|\/(?:generated|__generated__)\//;

/**
 * The harness's own state directory. `.interlinked/` holds append-only logs,
 * the trigram index, archives, merge-patches, e2e probe scripts, and workflow
 * scratch — tool state and operational scripts, never product source modules.
 * A line/char count there measures an artifact, not module complexity, so the
 * cap never applies (the same reasoning that exempts `.git/`, `node_modules/`,
 * `dist/`). Matches a real `.interlinked/` path segment only — an ordinary
 * `interlinked/` source dir (no leading dot) stays cappable.
 */
const TOOL_STATE_PATH_RE = /(?:^|\/)\.interlinked\//;

/** Per-file line cap config + grandfather list. */
export interface LargeFileBaseline {
	/** Schema version. */
	version: number;
	/** Active line cap. Files over this fail the gate / block the write. */
	max_lines: number;
	/**
	 * Grandfathered offenders: repo-relative POSIX path -> recorded line
	 * count. A listed file may shrink or hold but not grow past its
	 * recorded count; drop it below `max_lines` to remove the entry.
	 */
	files: Record<string, number>;
}

let baselineCache = new Map<string, LargeFileBaseline | null>();

/**
 * Load `.interlinked/large-files-baseline.json` for `cwd`. Memoized per
 * cwd (cheap for verify's hundreds of per-file calls). Fail-soft: a
 * missing or malformed file yields `null` — callers fall back to
 * `DEFAULT_MAX_LINES` with no grandfathering.
 *
 * The cache is process-lifetime; the harness daemon picks up baseline
 * edits on restart (the standard post-edit `harness restart` flow).
 * Tests can force a reload via `resetLargeFileBaselineCache()`.
 */
export function loadLargeFileBaseline(cwd: string): LargeFileBaseline | null {
	const cached = baselineCache.get(cwd);
	if (cached !== undefined) return cached;

	let result: LargeFileBaseline | null = null;
	try {
		const path = join(cwd, LARGE_FILE_BASELINE_REL);
		if (existsSync(path)) {
			// `: unknown` annotation (not an `as` cast) narrows JSON.parse's
			// `any` return to `unknown` — normalizeBaseline validates it.
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			result = normalizeBaseline(raw);
		}
	} catch {
		result = null; // malformed JSON -> default cap, no grandfathering
	}
	baselineCache.set(cwd, result);
	return result;
}

/** Expected raw shape of a parsed baseline file — every field is `unknown`
 *  until validated by `normalizeBaseline`. */
interface RawBaseline {
	version?: unknown;
	max_lines?: unknown;
	files?: unknown;
}

/** Validate + normalize a parsed baseline; returns null when unusable. */
function normalizeBaseline(raw: unknown): LargeFileBaseline | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as RawBaseline;
	if (typeof obj.max_lines !== "number" || obj.max_lines <= 0) return null;
	const files: Record<string, number> = {};
	if (typeof obj.files === "object" && obj.files !== null) {
		for (const [key, value] of Object.entries(obj.files)) {
			if (typeof value === "number" && value > 0) {
				files[key.replace(/\\/g, "/")] = value;
			}
		}
	}
	return {
		version: typeof obj.version === "number" ? obj.version : 1,
		max_lines: obj.max_lines,
		files,
	};
}

/** Clear the memoized baseline (after writing/regenerating the file). */
export function resetLargeFileBaselineCache(): void {
	baselineCache = new Map();
}

/**
 * Persist a baseline to `.interlinked/large-files-baseline.json` for `cwd`.
 * The writer half of `loadLargeFileBaseline` — until now the only creation
 * path was ad-hoc scripts (this repo's own list was hand-built). Used by
 * `interlinked adopt`, the human-invoked ratchet-from-here bootstrap: plain
 * `fs` writes from the CLI process never pass through the PreToolUse
 * baseline-integrity gate (the same carve-out coverage-ratchet.ts relies on).
 *
 * Grandfather entries are written key-sorted so re-runs produce stable,
 * diff-friendly output, and the memoized loader cache is invalidated so a
 * subsequent `loadLargeFileBaseline` in the same process sees the new state.
 * DIRECTION is the caller's contract: pass entries that hold or tighten the
 * existing water-line (`interlinked adopt` keeps the min of recorded vs
 * current) — this function is a dumb serializer, not a policy check.
 */
export function saveLargeFileBaseline(cwd: string, baseline: LargeFileBaseline): void {
	const path = join(cwd, LARGE_FILE_BASELINE_REL);
	mkdirSync(dirname(path), { recursive: true });
	const files: Record<string, number> = {};
	const entries = Object.entries(baseline.files).sort(([a], [b]) => a.localeCompare(b));
	for (const [key, value] of entries) {
		files[key.replace(/\\/g, "/")] = value;
	}
	const payload = { version: baseline.version, max_lines: baseline.max_lines, files };
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	resetLargeFileBaselineCache();
}

/** The active line cap for `cwd`. Precedence: `.interlinked/metric-caps.json`
 *  (`max_lines`, the unified `interlinked caps` surface) → the large-files
 *  baseline (legacy, also carries the grandfather list) → the shipped default. */
export function maxLinesFor(cwd: string): number {
	return maxLinesOverride(cwd) ?? baselineOrDefaultLineCap(cwd);
}

/** The line cap from the large-files baseline (legacy source + grandfather
 *  list owner), or the shipped default when no baseline file is present. */
function baselineOrDefaultLineCap(cwd: string): number {
	return loadLargeFileBaseline(cwd)?.max_lines ?? DEFAULT_MAX_LINES;
}

/** Line count, consistent with the long-standing `checkLargeFile` definition. */
export function countLines(content: string): number {
	return content.split("\n").length;
}

/** Scanner state for `countCodeLines` — threaded through the per-character
 *  helpers so comment/string context survives newlines. */
interface CodeLineScanState {
	/** Inside a block comment (spans lines). */
	inBlockComment: boolean;
	/** Inside a `//` line comment (resets at each newline). */
	inLineComment: boolean;
	/** Open string delimiter (', ", or backtick), or null. Only the backtick
	 *  (template literal) spans lines. */
	stringDelim: string | null;
	/** Current line carries at least one code character. */
	lineHasCode: boolean;
	/** Completed lines that carried code. */
	codeLines: number;
}

/** Finalize the current line for `countCodeLines`: count it when it carried
 *  code, reset per-line state. Single/double-quoted strings do not span lines
 *  (an unterminated one is a syntax error anyway) — only template literals and
 *  block comments carry state over. */
function endCodeLine(s: CodeLineScanState): void {
	if (s.lineHasCode) s.codeLines++;
	s.lineHasCode = false;
	s.inLineComment = false;
	if (s.stringDelim === "'" || s.stringDelim === '"') s.stringDelim = null;
}

/** Consume one non-newline character for `countCodeLines`. Returns the number
 *  of EXTRA characters consumed (0 or 1 — two-char comment tokens, escapes). */
function scanCodeLineChar(content: string, i: number, s: CodeLineScanState): number {
	const ch = content.charAt(i);
	const next = content.charAt(i + 1);
	if (s.inLineComment) return 0;
	if (s.inBlockComment) {
		if (ch === "*" && next === "/") {
			s.inBlockComment = false;
			return 1;
		}
		return 0;
	}
	if (s.stringDelim !== null) {
		s.lineHasCode = true; // string/template content is code (data), never comment
		if (ch === "\\" && next !== "\n") return 1; // escape consumes the next char
		if (ch === s.stringDelim) s.stringDelim = null;
		return 0;
	}
	if (ch === "/" && next === "/") {
		s.inLineComment = true;
		return 1;
	}
	if (ch === "/" && next === "*") {
		s.inBlockComment = true;
		return 1;
	}
	if (ch === "'" || ch === '"' || ch === "`") {
		s.stringDelim = ch;
		s.lineHasCode = true;
		return 0;
	}
	if (!/\s/.test(ch)) s.lineHasCode = true;
	return 0;
}

/**
 * Comment-aware sibling of `countLines` (the ONE canonical raw counter): the
 * number of lines carrying any CODE — i.e. not blank, not a `//` line
 * comment, and not (part of) a block comment. String-aware: comment markers
 * inside string/template literals do not open comments, and string/template
 * content lines count as code (an embedded data table IS the module's bulk).
 * Regex literals are not tracked (a literal like `/[/+]/` can misread as a
 * comment opener) — the same accepted limitation as the checks/ strippers.
 *
 * Consumed by the PreToolUse line-cap gate (`checkLargeFileLineCountWrite`)
 * for its comment-only-growth exemption: an edit that grows a file's RAW
 * line count but not its CODE line count is documentation, not code growth,
 * and is allowed even on an over-cap/grandfathered file. Deliberate
 * grandfather interaction: the recorded ceilings in
 * `large-files-baseline.json` keep tracking RAW lines and are NEVER raised
 * by that allowance (ceilings may only shrink — the baseline-integrity gate
 * enforces it), so sustained comment growth on a grandfathered file can push
 * its raw count past the recorded ceiling and surface in verify's
 * `large_files` check; the remedy there is decomposition, never a ceiling
 * raise.
 */
export function countCodeLines(content: string): number {
	const s: CodeLineScanState = {
		inBlockComment: false,
		inLineComment: false,
		stringDelim: null,
		lineHasCode: false,
		codeLines: 0,
	};
	for (let i = 0; i < content.length; i++) {
		if (content.charAt(i) === "\n") {
			endCodeLine(s);
			continue;
		}
		i += scanCodeLineChar(content, i, s);
	}
	endCodeLine(s);
	return s.codeLines;
}

/**
 * Test/spec file detection — purely path/filename based.
 *
 * Deliberately NOT `checks/shared.ts::isTestFile`: that function also
 * treats interlinked-cli's own `harness/checks/`, `harness/check-registry/`
 * etc. as "test files" (a content-scan FP exemption for detector files
 * that hold scary patterns as DATA). A line count is a line count
 * regardless — `check-registry/entries-warnings.ts` being 1763 lines is a
 * real fact — so the cap must use a narrow, exemption-free predicate.
 */
export function isTestOrSpecPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (/(?:^|\/)(?:__tests__|tests?)\//.test(norm)) return true;
	const name = norm.split("/").pop() || "";
	if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
	if (/_test\.(?:py|go)$/.test(name)) return true;
	if (/Tests?\.(?:java|swift)$/.test(name)) return true;
	if (name.startsWith("test_") && /\.(?:py|swift)$/.test(name)) return true;
	return false;
}

/**
 * Content marker that exempts a file from the per-file line cap WITHOUT marking
 * it `@generated` everywhere. For hand-maintained codegen-DATA modules whose
 * bulk is a large template string or data table emitted verbatim into generated
 * output (e.g. the `.mjs` hook-script chunks under `src/lib/hook-template-chunks/`
 * and `src/lib/hooks-template.ts`): there the line count measures the size of
 * the emitted artifact, not module complexity, so the cap is a false signal.
 * Sharding such a file scatters one artifact across modules for no legibility
 * win and adds byte-identical-output invariants — exempting it is the right call.
 *
 * Unlike `@generated` — which `isGeneratedFile` uses to suppress many OTHER
 * checks — this marker is scoped to the line cap alone: tsc/lint/secrets/etc.
 * still run on the file. Bounded scan: first 20 lines only (mirrors
 * `isGeneratedFile`), so the marker must sit in the file header, never buried
 * in the data body.
 */
const CODEGEN_DATA_MARKER = "@codegen-data";

function hasCodegenDataMarker(content: string): boolean {
	return content.split("\n", 20).join("\n").includes(CODEGEN_DATA_MARKER);
}

/**
 * Whether the per-file line cap applies to this file. True only for
 * hand-written code modules. Exempt: `.interlinked/` tool-state/probe files,
 * generated files (by path or content marker), codegen-DATA modules (a
 * `@codegen-data` header marker), `.d.ts` declarations, test/spec files, and
 * non-code files (docs, structured data, diffs/patches, vector art).
 */
export function isCappableFile(file: { filePath: string; content: string }): boolean {
	const norm = file.filePath.replace(/\\/g, "/");
	if (norm.endsWith(".d.ts")) return false;
	if (TOOL_STATE_PATH_RE.test(norm)) return false;
	if (FILE_SIZE_SKIP_EXT_RE.test(norm)) return false;
	if (GENERATED_PATH_RE.test(norm)) return false;
	if (isTestOrSpecPath(norm)) return false;
	if (isGeneratedFile(file.content)) return false;
	if (hasCodegenDataMarker(file.content)) return false;
	return true;
}

/** Verify-side verdict for a static file snapshot. */
export interface LargeFileVerdict {
	lines: number;
	/** Over the active cap. */
	overCap: boolean;
	/** In the baseline and within its recorded ceiling — does not fail the gate. */
	grandfathered: boolean;
	/** Highest line count this file may reach without failing: the cap, or
	 *  its baseline ceiling if higher. */
	ceiling: number;
}

/**
 * Judge a static file snapshot against the cap + grandfather list. Used by
 * the `large_files` verify check. The PreToolUse block does NOT use this —
 * it works on a live before/after delta (see `checkLargeFileLineCountWrite`).
 */
export function evaluateLargeFile(args: {
	relPath: string;
	lines: number;
	baseline: LargeFileBaseline | null;
	/**
	 * The EFFECTIVE cap to enforce — pass `maxLinesFor(cwd)` so the
	 * `.interlinked/metric-caps.json` override (the unified `interlinked caps set
	 * lines` surface) is honored. When omitted, falls back to the baseline's
	 * `max_lines` then the shipped default. `verify` previously called this
	 * WITHOUT the override, so a lowered cap was silently ignored by `verify`
	 * while still blocking writes / nudging (finding 2026-06, round 8). The
	 * grandfather list is always read from `baseline.files` regardless.
	 */
	maxLines?: number;
}): LargeFileVerdict {
	const max = args.maxLines ?? args.baseline?.max_lines ?? DEFAULT_MAX_LINES;
	const recorded = args.baseline?.files?.[args.relPath.replace(/\\/g, "/")];
	const overCap = args.lines > max;
	const ceiling = recorded !== undefined && recorded > max ? recorded : max;
	// Grandfathered: listed in the baseline AND not grown past its recorded
	// size. A grandfathered file that shrank to <= max is simply under the
	// cap (overCap false) and needs no special-casing.
	const grandfathered = overCap && recorded !== undefined && args.lines <= recorded;
	return { lines: args.lines, overCap, grandfathered, ceiling };
}
