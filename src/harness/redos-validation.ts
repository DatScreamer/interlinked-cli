// ReDoS-shape validator for user-supplied regex patterns.
//
// Guard rules and `/enforce`-distilled rules ingested from third-party
// `AGENTS.md` / `CLAUDE.md` / `.clinerules/` files arrive as opaque strings
// that get compiled with `new RegExp(...)` and then run on every PostToolUse.
// A pathological pattern (nested quantifiers, wildcard-under-repetition,
// prefix-overlapping alternation) can hang the harness daemon for seconds
// per evaluation against the right adversarial input — the classic ReDoS
// surface.
//
// This module gates compilation: callers ask `safeCompileRegex(pattern, flags)`
// instead of `new RegExp(pattern, flags)`. A pattern that looks ReDoS-prone
// returns `null` (caller falls through; the rule is effectively skipped) and
// the structural shape is reported via `looksLikeReDoS` for tests / logs.
//
// This is a *heuristic*, not a proof. It catches the three structural shapes
// that produce catastrophic backtracking on adversarial inputs. It does NOT
// guarantee a pattern is safe; it guarantees that the most common dangerous
// shapes are rejected at load time.

/** Nested quantifier inside a group: `(a+)*`, `(a*b)+`, `(\w+\d*)*`. */
import { nonNull } from "../lib/non-null.js";

const NESTED_QUANT_RE = /\([^()]*[+*][^()]*\)[+*?]/;

/** Wildcard `.*` under repetition: `(.*)*`, `(.*X)+`. */
const WILDCARD_GROUP_RE = /\(\.\*[^()]*\)[+*]/;

/** Find each `(a|b|...)+` / `(a|b|...)*` group for the prefix-overlap check. */
const ALT_UNDER_REP_RE = /\(([^()|]*)\|([^()|]*(?:\|[^()|]*)*)\)[+*]/g;

/**
 * Decide whether `pattern` matches one of the three known catastrophic-
 * backtracking shapes. Returns `true` if any shape is detected.
 *
 * Shapes covered:
 *  1. Nested quantifiers: `(a+)+`, `(a*b)*`, `(\w+)+`
 *  2. Wildcard groups under repetition: `(.*)*`, `(.*X)*`
 *  3. Alternation under repetition where one branch is a prefix of another:
 *     `(a|aa)+`, `(ab|a)*` — the engine backtracks combinatorially on inputs
 *     that fail to match. Non-overlapping alternation (`(a|b)*`) is safe.
 */
export function looksLikeReDoS(pattern: string): boolean {
	if (NESTED_QUANT_RE.test(pattern)) return true;
	if (WILDCARD_GROUP_RE.test(pattern)) return true;

	for (const match of pattern.matchAll(ALT_UNDER_REP_RE)) {
		// Strip leading `(` and trailing `)*` / `)+` from the whole match to
		// recover the inside of the group, then split on `|`.
		const inner = match[0].slice(1, -2);
		const branches = inner.split("|").filter((b) => b.length > 0);
		if (hasPrefixOverlap(branches)) return true;
	}
	return false;
}

/**
 * Return `true` when any pair of strings in `branches` has a literal prefix
 * relationship (`a` and `aa`; `ab` and `a`). Such an alternation under
 * repetition (`(a|aa)+`) is the canonical ambiguous-grammar shape: on a
 * non-matching suffix the engine backtracks every partition of the input.
 */
function hasPrefixOverlap(branches: readonly string[]): boolean {
	for (let i = 0; i < branches.length; i++) {
		for (let j = i + 1; j < branches.length; j++) {
			const a = nonNull(branches[i]);
			const b = nonNull(branches[j]);
			if (a.startsWith(b) || b.startsWith(a)) return true;
		}
	}
	return false;
}

/**
 * Compile a user-supplied regex unless it matches a ReDoS shape. Returns the
 * compiled `RegExp` on success, `null` if the pattern is ReDoS-prone or fails
 * to compile. Callers should treat a `null` return as "skip this rule" and,
 * if they have a logging channel, emit a one-line warning naming the rule.
 */
export function safeCompileRegex(pattern: string, flags = ""): RegExp | null {
	if (looksLikeReDoS(pattern)) return null;
	try {
		return new RegExp(pattern, flags);
	} catch {
		return null;
	}
}
