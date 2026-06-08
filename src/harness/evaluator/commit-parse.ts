// ===========================================
// git-commit detection (robust) — shared by the commit-time quality gate
// ===========================================
// Pure shell-parsing helpers that decide whether a Bash command is a real
// `git commit` (as opposed to `git status` / `log` / `diff`, a `commit-graph`
// subcommand, or a `# git commit` comment). Extracted from `commit-gate.ts` so
// the gate's decision logic stays under the per-file line cap and the parser can
// be unit-tested in isolation.
//
// No fs, no env, no module-scope state — same discipline as
// `package-install-parser.ts`. Quote-aware enough to keep a quoted commit
// message (`-m "fix: x && y"`) one token so its inner `&&` is not mistaken for a
// segment separator, and to skip git's global flags (`-C <dir>`, `-c key=val`).

/** The shape of a detected `git commit` invocation. */
export interface CommitParse {
	/** True when the command is a real `git commit` (not status/log/diff). */
	isCommit: boolean;
	/** True when `--no-verify` / `-n` is present (a bypass callers note in a warning). */
	noVerify: boolean;
}

/**
 * Minimal shell-aware splitter: handles single + double quotes and backslash
 * escapes so a quoted commit message stays one token. NOT a general bash parser.
 */
function shellSplit(input: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === "\\" && i + 1 < input.length && !inSingle) {
			cur += input[i + 1];
			i++;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(c) && !inSingle && !inDouble) {
			if (cur.length > 0) {
				out.push(cur);
				cur = "";
			}
			continue;
		}
		cur += c;
	}
	if (cur.length > 0) out.push(cur);
	return out;
}

/** Append the current buffer as a segment and reset it. */
function pushSegment(segments: string[], cur: string): string {
	if (cur.length > 0) segments.push(cur);
	return "";
}

/** Mutable scan state shared by the segment splitter's per-character helpers. */
interface SegmentScan {
	cur: string;
	inSingle: boolean;
	inDouble: boolean;
}

/**
 * Handle a backslash-escape or a quote toggle at character `c`. Returns the
 * number of EXTRA characters consumed (1 for an escape that swallowed the next
 * char, 0 for a quote toggle), or `null` when `c` is neither — so the caller
 * falls through to separator / literal handling. Mutates `scan` in place.
 */
function consumeQuoteOrEscape(scan: SegmentScan, c: string, next: string | undefined): number | null {
	if (c === "\\" && next !== undefined && !scan.inSingle) {
		scan.cur += c + next;
		return 1;
	}
	if (c === "'" && !scan.inDouble) {
		scan.inSingle = !scan.inSingle;
		scan.cur += c;
		return 0;
	}
	if (c === '"' && !scan.inSingle) {
		scan.inDouble = !scan.inDouble;
		scan.cur += c;
		return 0;
	}
	return null;
}

/** True when `c` is a top-level (unquoted) shell separator: `;`, `|`, `&`. */
function isTopLevelSeparator(scan: SegmentScan, c: string): boolean {
	return !scan.inSingle && !scan.inDouble && (c === ";" || c === "|" || c === "&");
}

/**
 * Split a compound shell line into top-level segments on `;`, `&&`, `||`, and
 * pipes — quote-aware so a separator inside a commit message is ignored. Each
 * segment is parsed for a `git commit` independently (so `cd x && git commit -m y`
 * is detected). The per-character quote / escape / separator logic lives in
 * {@link consumeQuoteOrEscape} and {@link isTopLevelSeparator} to keep this loop
 * low-complexity.
 */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	const scan: SegmentScan = { cur: "", inSingle: false, inDouble: false };
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		const consumed = consumeQuoteOrEscape(scan, c, next);
		if (consumed !== null) {
			i += consumed;
			continue;
		}
		if (isTopLevelSeparator(scan, c)) {
			// Consume a paired `&&` / `||` as one separator.
			if ((c === "&" && next === "&") || (c === "|" && next === "|")) i++;
			scan.cur = pushSegment(segments, scan.cur);
			continue;
		}
		scan.cur += c;
	}
	pushSegment(segments, scan.cur);
	return segments;
}

/** Drop a leading `sudo` / `env VAR=…` / `VAR=…` prefix so `git` is the head token. */
function stripLeadingPrefix(tokens: string[]): string[] {
	const out = tokens.slice();
	while (out.length > 0) {
		const head = out[0];
		if (head === "sudo" || head === "command" || head === "nohup" || head === "time") {
			out.shift();
			continue;
		}
		if (head === "env") {
			out.shift();
			while (out[0] && /^[A-Za-z_]\w*=/.test(out[0])) out.shift();
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(head)) {
			out.shift();
			continue;
		}
		break;
	}
	return out;
}

/** Advance past git's global flags (`-C <dir>`, `-c key=val`, `--no-pager`, …) to
 *  the index of the subcommand token, or -1 when none follows. */
function subcommandIndex(tokens: string[]): number {
	let i = 1;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t === "-C" || t === "-c") {
			i += 2; // flag + its argument
			continue;
		}
		if (t.startsWith("-")) {
			i += 1;
			continue;
		}
		return i;
	}
	return -1;
}

/** Parse ONE shell segment for a `git commit`, or null. */
function parseSegment(segment: string): CommitParse | null {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2) return null;
	// Head must be `git` (or a path ending in /git), not a comment or other binary.
	const head = tokens[0];
	if (head !== "git" && !head.endsWith("/git")) return null;

	const subIdx = subcommandIndex(tokens);
	if (subIdx < 0 || tokens[subIdx] !== "commit") return null;

	const rest = tokens.slice(subIdx + 1);
	const noVerify = rest.some((t) => t === "--no-verify" || t === "-n");
	return { isCommit: true, noVerify };
}

/**
 * Detect whether ANY segment of `command` is a real `git commit`. Distinguishes
 * `git commit` / `git commit -m` / `git commit -am` / `git commit --amend` from
 * non-commit git verbs (status / log / diff / show), `commit-graph`/`commit-tree`
 * (different subcommands), and a `# git commit` comment. A leading
 * `git -C <dir>` / `-c key=val` global flag run is skipped so `git -C repo commit`
 * is still recognized. Returns the parse for the first matching segment, or `null`.
 */
export function parseGitCommit(command: string): CommitParse | null {
	if (!command || typeof command !== "string") return null;
	for (const segment of splitSegments(command)) {
		const parse = parseSegment(segment);
		if (parse) return parse;
	}
	return null;
}
