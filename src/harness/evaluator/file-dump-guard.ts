// ===========================================
// File-Dump Guard (PreToolUse) — tail/head/cat budgets
// ===========================================
//
// Stops Bash invocations of `tail`, `head`, and `cat` from dumping a huge
// or unfiltered payload into the tool result. Three blocking cases:
//
//   1. `tail -f` / `tail -F` in the foreground (no trailing `&`) — hangs.
//   2. No downstream filter & no output redirection & file > 100KB — blocks
//      at any requested line count, including the default 10.
//   3. No downstream filter & no output redirection & lines requested > 50
//      — blocks regardless of file size.
//
// And one soft ceiling (warning, not block):
//
//   4. With a filter, but lines requested > 1000 — the filter usually bounds
//      output but at 1000+ lines even a `jq -r '.f'` projection can produce
//      a lot. Caller surfaces this as a warning.
//
// Bypasses:
//   * Output redirection (`>`, `>>`, `&>`, `\d+>`) — bytes never hit the
//     tool result.
//   * `head -c` / `tail -c` — byte-count bounds output, treated as a filter.
//
// The size check requires `fs.statSync` and so cannot be expressed as a
// pure regex rule in `builtin-rules.ts`. Mirrors the inline check in
// `lib/hook-template-chunks/guards-inline.ts` per the two-implementations
// memory (see `project_hook_paths_two_implementations.md`).

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { HarnessDecision } from "../types.js";

/** File-size threshold above which an unfiltered dump is refused. */
const FILE_SIZE_BLOCK_BYTES = 100 * 1024;
/** Line-count cap when no filter is present in the pipeline. */
const NO_FILTER_MAX_LINES = 50;
/** Soft warning ceiling when a filter is present. */
const WITH_FILTER_SOFT_CEILING = 1000;

/**
 * Output-reducing filters the agent can pipe into. First token of each
 * downstream pipeline segment is checked against this set. `cat` and `tee`
 * are deliberately omitted (passthrough, not filters).
 */
const FILTER_COMMANDS = new Set([
	"jq",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ripgrep",
	"ag",
	"awk",
	"gawk",
	"mawk",
	"sed",
	"head",
	"tail",
	"wc",
	"cut",
	"sort",
	"uniq",
	"fzf",
	"less",
	"more",
]);

/** Verb tokens this guard applies to. */
const DUMP_VERBS = new Set(["tail", "head", "cat"]);

export interface FileDumpGuardArgs {
	/** Raw Bash command string from `tool_input.command`. */
	command: string;
	/** Working directory used to resolve relative file paths for stat. */
	cwd: string;
}

export type FileDumpGuardResult =
	| { kind: "block"; decision: HarnessDecision }
	| { kind: "warn"; message: string }
	| { kind: "allow" };

/**
 * Public API — consumed by `evaluator/pre-tool.ts`. Returns a block decision,
 * an advisory warning, or `allow` for the given Bash command. Cheap on
 * non-matching commands: bails out before any fs syscall when the first
 * verb isn't tail/head/cat.
 */
export function evaluateFileDumpGuard(args: FileDumpGuardArgs): FileDumpGuardResult {
	const { command, cwd } = args;
	if (!command) return { kind: "allow" };

	const segments = splitPipeline(command);
	if (segments.length === 0) return { kind: "allow" };

	const first = segments[0] ?? "";
	const tokens = tokenize(first);
	stripLeadingWrappers(tokens);
	const verb = tokens[0];
	if (!verb || !DUMP_VERBS.has(verb)) return { kind: "allow" };

	// 1. tail -f / -F. Foreground hangs the tool call → block. Backgrounded
	// (with trailing `&` or wrapped in `nohup`) is a streaming command whose
	// total output is unbounded and not in the tool-result budget, so skip
	// the remaining size/line-count checks entirely.
	if (verb === "tail" && hasFollowFlag(tokens)) {
		const trailingAmp = /(?:^|[^&])&\s*$/.test(command);
		const nohup = /^\s*nohup\s+/.test(command);
		if (!trailingAmp && !nohup) {
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						"BLOCKED: `tail -f` in the foreground will hang the tool call indefinitely. " +
						"Run it in the background (`tail -f ... &`), use the runner's background flag, " +
						"or use the Monitor tool for streaming output.",
					rule_id: "builtin-tail-follow-foreground",
					severity: "high",
					category: "command-shape",
				},
			};
		}
		return { kind: "allow" };
	}

	// 2. Output redirection → bypass size/line-count checks; the bytes go
	// to disk, not the tool result.
	if (hasOutputRedirect(command)) return { kind: "allow" };

	// 3. Detect a filter anywhere downstream in the pipeline.
	let hasFilter = false;
	for (const seg of segments.slice(1)) {
		const t = (seg.trim().match(/^([\w.-]+)/) || [])[1];
		if (t && FILTER_COMMANDS.has(stripPathPrefix(t))) {
			hasFilter = true;
			break;
		}
	}

	// 4. Byte-bounded slice (-c N) on head/tail caps output regardless of
	// whether the agent piped to anything; treat as filter-equivalent.
	const cFlag = parseCountFlag(tokens, "-c");
	if (cFlag !== null && (verb === "head" || verb === "tail")) hasFilter = true;

	// 5. Extract requested line count and file path args.
	const requestedLines = parseCountFlag(tokens, "-n");
	const filePaths = extractFilePaths(tokens, verb);

	// 6. If we couldn't resolve any concrete file path (glob, command
	// substitution, stdin), be permissive — don't risk false positives.
	if (filePaths.length === 0) return { kind: "allow" };

	// 7. Stat the file args. For `cat` without `-n`, also count newlines so
	// a small file isn't blocked just for the verb. We block if ANY file
	// exceeds the size threshold.
	let largestBytes = 0;
	let largestPath = "";
	let aggregateNewlines = 0;
	let catLineCountKnown = false;
	for (const fp of filePaths) {
		const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
		try {
			if (!existsSync(abs)) continue;
			const stat = statSync(abs);
			if (!stat.isFile()) continue;
			if (stat.size > largestBytes) {
				largestBytes = stat.size;
				largestPath = fp;
			}
			if (verb === "cat" && requestedLines === null && stat.size <= FILE_SIZE_BLOCK_BYTES) {
				try {
					const content = readFileSync(abs, "utf8");
					aggregateNewlines += (content.match(/\n/g) || []).length;
					catLineCountKnown = true;
				} catch {
					// non-fatal: a readFileSync failure leaves catLineCountKnown
					// unchanged; the resulting `lines = Infinity` is the conservative
					// (block-favoring) fallback.
				}
			}
		} catch {
			// Best-effort; stat errors must not break the guard.
		}
	}

	let lines: number;
	if (requestedLines !== null) {
		lines = requestedLines;
	} else if (verb === "cat") {
		lines = catLineCountKnown ? aggregateNewlines : Infinity;
	} else {
		lines = 10;
	}

	if (!hasFilter) {
		if (largestBytes > FILE_SIZE_BLOCK_BYTES) {
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						`BLOCKED: \`${verb}\` on ${largestPath} (${formatBytes(largestBytes)}) without a downstream filter ` +
						`would dump a large payload into the tool result. Pipe through one of: ` +
						`jq | grep | rg | awk | sed | head | wc | cut | sort | uniq. ` +
						`If you need the raw bytes on disk, redirect: \`${verb} ... > /tmp/sample\`. ` +
						`To check the file first, run \`wc -l ${largestPath}\`.`,
					rule_id: "builtin-file-dump-large-file",
					severity: "high",
					category: "command-shape",
				},
			};
		}
		if (lines > NO_FILTER_MAX_LINES) {
			const linesDesc = lines === Infinity ? "an entire file" : `${lines} lines`;
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason:
						`BLOCKED: \`${verb}\` requesting ${linesDesc} without a downstream filter caps out the tool-result budget. ` +
						`Cap at ${NO_FILTER_MAX_LINES} lines, or narrow with a filter (jq / grep / awk / head). ` +
						`If you really need the raw bytes, redirect: \`${verb} ... > /tmp/sample\`.`,
					rule_id: "builtin-file-dump-too-many-lines",
					severity: "high",
					category: "command-shape",
				},
			};
		}
		return { kind: "allow" };
	}

	// With a filter: soft ceiling. The filter bounds output in practice but
	// 1000+ lines is still worth flagging.
	if (lines !== Infinity && lines > WITH_FILTER_SOFT_CEILING) {
		return {
			kind: "warn",
			message:
				`[interlinked:file-dump] \`${verb} -n ${lines}\` is past the ${WITH_FILTER_SOFT_CEILING}-line soft ceiling even with a filter. ` +
				`If the filter is selective the output stays small, but tighten the line count if you can.`,
		};
	}

	return { kind: "allow" };
}

/**
 * Splits on pipeline `|` boundaries while respecting single/double/backtick
 * quoting. Does not split on `||` (boolean OR). Compound separators (`;`,
 * `&&`) are already decomposed upstream by `command-decomposition.ts`.
 */
function splitPipeline(command: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: '"' | "'" | "`" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (q) {
			buf += ch;
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			q = ch as '"' | "'" | "`";
			buf += ch;
			continue;
		}
		if (ch === "|") {
			if (command[i + 1] === "|") {
				buf += "||";
				i++;
				continue;
			}
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

/** Whitespace + quote-aware tokenizer for a single pipeline segment. */
function tokenize(segment: string): string[] {
	const out: string[] = [];
	let buf = "";
	let q: '"' | "'" | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (q) {
			if (ch === q) {
				q = null;
				continue;
			}
			buf += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch as '"' | "'";
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf) {
				out.push(buf);
				buf = "";
			}
			continue;
		}
		buf += ch;
	}
	if (buf) out.push(buf);
	return out;
}

/** Drops `sudo|exec|nohup|command`, `env VAR=val`, and bare `VAR=val` prefixes. */
function stripLeadingWrappers(tokens: string[]): void {
	while (tokens.length > 0) {
		const t = tokens[0];
		if (t === "sudo" || t === "exec" || t === "nohup" || t === "command") {
			tokens.shift();
			continue;
		}
		if (t === "env") {
			tokens.shift();
			while (tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift();
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(t)) {
			tokens.shift();
			continue;
		}
		break;
	}
}

/**
 * Checks for `-f` / `-F` (follow modes) anywhere in the flag tokens. Handles
 * both `-f` standalone and combined short flags like `-Fn5`.
 */
function hasFollowFlag(tokens: string[]): boolean {
	for (const t of tokens.slice(1)) {
		if (t.startsWith("--")) continue;
		if (!t.startsWith("-")) break;
		// Combined short flags: -f, -fF, -nf, etc.
		const flagBody = t.slice(1);
		if (/[fF]/.test(flagBody)) return true;
	}
	return false;
}

/**
 * Detects output redirection in the raw command string. Excludes `<<` (heredoc),
 * `>=` and `=>` (operators that may appear in quoted strings — but we accept
 * the imperfection since redirects outside quotes are the common case).
 */
function hasOutputRedirect(command: string): boolean {
	// `>>`, `>`, `&>`, `\d+>` outside of pure quoted regions.
	// Simple sweep with a quote-respecting state machine.
	let q: '"' | "'" | "`" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (q) {
			if (ch === q) q = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			q = ch as '"' | "'" | "`";
			continue;
		}
		if (ch === ">") {
			const prev = command[i - 1];
			const next = command[i + 1];
			// Skip `>=` and `=>` (arithmetic/comparison contexts inside test commands)
			if (next === "=" || prev === "=") continue;
			return true;
		}
	}
	return false;
}

/**
 * Parses a numeric flag (`-n N`, `-n+N`, `-nN`, `--lines=N`) out of the token
 * stream. Returns the integer count or `null` if not present / not parseable.
 */
function parseCountFlag(tokens: string[], shortFlag: "-n" | "-c"): number | null {
	const longFlag = shortFlag === "-n" ? "--lines" : "--bytes";
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === shortFlag) {
			const next = tokens[i + 1];
			if (next === undefined) return null;
			const m = next.match(/^\+?(\d+)\b/);
			return m ? parseInt(m[1], 10) : null;
		}
		if (t.startsWith(`${shortFlag}=`)) {
			const m = t.slice(shortFlag.length + 1).match(/^\+?(\d+)\b/);
			return m ? parseInt(m[1], 10) : null;
		}
		// Combined: `-n50`, `-n+50`
		if (t.startsWith(shortFlag) && t.length > shortFlag.length && /^\+?\d/.test(t[shortFlag.length])) {
			const m = t.slice(shortFlag.length).match(/^\+?(\d+)\b/);
			return m ? parseInt(m[1], 10) : null;
		}
		if (t.startsWith(`${longFlag}=`)) {
			const m = t.slice(longFlag.length + 1).match(/^\+?(\d+)\b/);
			return m ? parseInt(m[1], 10) : null;
		}
		if (t === longFlag) {
			const next = tokens[i + 1];
			if (next === undefined) return null;
			const m = next.match(/^\+?(\d+)\b/);
			return m ? parseInt(m[1], 10) : null;
		}
	}
	return null;
}

/**
 * Extracts positional file path arguments from the token stream. Returns
 * empty array when the args contain a glob, command substitution, or other
 * shape we can't safely stat — so the guard fails open on uncertain inputs.
 */
function extractFilePaths(tokens: string[], verb: string): string[] {
	const out: string[] = [];
	// Flags that take a separate value argument.
	const flagsWithValue = new Set(["-n", "-c", "--lines", "--bytes"]);
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) continue;
		// End-of-flags marker
		if (t === "--") {
			for (const f of tokens.slice(i + 1)) if (f) out.push(f);
			break;
		}
		if (t.startsWith("-")) {
			// `-n 50` form: skip next token.
			if (flagsWithValue.has(t)) i++;
			continue;
		}
		// Bail on shapes we can't stat reliably.
		if (/[*?[\]]/.test(t)) return [];
		if (t.includes("$(") || t.startsWith("`") || t.startsWith("$")) return [];
		out.push(t);
	}
	// `cat` reading stdin (no positional arg) is fine — return empty.
	if (out.length === 0) return [];
	// `tail` / `head` numeric-only obsolete syntax (`tail -50 file`) — unusual,
	// not bothering to parse; if we picked up a number as a "file" we'd stat
	// fail and silently allow. Acceptable.
	void verb;
	return out;
}

/** Best-effort strip of a leading path on a command name, e.g. `/usr/bin/jq` → `jq`. */
function stripPathPrefix(token: string): string {
	const idx = token.lastIndexOf("/");
	return idx >= 0 ? token.slice(idx + 1) : token;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
