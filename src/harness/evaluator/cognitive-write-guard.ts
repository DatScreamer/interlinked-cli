// ===========================================
// Cognitive write warning — delta semantics against the max_cognitive cap
// ===========================================
// PreToolUse observer companion to the cyclomatic gate: warns (never blocks —
// block promotion waits on cross-repo FP calibration, plan 06 lane 3) when an
// edit GROWS a named function past the repo's cognitive cap, or lands a new
// function already over it. Holding or shrinking an over-cap function is the
// refactor-down path and is always silent. Anonymous "(callback)" units are
// unmatchable across before/after and are skipped, mirroring the cyclomatic
// ratchet's ANON_FN rule.
//
// PERF-DEBT: this parses both sides itself (2 parses) on top of the cyclomatic
// gate's and the pulse profiles' parses. Consolidating all per-edit AST work
// into one shared parse pass is tracked in scratch/CAMPAIGN.md.

import { readFileSync } from "node:fs";
import { type CognitiveComplexityEntry, computeCognitiveAst } from "../checks/cognitive-ast.js";
import { maxCognitiveFor, metricDef } from "../metric-caps.js";

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
