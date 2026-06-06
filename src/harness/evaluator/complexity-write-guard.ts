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
// There is deliberately NO escape hatch / suppression: an agent-writable
// override gets gamed (the agent would suppress every file it wants to grow),
// which defeats the gate. The only way past is to decompose.
//
// Because a no-override block has no relief valve for a false positive, it runs
// ONLY when the AST pass is available (the optional `typescript` dep, present in
// dev/CI and shipped via optionalDependencies). Without it the gate fails open —
// a heuristic count would risk FP-blocking legitimate code with no recourse.
// Codex/Copilot `apply_patch` payloads are reconstructed to post-edit content
// via the conservative V4A applier (fail-open on any uncertainty), so they no
// longer bypass the gate by carrying their edit in the patch body.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import {
	looksLikeApplyPatch,
	parseApplyPatchSections,
	reconstructAfterContent,
} from "../apply-patch-content.js";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { isCappableFile } from "../large-file-policy.js";

/**
 * Per-function cyclomatic cap — the agreed hard "bad" line. One number for now;
 * a future ratchet baseline (like `.interlinked/large-files-baseline.json`) can
 * lower it (25 → 15 → …) as the codebase's hotspots are decomposed.
 */
export const DEFAULT_MAX_CYCLOMATIC = 25;

const JS_TS_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** AST entries with this name are anonymous — not matchable across before/after. */
const ANON_FN = "(callback)";

export interface ComplexityWriteBlock {
	block: string;
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
function complexityViolations(before: string, after: string, filePath: string): string[] | null {
	const afterFns = computeCyclomaticAst(after, filePath);
	if (!afterFns) return null; // AST unavailable → fail open (no FP-blocking)
	const beforeFns = computeCyclomaticAst(before, filePath) ?? [];

	const cap = DEFAULT_MAX_CYCLOMATIC;
	const afterOver = afterFns
		.filter((f) => f.cyclomatic > cap)
		.sort((a, b) => b.cyclomatic - a.cyclomatic);
	if (afterOver.length === 0) return [];

	const beforeOverVals = beforeFns
		.filter((f) => f.cyclomatic > cap)
		.map((f) => f.cyclomatic)
		.sort((a, b) => b - a);

	// Best-effort per-name lookup of the pre-edit complexity — phrasing only
	// ("raised from N"), never the block decision.
	const beforeByName = new Map<string, number>();
	for (const f of beforeFns) {
		if (f.name === ANON_FN) continue;
		beforeByName.set(f.name, Math.max(beforeByName.get(f.name) ?? 0, f.cyclomatic));
	}

	const violations: string[] = [];
	for (let i = 0; i < afterOver.length; i++) {
		const post = afterOver[i];
		// A missing pre value at this rank means there were fewer over-cap
		// functions before — the cap is the implicit baseline, so any over-cap
		// value at this rank is a worsening.
		const baseline = beforeOverVals[i] ?? cap;
		if (post.cyclomatic <= baseline) continue; // this rank held or reduced
		const prior = post.name === ANON_FN ? undefined : beforeByName.get(post.name);
		const how =
			prior !== undefined && prior < post.cyclomatic
				? `raised from ${prior}`
				: post.name === ANON_FN
					? "new anonymous function over cap"
					: "new over-cap function";
		violations.push(`${post.name} (cyclomatic ${post.cyclomatic}, ${how})`);
	}
	return violations;
}

/** The shared block payload for a set of violation strings. */
function buildBlock(violations: string[]): ComplexityWriteBlock {
	const cap = DEFAULT_MAX_CYCLOMATIC;
	return {
		block:
			`[interlinked:cyclomatic] BLOCKED: this edit pushes ${violations.length} function(s) ` +
			`past the ${cap}-branch cyclomatic cap:\n` +
			`${violations.map((v) => `  • ${v}`).join("\n")}\n` +
			"Decompose: extract cohesive branches into smaller named functions, then retry. " +
			"Editing an already-complex function is allowed as long as you don't make it worse — " +
			"there is no suppression; the cap is enforced.",
	};
}

/** Raw apply_patch payload across the runner-specific keys (matches the hook-side
 *  normalizer's `command || patch || content || _raw_patch`). */
function extractPatchRaw(toolInput: JsonObject): string {
	return (
		(typeof toolInput.command === "string" && toolInput.command) ||
		(typeof toolInput.patch === "string" && toolInput.patch) ||
		(typeof toolInput._raw_patch === "string" && toolInput._raw_patch) ||
		(typeof toolInput.content === "string" && toolInput.content) ||
		""
	);
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
): ComplexityWriteBlock | null {
	const raw = extractPatchRaw(toolInput);
	if (!raw || !looksLikeApplyPatch(raw)) return null;

	const violations: string[] = [];
	for (const section of parseApplyPatchSections(raw)) {
		if (!JS_TS_RE.test(section.path)) continue;
		const abs = isAbsolute(section.path) ? section.path : resolve(cwd, section.path);
		const before = existsSync(abs) ? (safeRead(abs) ?? "") : "";
		const after = reconstructAfterContent(section, before);
		if (after === null) continue; // can't reconstruct confidently → fail open for this file
		if (!isCappableFile({ filePath: section.path, content: after })) continue;
		const fileViolations = complexityViolations(before, after, section.path);
		if (fileViolations === null) return null; // AST unavailable → fail open entirely
		for (const item of fileViolations) violations.push(`${section.path}: ${item}`);
	}
	if (violations.length === 0) return null;
	return buildBlock(violations);
}

/**
 * Block a Write/Edit/MultiEdit/apply_patch that introduces or worsens an
 * over-cap function. Returns null (allow) for non-JS/TS, exempt files, missing
 * AST support, or when the edit only holds/reduces complexity.
 */
export function checkFunctionComplexityWrite(
	toolInput: JsonObject,
	cwd: string,
): ComplexityWriteBlock | null {
	const filePath = resolveFilePath(toolInput);
	if (filePath) {
		if (!JS_TS_RE.test(filePath)) return null;
		const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
		const projected = projectContent(toolInput, abs);
		if (!projected) return null;
		if (!isCappableFile({ filePath, content: projected.after })) return null;
		const violations = complexityViolations(projected.before, projected.after, filePath);
		if (violations === null || violations.length === 0) return null;
		return buildBlock(violations);
	}
	// No explicit file_path → may be an apply_patch payload (multi-file).
	return checkApplyPatchComplexity(toolInput, cwd);
}
