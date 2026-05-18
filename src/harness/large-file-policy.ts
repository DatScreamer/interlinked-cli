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
// (1500 -> 1200 -> 1000 as the grandfather list empties) is a one-number
// edit, not a code change.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isGeneratedFile } from "./checks/shared.js";

/**
 * Default per-file line cap, used when no baseline file overrides it.
 *
 * Deliberately high. Line count is a coarse proxy for the real cost — agent
 * legibility and edit reliability — so the ENFORCED cap sits well above the
 * ~300-500 line aspirational module size: a gate that false-alarms gets
 * ignored. The fine-grained `complexity` / `cyclomatic` checks do the
 * nuanced "is this file actually bad" work. Ratchet this downward via
 * `max_lines` in the baseline file as the grandfather list shrinks.
 */
export const DEFAULT_MAX_LINES = 1500;

/** Repo-relative path of the baseline file. Module-private — callers go
 *  through `loadLargeFileBaseline` / `maxLinesFor`. */
const LARGE_FILE_BASELINE_REL = ".interlinked/large-files-baseline.json";

/**
 * Extensions where a high line count is not a code-legibility problem:
 * prose/docs, structured data, lockfiles, vector art, minified bundles.
 * Module-private — reached via `isCappableFile`.
 */
const FILE_SIZE_SKIP_EXT_RE =
	/\.(?:md|mdx|markdown|txt|rst|adoc|json|jsonc|json5|jsonl|ndjson|ya?ml|toml|csv|tsv|lock|log|svg|min\.[a-z]+)$/i;

/**
 * Path markers for generated code: a `.gen.`/`.generated.` infix on a
 * source file, or a `generated/` / `__generated__/` directory segment.
 * Module-private — reached via `isCappableFile`.
 */
const GENERATED_PATH_RE =
	/(?:\.gen|\.generated)\.(?:tsx?|jsx?|mjs|cjs|py)$|\/(?:generated|__generated__)\//;

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

/** The active line cap for `cwd` (baseline override, else the default). */
export function maxLinesFor(cwd: string): number {
	return loadLargeFileBaseline(cwd)?.max_lines ?? DEFAULT_MAX_LINES;
}

/** Line count, consistent with the long-standing `checkLargeFile` definition. */
export function countLines(content: string): number {
	return content.split("\n").length;
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
 * Whether the per-file line cap applies to this file. True only for
 * hand-written code modules: generated files (by path or content marker),
 * `.d.ts` declarations, test/spec files, and non-code files are exempt.
 */
export function isCappableFile(file: { filePath: string; content: string }): boolean {
	const norm = file.filePath.replace(/\\/g, "/");
	if (norm.endsWith(".d.ts")) return false;
	if (FILE_SIZE_SKIP_EXT_RE.test(norm)) return false;
	if (GENERATED_PATH_RE.test(norm)) return false;
	if (isTestOrSpecPath(norm)) return false;
	if (isGeneratedFile(file.content)) return false;
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
}): LargeFileVerdict {
	const max = args.baseline?.max_lines ?? DEFAULT_MAX_LINES;
	const recorded = args.baseline?.files?.[args.relPath.replace(/\\/g, "/")];
	const overCap = args.lines > max;
	const ceiling = recorded !== undefined && recorded > max ? recorded : max;
	// Grandfathered: listed in the baseline AND not grown past its recorded
	// size. A grandfathered file that shrank to <= max is simply under the
	// cap (overCap false) and needs no special-casing.
	const grandfathered = overCap && recorded !== undefined && args.lines <= recorded;
	return { lines: args.lines, overCap, grandfathered, ceiling };
}
