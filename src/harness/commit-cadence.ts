// ===========================================
// Commit Cadence — Stop-time + mid-session-backstop nudge
// ===========================================
//
// Encourages agents to bundle uncommitted code-file edits into commits
// (one commit per concern) before ending a session, while explicitly
// telling them not to push. Two triggers:
//
// 1. Stop / SessionEnd — primary nudge. Fires when the count of distinct
//    non-doc files edited since the last commit exceeds `stop_threshold`.
//    Message strength escalates if cumulative session tokens are known
//    and cross the configured low/high bands.
//
// 2. Mid-session backstop — one-shot per session. Fires when the same
//    count crosses `mid_session_threshold` (default 40), which is a high
//    water mark — no agent should reach it under normal cadence.
//
// Doc/plan files are excluded from the count (markdown, /docs, /plans,
// /notes, CLAUDE.md, AGENTS.md, PLAN*.md). Editing transient planning
// scratch shouldn't trigger a commit nudge.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/** Default doc-file globs. Editable via `commit_cadence.doc_globs` config.
 *  These are paths/patterns whose edits do NOT count toward "uncommitted
 *  code-file work" — they're transient agent-scratch (plans, notes, docs)
 *  that legitimately churn during a session without needing commits. */
export const DEFAULT_DOC_GLOBS: readonly string[] = [
	"**/*.md",
	"**/*.mdx",
	"**/*.txt",
	"**/*.rst",
	"docs/**",
	"plans/**",
	"notes/**",
	"**/CLAUDE.md",
	"**/AGENTS.md",
	"**/PLAN*.md",
];

/**
 * Public API — pure predicate. Returns true iff the path should be
 * excluded from the "uncommitted code-file edits" count.
 *
 * Intentionally simple: a glob is matched against either the full path
 * or the basename. The recursive star, the single-segment star, and
 * the `?` wildcard are supported via a tiny custom matcher rather
 * than pulling in `minimatch` — this runs on every PostToolUse so
 * the hot-path matters more than feature completeness.
 */
export function isDocFile(filePath: string, docGlobs?: readonly string[]): boolean {
	const globs = docGlobs ?? DEFAULT_DOC_GLOBS;
	const normalized = filePath.replace(/\\/g, "/");
	const base = basename(normalized);
	for (const glob of globs) {
		if (matchesGlob(normalized, glob)) return true;
		if (matchesGlob(base, glob)) return true;
	}
	return false;
}

// Glob match: `**` is a recursive-segment wildcard, `*` matches non-slash
// chars, `?` matches a single non-slash char. Anchored by default, but
// relative-style globs like `plans/**` also try a recursive-prefix variant
// so absolute paths (e.g., `/repo/plans/q3.yaml`) still match.
function matchesGlob(target: string, glob: string): boolean {
	if (compileGlob(glob).test(target)) return true;
	if (!glob.startsWith("**") && !glob.startsWith("/")) {
		if (compileGlob(`**/${glob}`).test(target)) return true;
	}
	return false;
}

const globCache = new Map<string, RegExp>();
function compileGlob(glob: string): RegExp {
	const cached = globCache.get(glob);
	if (cached) return cached;
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			// consume optional trailing slash so `docs/**` matches `docs/x/y`
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else if (c === ".") {
			re += "\\.";
		} else if (/[\\^$+()|{}[\]]/.test(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	re += "$";
	const compiled = new RegExp(re);
	globCache.set(glob, compiled);
	return compiled;
}

export interface SessionTokens {
	input: number;
	output: number;
	total: number;
}

/**
 * Public API — read cumulative token usage for a session by parsing the
 * Claude Code transcript JSONL. Returns null when the path is missing,
 * unreadable, or contains no usage rows. Tolerates malformed lines.
 *
 * Called once at Stop time — not on every tool call — so a streaming /
 * cursored read isn't necessary. Synchronous to keep the Stop handler
 * simple; transcripts are typically <5MB even on long sessions.
 */
export function readSessionTokens(transcriptPath: string | undefined): SessionTokens | null {
	if (!transcriptPath) return null;
	if (!existsSync(transcriptPath)) return null;
	let raw: string;
	try {
		raw = readFileSync(transcriptPath, "utf-8");
	} catch {
		return null;
	}
	let input = 0;
	let output = 0;
	let saw = false;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		const usage = extractUsage(obj);
		if (!usage) continue;
		input += usage.input_tokens;
		output += usage.output_tokens;
		saw = true;
	}
	if (!saw) return null;
	return { input, output, total: input + output };
}

interface RawUsage {
	input_tokens: number;
	output_tokens: number;
}

function extractUsage(obj: unknown): RawUsage | null {
	if (!obj || typeof obj !== "object") return null;
	const o = obj as Record<string, unknown>;
	if (o.type !== "assistant") return null;
	const message = o.message as Record<string, unknown> | undefined;
	const usage = (message?.usage ?? o.usage) as Record<string, unknown> | undefined;
	if (!usage) return null;
	const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	if (input === 0 && output === 0) return null;
	return { input_tokens: input, output_tokens: output };
}

export interface FormatStopNudgeOpts {
	uncommittedNonDocCount: number;
	docFilesExcluded: number;
	threshold: number;
	cumulativeTokens?: number;
	tokenBandLow: number;
	tokenBandHigh: number;
}

/**
 * Public API — build the Stop-hook nudge string, or null when the count
 * is at or below the threshold. Strength scales by token band when
 * `cumulativeTokens` is provided.
 *
 * Wording is deliberately advisory ("strongly recommend", "before
 * ending") rather than imperative — this is a stderr nudge the agent
 * may choose to act on, not a `decision: "block"`. Hard-blocking at
 * Stop is the lever held in reserve.
 */
export function formatStopNudge(opts: FormatStopNudgeOpts): string | null {
	if (opts.uncommittedNonDocCount <= opts.threshold) return null;

	const docNote =
		opts.docFilesExcluded > 0
			? ` (${opts.docFilesExcluded} doc/plan file${opts.docFilesExcluded === 1 ? "" : "s"} excluded)`
			: "";

	const tokens = opts.cumulativeTokens;
	if (tokens !== undefined && tokens > opts.tokenBandHigh) {
		const tk = formatTokenK(tokens);
		return (
			`[interlinked:commit-cadence] Stopping with ${opts.uncommittedNonDocCount} uncommitted code-file edit(s)${docNote}, ` +
			`very long session (~${tk} tokens). Commit now — your context window is degrading. ` +
			"Bundle by concern: `git status` to review, then `git add <files> && git commit -m '<concern>'`. " +
			"Don't push."
		);
	}
	if (tokens !== undefined && tokens > opts.tokenBandLow) {
		const tk = formatTokenK(tokens);
		return (
			`[interlinked:commit-cadence] Stopping with ${opts.uncommittedNonDocCount} uncommitted code-file edit(s)${docNote}, ` +
			`long session (~${tk} tokens). Strongly recommend committing now while context is fresh. ` +
			"Bundle by concern: `git status` to review, then `git add <files> && git commit -m '<concern>'`. " +
			"Don't push."
		);
	}
	return (
		`[interlinked:commit-cadence] Stopping with ${opts.uncommittedNonDocCount} uncommitted code-file edit(s)${docNote}. ` +
		"Before ending: `git status` to review, then bundle by concern: " +
		"`git add <files> && git commit -m '<concern>'`. Don't push — leave that to the user."
	);
}

export interface FormatMidSessionBackstopOpts {
	uncommittedNonDocCount: number;
	threshold: number;
}

/**
 * Public API — build the mid-session backstop nudge, or null when below
 * threshold. Designed to fire ONCE per session at a high-water count
 * (default 40). Caller is responsible for the one-shot guard.
 */
export function formatMidSessionBackstop(opts: FormatMidSessionBackstopOpts): string | null {
	if (opts.uncommittedNonDocCount <= opts.threshold) return null;
	return (
		`[interlinked:commit-cadence] ${opts.uncommittedNonDocCount} distinct code file(s) edited since last commit — ` +
		"that's a lot to bundle into one concern. Run `git status` and " +
		"Commit incrementally now: group by concern, one commit per concern. Don't push."
	);
}

function formatTokenK(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}
