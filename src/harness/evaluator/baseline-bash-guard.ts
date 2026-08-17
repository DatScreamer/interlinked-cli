// Baseline-integrity gate, Bash arm.
//
// Red-team finding F1 (2026-08-09, docs/design/red-team-findings-2026-08-09.md):
// `evaluateBaselineIntegrityGate` was gated on `isFileWrite(toolName)`, so the
// anti-gaming detector never saw a shell command. Measured against the live
// daemon, ALL of these were allowed:
//
//   echo '<lowered>' > .interlinked/metric-caps.json
//   sed -i '' s/22/999/ .interlinked/metric-caps.json
//   echo '<lowered>' | tee .interlinked/metric-caps.json
//   python3 -c "open('…/metric-caps.json','w').write(…)"
//   cp /tmp/x.json .interlinked/metric-caps.json
//
// One shell line therefore defeated every ratchet at once (coverage, mutation,
// cyclomatic/CRAP, line cap, untested-file floor). The commit-gate backstop
// covers only the 3 git-tracked baselines at a real `git commit`; the
// gitignored ones had no backstop at all, and a fleet agent never commits.
//
// Stance: FAIL-CLOSED on the unverifiable path. The Write/Edit arm compares
// before/after content and permits a tightening edit. A shell command's
// resulting bytes are not knowable pre-execution, so this arm refuses ANY
// shell write to a water-line and points at the tools that can be checked.
// Loosening is the move this gate exists to stop; the harness's own ratchet
// raises go through internal `fs` writes, never Bash.

import { isAbsolute, resolve } from "node:path";
import { effectIsReversible } from "./baseline-effect-guard.js";
import { isWaterLinePath } from "./water-line-files.js";

/** True when a resolved path is a `.interlinked/` water-line file.
 *  The list itself lives in water-line-files.ts — one source of truth for
 *  every baseline guard (see its OPEN QUESTION note on the guard set's width). */
function isBaselinePath(candidate: string): boolean {
	return isWaterLinePath(candidate);
}

/**
 * Shell fragments that WRITE their target. Each pattern captures the path in
 * group 1. Deliberately broad: this arm refuses rather than adjudicates, so a
 * generous match costs an agent one redirect through the Edit tool, while a
 * miss costs the whole ratchet system.
 */
const WRITE_MECHANISMS: RegExp[] = [
	// shell redirect / append (not 2> or &>)
	/(?<![0-9&])>>?\s*(['"]?)([^\s'"|&;]+)\1/g,
	// tee (with or without append flags)
	/\btee\s+(?:-a\s+|--append\s+)?(?:--\s+)?(['"]?)([^\s'"|&;]+)\1/g,
	// dd destination
	/\bdd\b[^|;]*\bof=(['"]?)([^\s'"|&;]+)\1/g,
	// interpreter one-liners that open a path for writing
	/open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/g,
	// node/shell helpers that name the target first
	/\bwriteFileSync\s*\(\s*['"]([^'"]+)['"]/g,
];

/**
 * Destination arguments of verbs whose target is positional (`sed -i … FILE`,
 * `cp SRC DEST`, `mv SRC DEST`, `install SRC DEST`).
 *
 * Token scan rather than regex: the regex forms need a nested quantifier
 * (`(?:[^\s]+\s+)*`), which is a ReDoS vector on a hook path that parses
 * agent-supplied commands. Splitting on whitespace is linear and clearer.
 */
function unquoteToken(token: string): string {
	return token.replace(/^['"]|['"]$/g, "");
}

/** Write targets of ONE shell segment (already split on `| ; &`). */
function segmentWriteTargets(segment: string): string[] {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	const verb = tokens[0];
	if (!verb) return [];
	const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
	// `rm` destroys EVERY operand, so all of them are targets — unlike the
	// copy/move family, where only the destination is written.
	if (verb === "rm") return args.map(unquoteToken);
	const last = args[args.length - 1];
	if (!last) return [];
	const isInPlaceSed = verb === "sed" && tokens.some((t) => /^-[a-zA-Z]*i/.test(t));
	const isCopyMove = verb === "cp" || verb === "mv" || verb === "install";
	return isInPlaceSed || isCopyMove ? [unquoteToken(last)] : [];
}

function positionalWriteTargets(normalized: string): string[] {
	return normalized.split(/[|;&]+/).flatMap(segmentWriteTargets);
}

/** Every candidate write target in a command, resolved against the project root. */
function writeTargets(cmd: string, projectRoot: string): string[] {
	const normalized = cmd.replace(/[\r\n]+/g, " ");
	const out: string[] = [];
	const raws: string[] = [];
	for (const re of WRITE_MECHANISMS) {
		re.lastIndex = 0;
		for (const m of normalized.matchAll(re)) {
			// Path is the last defined capture group (patterns use either
			// (quote)(path) or a single (path) group).
			const raw = m[2] ?? m[1];
			if (raw) raws.push(raw);
		}
	}
	raws.push(...positionalWriteTargets(normalized));
	for (const raw of raws) out.push(isAbsolute(raw) ? raw : resolve(projectRoot, raw));
	return out;
}

/**
 * Refusal reason when a shell command writes a ratchet water-line, else null.
 *
 * Honors `INTERLINKED_DISABLE_BASELINE_GUARD=1` — the same documented escape
 * hatch the Write/Edit arm uses for an intentional reset.
 */
export function baselineBashWriteRefusal(cmd: string, projectRoot: string): string | null {
	if (!cmd) return null;
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	// Reversible effects are not refused: the effect arm snapshots the
	// water-lines before the call, so a loosening is undoable AND inert
	// (baseline-effect-guard.ts). Refusing here would also refuse the
	// legitimate case this gate cannot distinguish pre-execution — TIGHTENING
	// a water-line from the shell. Irreversible commands still block, because
	// no post-hoc evidence brings those bytes back.
	if (effectIsReversible("Bash", cmd)) return null;

	for (const target of writeTargets(cmd, projectRoot)) {
		if (!isBaselinePath(target)) continue;
		const shown = target.split("/").pop() ?? target;
		return (
			`BLOCKED: irreversible shell command targeting the ratchet water-line ${shown}. ` +
			"Water-lines may only move in the tightening direction, and this command's effect " +
			"cannot be undone afterwards, so it is refused before it runs. Use the Edit tool (the " +
			"gate inspects the proposed content and allows a tightening change), let the harness " +
			"raise the line itself by meeting the bar, or set INTERLINKED_DISABLE_BASELINE_GUARD=1 " +
			"for an intentional reset."
		);
	}
	return null;
}
