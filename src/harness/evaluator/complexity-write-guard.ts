// ===========================================
// PreToolUse gate — per-function cyclomatic cap (strict, no override)
// ===========================================
// Blocks a Write/Edit/MultiEdit/apply_patch that would push a function's
// cyclomatic complexity past the cap. DELTA semantics, mirroring the line-cap
// gate (`checkLargeFileLineCountWrite`): an edit that holds or reduces an
// already-complex function is always allowed — the refactor-down path — so the
// on-disk before-state is the implicit ratchet baseline. Only a NEW over-cap
// function, or RAISING an existing function past the cap, is blocked.
//
// Dispatch is per-language: `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts` parse with
// the TS AST (`computeCyclomaticAst`); `.py` parses with radon
// (`computeCyclomaticPython`); every other extension is skipped. The block
// contract (`DEFAULT_MAX_CYCLOMATIC`, delta semantics, no override) is identical
// across languages — only the per-function counter differs.
//
// There is deliberately NO escape hatch / suppression: an agent-writable
// override gets gamed (the agent would suppress every file it wants to grow),
// which defeats the gate. The only way past is to decompose.
//
// Because a no-override block has no relief valve for a false positive, it runs
// ONLY when the analyzer is available (the optional `typescript` dep for JS/TS,
// `radon` on PATH for Python — both present in a normal install). Without it the
// gate fails open — a heuristic count would risk FP-blocking legitimate code
// with no recourse. The unavailability is surfaced LOUDLY, never silently: the
// TS path warns at daemon startup (`astComplexityAvailable()` in server.ts); the
// Python path has no startup probe (radon is per-repo), so a `.py` edit that
// can't be analyzed emits a one-shot stderr degrade here.
// Codex/Copilot `apply_patch` payloads are reconstructed to post-edit content
// via the conservative V4A applier (fail-open on any uncertainty), so they no
// longer bypass the gate by carrying their edit in the patch body.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import {
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "../apply-patch-content.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import { isCappableFile } from "../large-file-policy.js";
import { maxCyclomaticFor } from "../metric-caps.js";

/**
 * Per-function cyclomatic cap — the agreed hard "bad" line. One number for now;
 * a future ratchet baseline (like `.interlinked/large-files-baseline.json`) can
 * lower it (25 → 15 → …) as the codebase's hotspots are decomposed.
 */
export const DEFAULT_MAX_CYCLOMATIC = 25;

/**
 * Per-edit sub-cap SLEW tolerance. A uniquely-named function that stays at or
 * below the cap may rise by AT MOST this many branches in a single edit; a
 * larger one-edit jump blocks (decompose, then retry). This relaxes the former
 * strict "may not increase at all" sub-cap ratchet into a per-edit rate limit:
 * a small incremental rise *toward* — but never *past* — the cap is acceptable,
 * while a big leap in one edit is the smell worth catching.
 *
 * The hard cap (`maxCyclomaticFor`) is unchanged and remains the END-STATE
 * backstop: no edit may leave a function over the cap regardless of how small
 * the rise (a within-tolerance bump that crosses the cap is caught by the
 * over-cap path, not here). Many small rises across several edits can still walk
 * a function toward the cap — that is the accepted trade (the cap is the ceiling
 * the slew limit only governs how fast you may approach it).
 *
 * CRAP inherits this automatically: CRAP is monotonic in cyclomatic, so a
 * bounded cyclomatic rise is a bounded CRAP rise, and CRAP's own cap (30) stays
 * its end-state backstop. There is deliberately no separate sub-cap CRAP ratchet
 * — every CRAP gate (`decideCrap` block, `computeCrapRisers` advisory) fires
 * only at/over 30 — so nothing on the CRAP side needs loosening.
 *
 * Set to 1 for a tighter "+1 per edit" policy. A future per-repo override can
 * live alongside `maxCyclomaticFor` in `.interlinked/metric-caps.json`.
 */
export const SUB_CAP_RATCHET_TOLERANCE = 2;

const JS_TS_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const PY_RE = /\.py$/;
/** AST entries with this name are anonymous — not matchable across before/after. */
const ANON_FN = "(callback)";

export interface ComplexityWriteBlock {
	block: string;
}

/**
 * Telemetry observer — receives the before/after entries the gate already
 * parsed for every analyzed file, plus the projected after-content (for
 * content-hash matching at PostToolUse). Observation only: it never affects
 * the block decision. Wired to the cyclomatic pulse (complexity-pulse.ts).
 */
export type ComplexityObserver = (
	filePath: string,
	beforeFns: FunctionComplexityEntry[],
	afterFns: FunctionComplexityEntry[],
	afterContent: string,
) => void;

/** A per-function cyclomatic counter for one language. Returns `null` (the loud
 *  "analyzer unavailable" signal — see cyclomatic-ast/cyclomatic-python) when the
 *  backing parser is absent, which the caller fails open on. */
type CyclomaticAnalyzer = (content: string, filePath: string) => FunctionComplexityEntry[] | null;

/**
 * Pick the cyclomatic analyzer for a path, or null to skip (non-code extension).
 * `language` tags the loud-degrade message; the block contract is identical
 * regardless. JS/TS uses the in-process TS AST; Python shells to radon.
 * Exported for the pulse's stash-miss fallback parse (complexity-pulse.ts).
 */
export function selectAnalyzer(
	filePath: string,
): { compute: CyclomaticAnalyzer; language: "js_ts" | "python" } | null {
	if (JS_TS_RE.test(filePath)) return { compute: computeCyclomaticAst, language: "js_ts" };
	if (PY_RE.test(filePath)) return { compute: computeCyclomaticPython, language: "python" };
	return null;
}

/**
 * Surface a per-edit analyzer-unavailable degrade for languages without a
 * daemon-startup probe (Python: radon is per-repo, so server.ts can't warn up
 * front the way it does for `typescript`). Fired once per process to stay loud
 * but not naggy; the gate still fails open (no false block), matching the TS
 * fallback — the warning is the "not silent" half of the contract.
 */
let pythonDegradeWarned = false;

/** Test-only reset of the once-per-process degrade-warning latch, so a suite can
 *  assert the loud-degrade fires deterministically regardless of test order
 *  (mirrors `__resetTsCacheForTesting` in cyclomatic-ast.ts). */
export function __resetPythonDegradeWarningForTesting(): void {
	pythonDegradeWarned = false;
}

function warnAnalyzerUnavailable(language: "js_ts" | "python"): void {
	// JS/TS degrade is already announced at daemon startup (astComplexityAvailable
	// in server.ts); only Python needs a per-edit surface.
	if (language !== "python" || pythonDegradeWarned) return;
	pythonDegradeWarned = true;
	process.stderr.write(
		"[interlinked] WARNING: `radon` is not resolvable — the strict cyclomatic " +
			"PreToolUse gate for Python (.py) is degraded and cannot enforce the " +
			`${DEFAULT_MAX_CYCLOMATIC}-branch cap. Install it (e.g. \`pip install radon\`) ` +
			"in this repo to restore enforcement. Edits are allowed meanwhile (fail-open).\n",
	);
}

function resolveFilePath(toolInput: JsonObject): string {
	return (
		(typeof toolInput.file_path === "string" && toolInput.file_path) ||
		(typeof toolInput.path === "string" && toolInput.path) ||
		""
	);
}

function safeRead(abs: string): string | null {
	try {
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

/** Apply one old→new replacement (first occurrence, or all when replace_all). */
function applyEdit(text: string, oldStr: string, newStr: string, all: boolean): string {
	if (all) return text.split(oldStr).join(newStr);
	const idx = text.indexOf(oldStr);
	return idx === -1 ? text : text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
}

/** Materialize before/after content for a Write/Edit/MultiEdit, else null. */
function projectContent(
	toolInput: JsonObject,
	abs: string,
): { before: string; after: string } | null {
	const before = existsSync(abs) ? safeRead(abs) : "";
	if (before === null) return null;

	if (typeof toolInput.content === "string") {
		return { before, after: toolInput.content };
	}
	if (typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
		if (before === "") return null; // Edit needs an existing file
		const all = toolInput.replace_all === true;
		return { before, after: applyEdit(before, toolInput.old_string, toolInput.new_string, all) };
	}
	if (Array.isArray(toolInput.edits)) {
		if (before === "") return null;
		let after = before;
		for (const raw of toolInput.edits) {
			if (typeof raw !== "object" || raw === null) continue;
			const e = raw as JsonObject;
			if (typeof e.old_string !== "string" || typeof e.new_string !== "string") continue;
			after = applyEdit(after, e.old_string, e.new_string, e.replace_all === true);
		}
		return { before, after };
	}
	return null; // unknown shape — fail open (apply_patch is handled separately)
}

/**
 * Over-cap complexity violations for ONE file's before→after content. Returns an
 * array of human-readable violation strings (empty = no violation), or `null`
 * when the AST pass is unavailable (typescript missing) → caller fails open.
 *
 * The decision is IDENTITY-FREE. Function names are unreliable as comparison
 * keys: anonymous callbacks all share "(callback)", same-named methods /
 * overloads / nested defs collide, and renames or moves break name matching.
 * (Name-keyed-max comparison let a new 40-branch anonymous callback through, and
 * let one `run()` go 6→27 as long as another `run()` dropped 31→30.) Instead we
 * compare the sorted-descending MULTISET of OVER-CAP complexities before vs
 * after: the post-edit profile may not be worse than the pre-edit profile at any
 * rank — `post[i] > (pre[i] ?? cap)` is a violation. This blocks (a) a new
 * over-cap function (named OR anonymous), (b) raising any function past the cap,
 * and (c) shuffling complexity between same-named functions, while still
 * allowing a decompose that splits one over-cap function into several under-cap
 * ones. Names feed the message only, never the decision.
 */
function complexityViolations(
	before: string,
	after: string,
	filePath: string,
	analyzer: { compute: CyclomaticAnalyzer; language: "js_ts" | "python" },
	observe?: ComplexityObserver,
	cap: number = DEFAULT_MAX_CYCLOMATIC,
): string[] | null {
	const afterFns = analyzer.compute(after, filePath);
	if (!afterFns) {
		// Analyzer unavailable → fail open (no FP-blocking), but surface it loudly
		// so the degrade is never silent (the TS path warns at startup; Python here).
		warnAnalyzerUnavailable(analyzer.language);
		return null;
	}
	const beforeFns = analyzer.compute(before, filePath) ?? [];
	// Hand the already-paid parses to the telemetry observer (decision unaffected).
	observe?.(filePath, beforeFns, afterFns, after);

	const violations: string[] = [];

	// (1) Over-cap multiset comparison (identity-free) — blocks a new over-cap
	// function or a worsening of the over-cap profile at any rank. Owns the
	// `> cap` band (anonymous + collision-named functions included).
	const afterOver = afterFns
		.filter((f) => f.cyclomatic > cap)
		.sort((a, b) => b.cyclomatic - a.cyclomatic);
	if (afterOver.length > 0) {
		const beforeOverVals = beforeFns
			.filter((f) => f.cyclomatic > cap)
			.map((f) => f.cyclomatic)
			.sort((a, b) => b - a);
		const beforeByName = new Map<string, number>();
		for (const f of beforeFns) {
			if (f.name === ANON_FN) continue;
			beforeByName.set(f.name, Math.max(beforeByName.get(f.name) ?? 0, f.cyclomatic));
		}
		for (let i = 0; i < afterOver.length; i++) {
			const post = afterOver[i];
			const baseline = beforeOverVals[i] ?? cap;
			if (nonNull(post).cyclomatic <= baseline) continue; // this rank held or reduced
			const prior = nonNull(post).name === ANON_FN ? undefined : beforeByName.get(nonNull(post).name);
			const how =
				prior !== undefined && prior < nonNull(post).cyclomatic
					? `raised from ${prior}`
					: nonNull(post).name === ANON_FN
						? "new anonymous function over cap"
						: "new over-cap function";
			violations.push(`${nonNull(post).name} (cyclomatic ${nonNull(post).cyclomatic}, ${how})`);
		}
	}

	// (2) Sub-cap per-edit SLEW ratchet (identity-based) — an UNIQUELY-named
	// function present before AND after may rise by at most SUB_CAP_RATCHET_TOLERANCE
	// branches in a single edit while at/under the cap. Small incremental growth
	// toward the cap is allowed; a big one-edit leap blocks (decompose). The on-disk
	// before-state is the baseline, so this is trajectory-aware (each edit ratchets
	// against the cumulative on-disk state); many small rises can still walk a
	// function toward the cap over several edits, but never past it — the over-cap
	// path is the hard backstop. Covers the `<= cap` band only (the over-cap path
	// owns the rest, no double-report). Ambiguous/anonymous names have no reliable
	// cross-edit identity — left to the cap path; documented limitation.
	violations.push(...subCapRatchetViolations(beforeFns, afterFns, cap));
	return violations;
}

/** Map of UNIQUELY-named functions (name appears exactly once) -> cyclomatic.
 *  Collisions and anonymous fns are excluded — no reliable cross-edit identity. */
function uniqueByName(fns: FunctionComplexityEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const f of fns) {
		if (f.name === ANON_FN) continue;
		counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
	}
	const out = new Map<string, number>();
	for (const f of fns) {
		if (f.name !== ANON_FN && counts.get(f.name) === 1) out.set(f.name, f.cyclomatic);
	}
	return out;
}

/** Over-tolerance sub-cap rises of uniquely-named functions vs the before-state.
 *  A rise of up to SUB_CAP_RATCHET_TOLERANCE branches per edit is allowed; only a
 *  larger one-edit jump is a violation. Each entry reads "name (cyclomatic A -> B
 *  — rose N in one edit, over the +T/edit limit)". `<= cap` band only — a rise
 *  that lands over the cap is owned by the over-cap path, not double-reported. */
function subCapRatchetViolations(
	beforeFns: FunctionComplexityEntry[],
	afterFns: FunctionComplexityEntry[],
	cap: number,
): string[] {
	const before = uniqueByName(beforeFns);
	const out: string[] = [];
	for (const [name, post] of uniqueByName(afterFns)) {
		const pre = before.get(name);
		if (pre !== undefined && post <= cap && post - pre > SUB_CAP_RATCHET_TOLERANCE) {
			out.push(
				`${name} (cyclomatic ${pre} -> ${post} — rose ${post - pre} in one edit, ` +
					`over the +${SUB_CAP_RATCHET_TOLERANCE}/edit sub-cap limit)`,
			);
		}
	}
	return out.sort();
}

/** The shared block payload for a set of violation strings. */
function buildBlock(violations: string[], cap: number = DEFAULT_MAX_CYCLOMATIC): ComplexityWriteBlock {
	return {
		block:
			`[interlinked:cyclomatic] BLOCKED: this edit pushes ${violations.length} function(s) past a ` +
			`cyclomatic limit — a function may rise by at most ${SUB_CAP_RATCHET_TOLERANCE} branch(es) ` +
			`per edit, and no function may exceed the ${cap}-branch cap:\n` +
			`${violations.map((v) => `  • ${v}`).join("\n")}\n` +
			"Decompose: extract cohesive branches into smaller named functions, then retry. " +
			"Holding or reducing an existing function is always allowed; there is no suppression.\n" +
			`This ${cap}-branch cap is per-repo configurable: \`interlinked caps set cyclomatic <n>\` ` +
			"(run `interlinked caps explain cyclomatic` for what cyclomatic complexity measures).",
	};
}

/**
 * apply_patch path: reconstruct each section's post-edit content and run the
 * same over-cap comparison per file. Fails open per-file when the applier can't
 * confidently reconstruct (so a misparse never false-blocks), and entirely when
 * the AST pass is unavailable.
 */
function checkApplyPatchComplexity(
	toolInput: JsonObject,
	cwd: string,
	observe?: ComplexityObserver,
): ComplexityWriteBlock | null {
	const raw = extractApplyPatchRaw(toolInput);
	if (!raw || !looksLikeApplyPatch(raw)) return null;

	const violations: string[] = [];
	const cap = maxCyclomaticFor(cwd);
	for (const section of parseApplyPatchSections(raw)) {
		const analyzer = selectAnalyzer(section.path);
		if (!analyzer) continue; // non-code extension → skip
		// Read before-content from the SOURCE path for a moved section — the
		// destination (`section.path`) doesn't exist yet, so reading it yields ""
		// and the update hunks fail to reconstruct → the gate silently failed open
		// on a move that introduced an over-cap function (finding 2026-06).
		const readPath = section.fromPath ?? section.path;
		const abs = isAbsolute(readPath) ? readPath : resolve(cwd, readPath);
		const before = existsSync(abs) ? (safeRead(abs) ?? "") : "";
		const after = reconstructAfterContent(section, before);
		if (after === null) continue; // can't reconstruct confidently → fail open for this file
		if (!isCappableFile({ filePath: section.path, content: after, root: cwd })) continue;
		const fileViolations = complexityViolations(before, after, section.path, analyzer, observe, cap);
		if (fileViolations === null) return null; // analyzer unavailable → fail open entirely
		for (const item of fileViolations) violations.push(`${section.path}: ${item}`);
	}
	if (violations.length === 0) return null;
	return buildBlock(violations, cap);
}

/**
 * Block a Write/Edit/MultiEdit/apply_patch that introduces or worsens an
 * over-cap function. Returns null (allow) for non-JS/TS, exempt files, missing
 * AST support, or when the edit only holds/reduces complexity.
 */
export function checkFunctionComplexityWrite(
	toolInput: JsonObject,
	cwd: string,
	observe?: ComplexityObserver,
): ComplexityWriteBlock | null {
	const filePath = resolveFilePath(toolInput);
	if (filePath) {
		const analyzer = selectAnalyzer(filePath);
		if (!analyzer) return null; // non-code extension → skip
		const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
		const projected = projectContent(toolInput, abs);
		if (!projected) return null;
		if (!isCappableFile({ filePath, content: projected.after, root: cwd })) return null;
		const cap = maxCyclomaticFor(cwd);
		const violations = complexityViolations(
			projected.before,
			projected.after,
			filePath,
			analyzer,
			observe,
			cap,
		);
		if (violations === null || violations.length === 0) return null;
		return buildBlock(violations, cap);
	}
	// No explicit file_path → may be an apply_patch payload (multi-file).
	return checkApplyPatchComplexity(toolInput, cwd, observe);
}
