// ===========================================
// Cognitive write warning (legacy, kept for its own tests) + the promoted
// BLOCKING gate below
// ===========================================
// `cognitiveWriteWarning` below is the original warn-only signal (delta
// semantics: warn when an edit GROWS a function past the cognitive cap, or
// lands a new function already over it — never on hold/shrink). It is no
// longer wired into the PreToolUse pipeline (see pre-tool-phases.ts, which now
// calls `checkCognitiveComplexityWrite` instead) but stays exported and
// covered by cognitive-write-guard.test.ts as a standalone unit.
//
// `checkCognitiveComplexityWrite` (bottom half of this file) is the promoted
// gate: it mirrors `checkFunctionComplexityWrite` (complexity-write-guard.ts)
// rule-for-rule — over-cap end-state block (identity-free multiset compare,
// covers new/anonymous/collision-named functions) + a per-edit sub-cap slew
// ratchet — reusing the SAME file-path resolution and before/after content
// projection (`resolveFilePath` / `projectContent`, exported from
// complexity-write-guard.ts) so the two per-function metric gates can never
// disagree about what "this edit" changed.
//
// PERF-DEBT: this parses both sides itself (2 parses) on top of the cyclomatic
// gate's and the pulse profiles' parses. Consolidating all per-edit AST work
// into one shared parse pass is tracked in scratch/CAMPAIGN.md.

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
import { type CognitiveComplexityEntry, computeCognitiveAst } from "../checks/cognitive-ast.js";
import { isCappableFile } from "../large-file-policy.js";
import { maxCognitiveFor, metricDef } from "../metric-caps.js";
import { projectContent, resolveFilePath } from "./complexity-write-guard.js";

const ANON_FN = "(callback)";
const JS_TS_RE = /\.[cm]?[jt]sx?$/i;

/** name → max cognitive among same-named functions (anonymous skipped). */
function maxByName(entries: readonly CognitiveComplexityEntry[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of entries) {
		if (e.name === ANON_FN) continue;
		m.set(e.name, Math.max(m.get(e.name) ?? 0, e.cognitive));
	}
	return m;
}

/**
 * The warning for one projected write, or null. `absPath` is read for the
 * before-state (at PreToolUse the disk IS the before); a missing file means
 * every function is new.
 */
export function cognitiveWriteWarning(
	absPath: string,
	afterContent: string,
	cwd: string,
): string | null {
	if (!JS_TS_RE.test(absPath)) return null;
	const afterEntries = computeCognitiveAst(afterContent, absPath);
	if (!afterEntries) return null; // typescript unavailable — metric off

	const cap = maxCognitiveFor(cwd);
	let beforeMap = new Map<string, number>();
	try {
		const beforeEntries = computeCognitiveAst(readFileSync(absPath, "utf-8"), absPath);
		if (beforeEntries) beforeMap = maxByName(beforeEntries);
	} catch {
		beforeMap = new Map(); // unreadable/absent file ⇒ every function is new
	}

	const offenders: string[] = [];
	for (const [name, cog] of maxByName(afterEntries)) {
		if (cog <= cap) continue;
		const prior = beforeMap.get(name);
		if (prior === undefined) offenders.push(`${name}=${cog} (new)`);
		else if (cog > prior) offenders.push(`${name} ${prior}→${cog}`);
	}
	if (offenders.length === 0) return null;

	return (
		`[interlinked:cognitive] grew past cap ${cap} this edit: ${offenders.join(", ")}. ` +
		metricDef("cognitive").fixHint
	);
}

// ===========================================
// PreToolUse gate — per-function cognitive complexity cap (BLOCKING)
// ===========================================
// Promoted 2026-08-01: cognitive p99 across 9468 functions measured 26 against
// the shipped cap of 30 — the cap sits just above the 99th percentile, exactly
// where a backstop belongs — and the 51 over-cap functions are overwhelmingly
// the SAME functions the (already-blocking) cyclomatic gate flags. That answers
// the FP-calibration hedge this warn-only comment used to cite.

export interface CognitiveWriteBlock {
	block: string;
}

/**
 * Per-edit sub-cap SLEW tolerance for cognitive complexity — the cognitive
 * analog of `SUB_CAP_RATCHET_TOLERANCE` (cyclomatic, = 2). Deliberately set
 * HIGHER than the cyclomatic tolerance rather than copied verbatim: cognitive
 * increments are nesting-weighted, so the same single-edit structural change
 * (e.g. one more branch added a level deeper) costs more cognitive than
 * cyclomatic — the spec's own oracle example puts a 3-deep nested `if` at
 * cyclomatic 4 but cognitive 6 (docs/design/history-relational-metrics.md
 * §"3-deep nested if"), roughly 1.5x at shallow nesting and worse as nesting
 * grows. A tolerance of 2 (cyclomatic's value) would false-block routine
 * single-branch edits inside already-nested code; doubling it to 4 keeps
 * "roughly one added branch's worth of nesting-weighted cost" as the
 * per-edit allowance while still catching a genuinely large one-edit jump
 * (e.g. wrapping a block in two new nesting levels at once). The hard cap
 * (`maxCognitiveFor`) is unchanged and remains the END-STATE backstop — a
 * within-tolerance rise that crosses the cap is still caught by the over-cap
 * path, not this one.
 */
export const SUB_CAP_COGNITIVE_RATCHET_TOLERANCE = 4;

/** Map of UNIQUELY-named functions (name appears exactly once) -> cognitive.
 *  Collisions and anonymous fns are excluded — no reliable cross-edit identity.
 *  Mirrors `uniqueByName` in complexity-write-guard.ts. */
function uniqueByName(entries: readonly CognitiveComplexityEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const e of entries) {
		if (e.name === ANON_FN) continue;
		counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
	}
	const out = new Map<string, number>();
	for (const e of entries) {
		if (e.name !== ANON_FN && counts.get(e.name) === 1) out.set(e.name, e.cognitive);
	}
	return out;
}

/** Over-tolerance sub-cap rises of uniquely-named functions vs the before-state.
 *  `<= cap` band only — a rise that lands over the cap is owned by the
 *  over-cap path below, not double-reported. Mirrors `subCapRatchetViolations`
 *  in complexity-write-guard.ts. */
function subCapCognitiveRatchetViolations(
	beforeEntries: readonly CognitiveComplexityEntry[],
	afterEntries: readonly CognitiveComplexityEntry[],
	cap: number,
): string[] {
	const before = uniqueByName(beforeEntries);
	const out: string[] = [];
	for (const [name, post] of uniqueByName(afterEntries)) {
		const pre = before.get(name);
		if (pre !== undefined && post <= cap && post - pre > SUB_CAP_COGNITIVE_RATCHET_TOLERANCE) {
			out.push(
				`${name} (cognitive ${pre} -> ${post} — rose ${post - pre} in one edit, ` +
					`over the +${SUB_CAP_COGNITIVE_RATCHET_TOLERANCE}/edit sub-cap limit)`,
			);
		}
	}
	return out.sort();
}

/** Count of entries per name within ONE state (before or after), used to tell
 *  a uniquely-named entry from a same-file name collision. */
function countByName(entries: readonly CognitiveComplexityEntry[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of entries) m.set(e.name, (m.get(e.name) ?? 0) + 1);
	return m;
}

/** True when `name` has no reliable cross-edit identity in `counts`'s state:
 *  anonymous, or colliding with another same-named function in that state. */
function isAmbiguousName(name: string, counts: Map<string, number>): boolean {
	return name === ANON_FN || (counts.get(name) ?? 0) > 1;
}

/**
 * Over-cap cognitive violations for one file's before→after content. Returns
 * `null` when the AST pass is unavailable (typescript missing) → caller fails
 * open.
 *
 * This is a HYBRID of identity-based and identity-free comparison — a
 * deliberate strengthening over the cyclomatic gate's pure rank-based
 * multiset (complexity-write-guard.ts), not a verbatim copy of it:
 *
 *   (1a) A UNIQUELY-named over-cap entry (present once in the after-state) is
 *        compared directly against ITS OWN prior value by name (or the cap,
 *        if the name is brand new) — never against another entry's rank.
 *   (1b) AMBIGUOUS entries (anonymous "(callback)" units, or same-file name
 *        collisions) have no reliable per-name identity, so they fall back to
 *        the cyclomatic gate's pooled sorted-multiset comparison, scoped to
 *        just this subset.
 *
 * Why the split matters: a pure pooled-rank comparison (mirroring cyclomatic
 * exactly) MISSES a decomposition that shrinks an over-cap function's target
 * body but relocates the excess nesting into a newly-named, still-over-cap
 * helper — the over-cap COUNT doesn't change (one over-cap entry traded for
 * one over-cap entry), so a rank comparison alone reads it as "the worst
 * offender held or improved" and allows it. Complexity relocated is not
 * complexity removed. Identity-based comparison for uniquely-named entries
 * closes that gap: the new helper's name never appeared before, so its
 * baseline is the cap itself and it always violates. Ambiguous entries keep
 * the pooled fallback because names genuinely can't be trusted there (the
 * cyclomatic gate's own shuffle-test rationale still applies unchanged).
 */
function cognitiveViolations(
	before: string,
	after: string,
	filePath: string,
	cap: number,
): string[] | null {
	const afterEntries = computeCognitiveAst(after, filePath);
	if (!afterEntries) return null; // typescript unavailable → fail open
	const beforeEntries = computeCognitiveAst(before, filePath) ?? [];

	const violations: string[] = [];
	const afterNameCounts = countByName(afterEntries);
	const beforeNameCounts = countByName(beforeEntries);
	const beforeByName = maxByName(beforeEntries); // name -> max cognitive (ANON_FN excluded)

	const afterOver = afterEntries.filter((e) => e.cognitive > cap);

	// (1a) Identity-based: uniquely-named entries vs their own prior value.
	for (const e of afterOver) {
		if (isAmbiguousName(e.name, afterNameCounts)) continue;
		const prior = beforeByName.get(e.name);
		if (prior !== undefined && e.cognitive <= prior) continue; // held or reduced
		const how = prior !== undefined ? `raised from ${prior}` : "new over-cap function";
		violations.push(`${e.name} (cognitive ${e.cognitive}, ${how})`);
	}

	// (1b) Pooled rank comparison for ambiguous (anonymous / collision-named)
	// entries only — mirrors complexity-write-guard.ts's approach, scoped.
	const afterAmbiguousOver = afterOver
		.filter((e) => isAmbiguousName(e.name, afterNameCounts))
		.sort((a, b) => b.cognitive - a.cognitive);
	if (afterAmbiguousOver.length > 0) {
		const beforeAmbiguousVals = beforeEntries
			.filter((e) => e.cognitive > cap && isAmbiguousName(e.name, beforeNameCounts))
			.map((e) => e.cognitive)
			.sort((a, b) => b - a);
		for (let i = 0; i < afterAmbiguousOver.length; i++) {
			const post = nonNull(afterAmbiguousOver[i]);
			const baseline = beforeAmbiguousVals[i] ?? cap;
			if (post.cognitive <= baseline) continue; // this rank held or reduced
			const how = post.name === ANON_FN ? "new anonymous function over cap" : "new over-cap function";
			violations.push(`${post.name} (cognitive ${post.cognitive}, ${how})`);
		}
	}

	// (2) Sub-cap per-edit slew ratchet (identity-based).
	violations.push(...subCapCognitiveRatchetViolations(beforeEntries, afterEntries, cap));
	return violations;
}

/** The shared block payload for a set of cognitive violation strings. Advice
 *  is deliberately DIFFERENT from the cyclomatic block: cognitive complexity
 *  responds to FLATTENING (guard clauses / early returns, extracting the
 *  deepest-nested block), not "extract a branch" — a branch pulled out
 *  unflattened just moves the same nesting cost into a helper (see the
 *  relocation test in cognitive-write-guard.test.ts). */
function buildCognitiveBlock(violations: string[], cap: number): CognitiveWriteBlock {
	return {
		block:
			`[interlinked:cognitive] BLOCKED: this edit pushes ${violations.length} function(s) past a ` +
			`cognitive-complexity limit — a function may rise by at most ` +
			`${SUB_CAP_COGNITIVE_RATCHET_TOLERANCE} point(s) per edit, and no function may exceed the ` +
			`${cap}-point cap:\n` +
			`${violations.map((v) => `  • ${v}`).join("\n")}\n` +
			"Flatten: replace nested if/else with guard clauses (early return), or extract the " +
			"deepest-nested block into its own named function — extracting it as-is without " +
			"flattening only relocates the nesting cost, it doesn't remove it. " +
			"Holding or reducing an existing function is always allowed; there is no suppression.\n" +
			`This ${cap}-point cap is per-repo configurable: \`interlinked caps set cognitive <n>\` ` +
			"(run `interlinked caps explain cognitive` for what cognitive complexity measures).",
	};
}

/**
 * apply_patch path: reconstruct each section's post-edit content and run the
 * same over-cap comparison per file. Mirrors `checkApplyPatchComplexity` in
 * complexity-write-guard.ts — JS/TS only (cognitive has no Python analyzer).
 */
function checkApplyPatchCognitive(toolInput: JsonObject, cwd: string): CognitiveWriteBlock | null {
	const raw = extractApplyPatchRaw(toolInput);
	if (!raw || !looksLikeApplyPatch(raw)) return null;

	const violations: string[] = [];
	const cap = maxCognitiveFor(cwd);
	for (const section of parseApplyPatchSections(raw)) {
		if (!JS_TS_RE.test(section.path)) continue; // non-JS/TS → skip
		const readPath = section.fromPath ?? section.path;
		const abs = isAbsolute(readPath) ? readPath : resolve(cwd, readPath);
		const before = existsSync(abs) ? (readFileSync(abs, "utf-8") ?? "") : "";
		const after = reconstructAfterContent(section, before);
		if (after === null) continue; // can't reconstruct confidently → fail open for this file
		if (!isCappableFile({ filePath: section.path, content: after, root: cwd })) continue;
		const fileViolations = cognitiveViolations(before, after, section.path, cap);
		if (fileViolations === null) return null; // analyzer unavailable → fail open entirely
		for (const item of fileViolations) violations.push(`${section.path}: ${item}`);
	}
	if (violations.length === 0) return null;
	return buildCognitiveBlock(violations, cap);
}

/**
 * Block a Write/Edit/MultiEdit/apply_patch that introduces or worsens an
 * over-cap function's cognitive complexity. Returns null (allow) for
 * non-JS/TS, exempt files, missing AST support, or when the edit only
 * holds/reduces cognitive complexity. Same delta-semantics contract as
 * `checkFunctionComplexityWrite` (complexity-write-guard.ts): the on-disk
 * before-state is the ratchet baseline, so a pre-existing over-cap function
 * that is merely held or shrunk never blocks — only NEW over-cap functions or
 * a RAISE past the cap does.
 */
export function checkCognitiveComplexityWrite(
	toolInput: JsonObject,
	cwd: string,
): CognitiveWriteBlock | null {
	const filePath = resolveFilePath(toolInput);
	if (filePath) {
		if (!JS_TS_RE.test(filePath)) return null; // non-JS/TS → skip (no cognitive analyzer)
		const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
		const projected = projectContent(toolInput, abs);
		if (!projected) return null;
		if (!isCappableFile({ filePath, content: projected.after, root: cwd })) return null;
		const cap = maxCognitiveFor(cwd);
		const violations = cognitiveViolations(projected.before, projected.after, filePath, cap);
		if (violations === null || violations.length === 0) return null;
		return buildCognitiveBlock(violations, cap);
	}
	// No explicit file_path → may be an apply_patch payload (multi-file).
	return checkApplyPatchCognitive(toolInput, cwd);
}
