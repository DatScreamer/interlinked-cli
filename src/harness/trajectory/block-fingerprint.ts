// ===========================================
// Block fingerprint store — the substrate for block→workaround detection
// ===========================================
// When a PreToolUse block fires, the refused action is fingerprinted (content
// shingles + target path + rule id + timestamp) and armed in session state.
// Later tool calls are checked against the still-armed fingerprints by the
// workaround detectors below — catching an agent that, after a block, reaches
// the same end through a harness-invisible channel (a bash heredoc, `node -e`,
// a subagent prompt, a redirect to the blocked path, an escape env, or a
// config loosening). See `docs/design/trajectory-continuity-local-split.md` §4.
//
// PURE: no fs, no clock, no session mutation — timestamps and the armed set are
// INPUTS, so every detector is a total function of (armed fingerprints,
// candidate). The session layer owns the fs/clock and the shadow→Stop routing;
// the continuity doctrine (never derail a running agent) lives THERE — here we
// only detect. Similarity primitives are reused from the DRY clone detector
// (`checks/dry.ts`), not reinvented.

import { jaccard, shingleSet, tokenize } from "../checks/dry.js";

/** A refused action, fingerprinted for later workaround detection. */
export interface BlockFingerprint {
	/** The rule/check id that refused the action. */
	ruleId: string;
	/** Token-shingle set of the refused content/command — the fuzzy match key
	 *  that survives reformatting and channel changes. */
	shingles: Set<string>;
	/** Repo-relative POSIX target path the refusal named, or null. */
	target: string | null;
	/** ms epoch when the block fired (the staleness clock). */
	atMs: number;
	/**
	 * Which channel the refusal happened on — "write" for Write/Edit/MultiEdit,
	 * "command" for Bash and friends.
	 *
	 * Evasion means the content came back through a channel that does NOT run the
	 * check that refused it (a blocked Write reappearing as a bash heredoc). A
	 * retry on the SAME channel cannot evade anything: it faces the same gate, and
	 * it is only observed here when that gate ALLOWED it — i.e. after the agent
	 * fixed what the block complained about. Treating that as a workaround
	 * punished the correct response to a block; measured on this repo, 11 of 11
	 * signals in one session were same-channel remediation.
	 */
	channel?: "write" | "command" | undefined;
}

/** Default arming window: a fingerprint older than this is pruned, so a stale
 *  block never walls a later unrelated action (continuity). Generous — a
 *  workaround usually follows within a few calls, but agents pause to think. */
export const DEFAULT_FINGERPRINT_TTL_MS = 15 * 60_000;

/** Default shingle-overlap at/above which candidate content counts as "the same
 *  refused action, resurfacing". High enough that ordinary reuse of common
 *  tokens does not trip it; low enough to survive light edits + channel shifts. */
export const DEFAULT_RESURFACE_THRESHOLD = 0.6;

/** Config/enforcement paths whose in-window edit is a loosening signal (D3). */
const CONFIG_LOOSEN_RE =
	/(?:^|\/)\.interlinked\/(?:guard-rules(?:\.local)?\.json|[\w-]*baseline\.json|metric-caps\.json|verify-suppressions\.json)$|(?:^|\/)\.claude\/settings(?:\.local)?\.json$/;

/** Escape-hatch env assignments whose in-window use is a bypass signal (D4). */
const ESCAPE_ENV_RE = /\bINTERLINKED_(?:DISABLE|SKIP|ALLOW)[A-Z0-9_]*\s*=/;

/** Build a fingerprint from a blocked action. `content` is whatever the refusal
 *  concerned — proposed file content, a bash command, or a patch body. */
export function fingerprintBlock(input: {
	ruleId: string;
	content: string;
	target?: string | null;
	atMs: number;
	channel?: "write" | "command" | undefined;
}): BlockFingerprint {
	return {
		ruleId: input.ruleId,
		shingles: shingleSet(tokenize(input.content)),
		target: input.target ? input.target.replace(/\\/g, "/") : null,
		atMs: input.atMs,
		channel: input.channel,
	};
}

/** Drop fingerprints past the TTL — self-clearing arming window. */
export function pruneExpired(
	fps: readonly BlockFingerprint[],
	nowMs: number,
	ttlMs: number = DEFAULT_FINGERPRINT_TTL_MS,
): BlockFingerprint[] {
	return fps.filter((f) => nowMs - f.atMs <= ttlMs);
}

/** True when any refusal is still armed — the precondition for the correlation
 *  detectors. The most-recent armed fingerprint is what a workaround "targets". */
export function mostRecentArmed(fps: readonly BlockFingerprint[]): BlockFingerprint | null {
	let best: BlockFingerprint | null = null;
	for (const f of fps) {
		if (best === null || f.atMs > best.atMs) best = f;
	}
	return best;
}

/**
 * Detector 1 — same-content resurfacing. Candidate content carries the shingle
 * shape of a still-armed refusal (through ANY channel). Returns the matched
 * fingerprint (highest overlap), or null.
 */
export function sameContentResurfacing(
	fps: readonly BlockFingerprint[],
	candidateContent: string,
	threshold: number = DEFAULT_RESURFACE_THRESHOLD,
): BlockFingerprint | null {
	if (!candidateContent) return null;
	const cand = shingleSet(tokenize(candidateContent));
	if (cand.size === 0) return null;
	let best: BlockFingerprint | null = null;
	let bestScore = threshold;
	for (const f of fps) {
		if (f.shingles.size === 0) continue;
		const score = jaccard(f.shingles, cand);
		if (score >= bestScore) {
			best = f;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Detector 2 — same-target-different-channel. Candidate writes a path a
 * still-armed refusal named (e.g. a blocked Write's file re-created via a bash
 * redirect / `sed -i`). Returns the matched fingerprint, or null.
 */
export function sameTargetDifferentChannel(
	fps: readonly BlockFingerprint[],
	candidateTarget: string | null | undefined,
): BlockFingerprint | null {
	if (!candidateTarget) return null;
	const norm = candidateTarget.replace(/\\/g, "/");
	for (const f of fps) {
		if (f.target !== null && f.target === norm) return f;
	}
	return null;
}

/**
 * Detector 3 — config-loosening-in-window. With a refusal still armed, the
 * candidate edits a guard-rules / settings / baseline / metric-caps file — the
 * canonical gate-gaming move. (The baseline-integrity gate hard-blocks the
 * water-line files directly; this is the trajectory-evidence layer for the
 * rest.) Returns the armed fingerprint being worked around, or null.
 */
export function configLooseningAfterBlock(
	fps: readonly BlockFingerprint[],
	candidateTarget: string | null | undefined,
): BlockFingerprint | null {
	if (!candidateTarget) return null;
	if (!CONFIG_LOOSEN_RE.test(candidateTarget.replace(/\\/g, "/"))) return null;
	return mostRecentArmed(fps);
}

/**
 * Detector 4 — escape-env-after-block. With a refusal still armed, the
 * candidate bash command sets an `INTERLINKED_DISABLE_*` / `_SKIP_` / `_ALLOW_`
 * escape hatch — legitimate for documented bootstrap, but a workaround signal
 * when it directly follows a block. Returns the armed fingerprint, or null.
 */
export function escapeEnvAfterBlock(
	fps: readonly BlockFingerprint[],
	candidateCommand: string | null | undefined,
): BlockFingerprint | null {
	if (!candidateCommand || !ESCAPE_ENV_RE.test(candidateCommand)) return null;
	return mostRecentArmed(fps);
}
