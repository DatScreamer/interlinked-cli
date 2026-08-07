// ===========================================
// Unkillable mutants as a dead-code signal
// ===========================================
// A surviving mutant is normally read as a TEST gap. Sometimes it is a CODE
// signal instead: if no test can distinguish the mutated code from the original,
// the code may have no observable effect at all.
//
// The strongest form is a conditional whose BOTH polarities survive. If forcing
// a branch to `true` and forcing it to `false` each leave the suite green, the
// branch outcome is never observed. Either nothing reaches it, or both arms do
// the same thing. A test cannot fix that — only deleting or repairing the code
// can.
//
// Every rule here comes from a survivor pattern that turned out to be real dead
// code in this repo (2026-08-05/06), each independently confirmed by reading the
// source afterwards:
//   * `commands/status.ts` 88-90 — a `serverStatus` initializer overwritten on
//     every path before any read. Three adjacent survivors; mutating the object
//     to `{}` or flipping its booleans changed nothing.
//   * `commands/check.ts` 126 — `file.endsWith(".d.ts")` unreachable, because
//     the caller passes a `basename(file, extname(file))` that line 124 has
//     already matched on `.d`. Found independently by two different agents.
//   * `commands/sync.ts` 479 — a fallback block guarded by two flags that every
//     loop path sets via `break`.
//   * `checks/agent-safety-deps.ts` — two whole detectors that can never fire.
//
// Deliberately NOT a per-edit gate: it needs a full mutation report, which costs
// minutes. This is a reporting helper for `interlinked mutation`-style review.

/** The minimum a survivor must carry for this analysis. Matches the shape of a
 *  Stryker JSON report entry, so any engine emitting that format works. */
export interface SurvivorLike {
	id: string;
	line: number;
	mutatorName: string;
	/** The replacement source text, e.g. `"true"`, `"{}"`, `'""'`. */
	replacement?: string | undefined;
}

export interface DeadCodeCandidate {
	line: number;
	/** `high` = both polarities of a condition survived; `medium` = the whole
	 *  line is inert under every operator tried. */
	confidence: "high" | "medium";
	reason: string;
	mutantIds: string[];
}

/** A line with at least this many survivors is inert enough to look at, even
 *  without the both-polarities proof. Three is where the `status.ts` dead store
 *  showed up; two produces noise on ordinary under-tested lines. */
const INERT_LINE_MIN_SURVIVORS = 3;

/** Mutators that replace a condition wholesale, so `true`/`false` replacements
 *  are meaningful polarity evidence rather than an unrelated edit. */
const CONDITION_MUTATORS = new Set(["ConditionalExpression", "BooleanLiteral", "EqualityOperator"]);

function normalize(replacement: string | undefined): string {
	return (replacement ?? "").trim();
}

/** Group survivors by source line. */
function byLine(survivors: readonly SurvivorLike[]): Map<number, SurvivorLike[]> {
	const out = new Map<number, SurvivorLike[]>();
	for (const s of survivors) {
		const list = out.get(s.line);
		if (list) list.push(s);
		else out.set(s.line, [s]);
	}
	return out;
}

/** True when this line has a surviving condition forced BOTH ways. */
function bothPolaritiesSurvived(group: readonly SurvivorLike[]): boolean {
	let sawTrue = false;
	let sawFalse = false;
	for (const s of group) {
		if (!CONDITION_MUTATORS.has(s.mutatorName)) continue;
		const r = normalize(s.replacement);
		if (r === "true") sawTrue = true;
		if (r === "false") sawFalse = true;
	}
	return sawTrue && sawFalse;
}

/**
 * Find lines whose surviving mutants suggest the CODE is dead rather than the
 * tests being weak.
 *
 * Returns candidates sorted by confidence then line. Empty when nothing
 * qualifies — most surviving mutants really are test gaps, and saying so by
 * saying nothing is the point.
 */
export function findDeadCodeCandidates(survivors: readonly SurvivorLike[]): DeadCodeCandidate[] {
	const out: DeadCodeCandidate[] = [];

	for (const [line, group] of byLine(survivors)) {
		const ids = group.map((s) => s.id);
		if (bothPolaritiesSurvived(group)) {
			out.push({
				line,
				confidence: "high",
				reason:
					"condition survived forced BOTH true and false — its outcome is never observed, so the branch is unreachable or both arms are equivalent. No test can kill this; delete or repair the code.",
				mutantIds: ids,
			});
			continue;
		}
		if (group.length >= INERT_LINE_MIN_SURVIVORS) {
			out.push({
				line,
				confidence: "medium",
				reason: `${group.length} mutants survived on this one line (${[...new Set(group.map((s) => s.mutatorName))].join(", ")}) — the whole expression may be inert, e.g. a value overwritten before any read.`,
				mutantIds: ids,
			});
		}
	}

	const rank = (c: DeadCodeCandidate): number => (c.confidence === "high" ? 0 : 1);
	return out.sort((a, b) => rank(a) - rank(b) || a.line - b.line);
}

/** One-line-per-candidate rendering for a review report, or null when clean. */
export function formatDeadCodeCandidates(
	file: string,
	candidates: readonly DeadCodeCandidate[],
): string | null {
	if (candidates.length === 0) return null;
	const lines = candidates.map((c) => `  ${file}:${c.line} [${c.confidence}] ${c.reason}`);
	return (
		`[interlinked:dead-code-signal] ${candidates.length} line(s) in ${file} look DEAD rather than untested:\n` +
		`${lines.join("\n")}\n` +
		"  A mutant no test can kill is often telling you the code does not matter. Verify by reading the callers, then delete or fix — do not write a test to cover it."
	);
}
