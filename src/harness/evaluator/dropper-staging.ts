// ===========================================
// Supply-chain dropper-staging detection
// ===========================================
// The "dropper" shape: stage a payload in an ephemeral temp dir, then execute
// it (ref: axios@1.14.1 wrote AppleScript to /tmp/ and ran it via osascript).
//
// Split out of the inline matcher in `pre-tool-helpers-guard-blocks.ts`, which
// warned on three shapes that are not staging:
//
//   1. The HOST SESSION SCRATCHPAD. `sessionScratchpadAllows` already settled
//      that this path is sanctioned — its own comment calls blocking it
//      "over-reach", since the host hands the agent that directory. The write
//      arm now consults the same predicate instead of contradicting it.
//   2. A LOG IS NOT A PAYLOAD. Redirecting output to `run.log` under a temp
//      dir is routine; only a target that could be executed stages anything.
//   3. AN UNBOUNDED `[\s\S]*` paired ANY `cat|echo|printf|tee` anywhere in a
//      compound command with ANY later `> /tmp/…`. The verb and the redirect
//      did not have to be related, so `cat README.md && ls > /tmp/out.log`
//      matched. Targets are now extracted per-redirect rather than by proving
//      a verb and a redirect coexist in the same string.
//
// EXECUTION has no scratchpad carve-out: running code out of a temp dir is the
// dropper's payoff, it is rarely legitimate, and the repo's own scratchpad
// governance already steers agent-authored scripts to `<repo>/scratch/`.

import { isEphemeralTempPath, sessionScratchpadAllows } from "./filesystem-guards.js";

/**
 * Suffixes that mark a redirect target as a data sink rather than an
 * executable payload. Anything NOT on this list — including an extensionless
 * target — is treated as potentially executable.
 */
const DATA_SINK_EXT =
	/\.(?:log|txt|json|jsonl|ndjson|csv|tsv|md|out|err|xml|ya?ml|diff|patch|html|snap|lock)$/i;

/** `>` / `>>` / `tee` write targets. The character class stops at shell
 *  metacharacters so `2>&1` yields no target. The flag repetition is BOUNDED
 *  ({0,4} rather than *) — measured linear either way, but an unbounded
 *  quantifier nested in a quantifier is the shape this repo's own ReDoS check
 *  looks for, and a bound is free here (`tee` takes one or two flags). */
const REDIRECT_TARGET_RE =
	/(?:>>?|\btee\b(?:\s+-\S+){0,4})\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>"']+))/g;

/** An interpreter or a +x permission change pointed at a path. */
const EXEC_TARGET_RE =
	/\b(?:chmod\s+\+?[0-7]*x|bash|zsh|sh|python3?|node|ruby|perl|osascript)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&<>"']+))/gi;

/** Every path-shaped token `re` captures from `cmd`. */
function extractTargets(cmd: string, re: RegExp): string[] {
	const targets: string[] = [];
	re.lastIndex = 0;
	for (let match = re.exec(cmd); match !== null; match = re.exec(cmd)) {
		const target = match[1] ?? match[2] ?? match[3];
		if (target) targets.push(target);
	}
	return targets;
}

/**
 * The first target that looks like dropper staging, or null when the command
 * is clean. Returning the target (not a boolean) lets the caller name the
 * offending path in its warning.
 *
 * `isEphemeralTempPath` compares against both the literal and realpath'd temp
 * roots, so a raw `/tmp/...` token needs no canonicalization here.
 */
export function detectDropperStaging(cmd: string, sessionId: string | undefined): string | null {
	for (const target of extractTargets(cmd, EXEC_TARGET_RE)) {
		if (isEphemeralTempPath(target)) return target;
	}
	for (const target of extractTargets(cmd, REDIRECT_TARGET_RE)) {
		if (!isEphemeralTempPath(target)) continue;
		if (sessionScratchpadAllows(target, sessionId)) continue;
		if (DATA_SINK_EXT.test(target)) continue;
		return target;
	}
	return null;
}
