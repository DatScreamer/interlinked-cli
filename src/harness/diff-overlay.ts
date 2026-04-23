// ===========================================
// Diff-Overlay Pre-Block
// ===========================================
// Runs toolchain linters (biome + tsc) against the *proposed* file content
// before the write lands, compared against the cached diagnostics for the
// on-disk file. If the edit introduces NEW findings the overlay returns
// them so the evaluator can block the write with a targeted reason.
//
// Pre-existing findings are never blocked — that would trap agents on files
// that were already broken before they touched them. The gate only fires on
// net-new findings, which is the correct "you made it worse" signal.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { getOrCreateEngine } from "./check-engine/index.js";
import type { CheckResult } from "./check-engine/types.js";

const JS_TS_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;
const TS_OVERLAY_EXT = /\.(tsx?|mts|cts)$/;

export interface DiffOverlayResult {
	/** Findings present in the proposed content but not in the on-disk file. */
	newFindings: CheckResult[];
	/** Total wall-clock ms spent running the overlay (for budget/telemetry). */
	elapsedMs: number;
	/** True if latency exceeded the tool-specific budget — caller may demote to warn. */
	exceededBudget: boolean;
}

/**
 * Budget per tool. Biome's temp-file approach is quick (~200ms typical).
 * Tsc LS is slow on first call (warmup 1-3s) but very fast after
 * (~20-100ms). We set a generous budget — the agent latency cost of
 * catching a type regression is worth it.
 */
const BIOME_BUDGET_MS = 500;
const TSC_BUDGET_MS = 5_000;

/**
 * Key a CheckResult for set-diffing. We deliberately ignore column and
 * line so that a renumbered diagnostic (e.g. the line shifted) still
 * counts as the same pre-existing finding. Rule + file is the stable
 * identity. Message is included for tsc only, because the same TS code can
 * appear multiple times in a file with different subject text.
 */
function diagKey(r: CheckResult): string {
	if (r.tool === "tsc") {
		// For tsc, include message (normalized) so multiple distinct
		// type-errors with the same code (e.g. two different TS2345) aren't
		// collapsed.
		const normalized = (r.message || "").replace(/\s+/g, " ").trim().slice(0, 140);
		return `${r.file}:${r.ruleId ?? ""}:${r.severity}:${normalized}`;
	}
	return `${r.file}:${r.ruleId ?? ""}:${r.severity}`;
}

/**
 * Evaluate whether the proposed overlay content introduces new biome
 * findings relative to the file on disk.
 *
 * - If biome isn't configured for this project → returns empty (no gate).
 * - If extension isn't JS/TS family → returns empty.
 * - If file doesn't yet exist on disk (new-file Write) → returns empty;
 *   there's no "before" state to diff against, so we can't call any
 *   finding "new".
 */
export function evaluateBiomeDiffOverlay(
	filePath: string,
	proposedContent: string,
	projectRoot: string,
): DiffOverlayResult {
	const empty: DiffOverlayResult = {
		newFindings: [],
		elapsedMs: 0,
		exceededBudget: false,
	};

	if (!JS_TS_EXT.test(filePath)) return empty;
	if (!existsSync(filePath)) return empty;

	const engine = getOrCreateEngine(projectRoot);

	// Pre-edit diagnostics: use the cached getDiagnostics and filter to biome.
	const preEdit = engine.getDiagnostics(filePath).filter((r) => r.tool === "biome");

	// Short-circuit: content identical to disk (no-op edit) — nothing to diff.
	let onDisk = "";
	try {
		onDisk = readFileSync(filePath, "utf-8");
	} catch {
		return empty;
	}
	if (onDisk === proposedContent) return empty;

	const start = Date.now();
	const overlay = engine.getBiomeDiagnosticsForOverlay(
		filePath,
		proposedContent,
		BIOME_BUDGET_MS,
	);
	const elapsedMs = Date.now() - start;
	const exceededBudget = elapsedMs > BIOME_BUDGET_MS;

	const preKeys = new Set(preEdit.map(diagKey));
	const newFindings = overlay.filter((r) => !preKeys.has(diagKey(r)));

	return { newFindings, elapsedMs, exceededBudget };
}

// -------------------------------------------
// TSC LanguageService diff-overlay
// -------------------------------------------

/**
 * TS diagnostic codes that should DEMOTE to warning rather than block.
 * These are common during work-in-progress edits and routinely fixed by
 * the next edit — blocking on them makes iterative development painful.
 *
 * Everything else → block. (Conservative default: new type errors are
 * usually real.)
 */
const TSC_WARN_ONLY_CODES = new Set([
	"TS6133", // 'X' is declared but its value is never read
	"TS6196", // 'X' is declared but never used
	"TS6192", // All imports in import declaration are unused
	"TS6138", // Property 'X' is declared but its value is never read
	"TS2531", // Object is possibly 'null'
	"TS2532", // Object is possibly 'undefined'
	"TS18048", // 'X' is possibly 'undefined'
	"TS18047", // 'X' is possibly 'null'
]);

/** Pre-edit LS-diagnostic cache keyed by `${filePath}:${mtimeMs}` */
const preEditTscCache = new Map<string, CheckResult[]>();

function tscCacheKey(filePath: string): string {
	try {
		return `${filePath}:${statSync(filePath).mtimeMs}`;
	} catch {
		return `${filePath}:missing`;
	}
}

/**
 * Returns whether a new finding should block (true) or only warn (false).
 * Warn-only codes are returned from the check but surfaced as warnings
 * in the evaluator — the caller applies the policy.
 */
export function isTscFindingBlocking(f: CheckResult): boolean {
	return !TSC_WARN_ONLY_CODES.has(f.ruleId ?? "");
}

/**
 * Evaluate whether the proposed overlay content introduces new tsc
 * diagnostics relative to the file on disk.
 *
 * - Uses the TypeScript LanguageService (via tsc-overlay runner) for both
 *   the pre-edit and proposed snapshots to ensure identical diagnostic
 *   semantics on both sides of the diff.
 * - Caches the pre-edit result by `(filePath, mtime)` so unchanged files
 *   don't re-run semantic analysis on every overlay call.
 * - New-file Writes (no disk state) return empty — nothing to diff against.
 */
export function evaluateTscDiffOverlay(
	filePath: string,
	proposedContent: string,
	projectRoot: string,
): DiffOverlayResult {
	const empty: DiffOverlayResult = {
		newFindings: [],
		elapsedMs: 0,
		exceededBudget: false,
	};

	if (!TS_OVERLAY_EXT.test(filePath)) return empty;
	if (!existsSync(filePath)) return empty;

	let onDisk = "";
	try {
		onDisk = readFileSync(filePath, "utf-8");
	} catch {
		return empty;
	}
	if (onDisk === proposedContent) return empty;

	const engine = getOrCreateEngine(projectRoot);

	// Pre-edit snapshot via LS overlay against disk content. Cached so we
	// don't re-run for every edit to the same file.
	const cacheKey = tscCacheKey(filePath);
	let preEdit = preEditTscCache.get(cacheKey);
	if (!preEdit) {
		preEdit = engine.getTscDiagnosticsForOverlay(filePath, onDisk);
		preEditTscCache.set(cacheKey, preEdit);
	}

	const start = Date.now();
	const overlay = engine.getTscDiagnosticsForOverlay(filePath, proposedContent);
	const elapsedMs = Date.now() - start;
	const exceededBudget = elapsedMs > TSC_BUDGET_MS;

	const preKeys = new Set(preEdit.map(diagKey));
	const newFindings = overlay.filter((r) => !preKeys.has(diagKey(r)));

	return { newFindings, elapsedMs, exceededBudget };
}

/** Test-only reset of the underlying engine cache, not the overlay itself. */
export function _resetEngineCacheForTest(): void {
	// Helpful for unit tests that rebuild file state between cases.
	const eng = getOrCreateEngine(process.cwd());
	eng.clearCache();
}

/** Exported for tests — strip extension check, used internally. */
export function _isJsTsExt(filePath: string): boolean {
	return JS_TS_EXT.test(extname(filePath) ? filePath : "");
}
