// ===========================================
// PreToolUse gate — per-function cyclomatic cap (strict, no override)
// ===========================================
// Blocks a Write/Edit/MultiEdit that would push a function's cyclomatic
// complexity past the cap. DELTA semantics, mirroring the line-cap gate
// (`checkLargeFileLineCountWrite`): an edit that holds or reduces an
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
// dev/CI). Without it the gate fails open — a heuristic count would risk
// FP-blocking legitimate code with no recourse.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
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
	return null; // apply_patch / unknown shape — fail open
}

/**
 * Block a Write/Edit that introduces or worsens an over-cap function. Returns
 * null (allow) for non-JS/TS, exempt files, missing AST support, or when the
 * edit only holds/reduces complexity.
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
 * ones (the post over-cap list shrinks). Names feed the message only, never the
 * decision.
 */
export function checkFunctionComplexityWrite(
	toolInput: JsonObject,
	cwd: string,
): ComplexityWriteBlock | null {
	const filePath = resolveFilePath(toolInput);
	if (!filePath || !JS_TS_RE.test(filePath)) return null;

	const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const projected = projectContent(toolInput, abs);
	if (!projected) return null;

	if (!isCappableFile({ filePath, content: projected.after })) return null;

	// computeCyclomaticAst counts every function-like node (incl. anonymous
	// callbacks) as its own unit — they MUST all be considered. Returns null
	// when the AST pass is unavailable (typescript missing) → fail open.
	const afterFns = computeCyclomaticAst(projected.after, filePath);
	if (!afterFns) return null; // AST unavailable → fail open (no FP-blocking)
	const beforeFns = computeCyclomaticAst(projected.before, filePath) ?? [];

	const cap = DEFAULT_MAX_CYCLOMATIC;
	const afterOver = afterFns
		.filter((f) => f.cyclomatic > cap)
		.sort((a, b) => b.cyclomatic - a.cyclomatic);
	if (afterOver.length === 0) return null;

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
	if (violations.length === 0) return null;

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
