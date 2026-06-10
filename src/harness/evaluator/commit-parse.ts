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

// `node:path` posix helpers are pure string ops (no fs / env), so they keep this
// module's "no I/O" discipline while giving correct `..`/absolute handling when
// combining `cd` segments and `-C` flags into one effective directory.
import { posix } from "node:path";

/** The shape of a detected `git commit` invocation. */
export interface CommitParse {
	/** True when the command is a real `git commit` (not status/log/diff). */
	isCommit: boolean;
	/** True when `--no-verify` / `-n` is present (a bypass callers note in a warning). */
	noVerify: boolean;
	/**
	 * True when `-a` / `--all` is present (`git commit -a` / `-am`): the commit
	 * stages every tracked modification first, so the would-be snapshot is the
	 * working tree's tracked files. Absent/false for a plain `git commit`, whose
	 * snapshot is the INDEX only — the gate evaluates the staged tree, not the
	 * worktree, for those (finding 3).
	 */
	all?: boolean;
	/**
	 * True when the commit CONSTRUCTS its content during execution rather than
	 * committing the current index — a preceding `git add …` in the same compound
	 * command (`git add -A && git commit`) or a PATHSPEC commit (`git commit src/x.ts`,
	 * which stages those worktree paths). At PreToolUse the staging has not happened
	 * yet, so the index is stale; the gate evaluates the WORKING TREE for these so
	 * content is never left unevaluated (finding 4). The post-commit tree-hash
	 * reconciliation receipt is the principled general backstop (designed separately).
	 */
	constructsContent?: boolean;
	/**
	 * When `constructsContent` is set, the SPECIFIC worktree paths the command stages
	 * — the pathspecs of `git commit <paths>` and/or a narrow preceding `git add
	 * <paths>`. The gate restricts evaluation to these so an UNRELATED dirty file does
	 * not block the commit (finding 2026-06: the round-3 worktree-everything approach
	 * over-blocked, violating zero-FP). EMPTY/absent ⇒ a BROAD stage (`git add -A`/`.`/
	 * `-u`, or `--pathspec-from-file`) whose set is the whole worktree.
	 *
	 * Git's `--only`/`--include` semantics are modeled here (finding 2026-06): a
	 * pathspec commit WITHOUT `--include` commits ONLY the named paths (`--only` is
	 * git's default), so a narrow preceding `git add p` does NOT put `p` into this
	 * commit — its paths are excluded to keep the zero-FP contract. With `--include`,
	 * or with no pathspecs at all, the add's paths ARE captured and included.
	 */
	constructedPaths?: string[];
	/**
	 * True when the commit ALSO captures the PRE-EXISTING staged index, beyond the
	 * paths this command itself constructs: a plain `git add … && git commit` (no
	 * pathspec — commits the WHOLE index) or `git commit --include <paths>`. The
	 * gate must union the staged set into its evaluation set for these — filtering
	 * to `constructedPaths` alone let an already-staged source file's violations
	 * bypass the quality bar entirely (finding 2026-06). Absent for a pathspec
	 * commit without `--include` (git's `--only` default: the index is NOT
	 * committed) and for non-constructed commits (whose modes already evaluate the
	 * index directly).
	 */
	includesIndex?: boolean;
	/**
	 * The directory the commit effectively runs in, relative to the shell's own
	 * cwd (or absolute), when a `cd <dir>` prefix and/or one or more `git -C <dir>`
	 * flags redirect it — e.g. `cd sub && git commit` ⇒ `"sub"`, `git -C a -C b
	 * commit` ⇒ `"a/b"`. Undefined when the commit runs in the shell's own cwd.
	 * The commit gate resolves this against `event.cwd` so it evaluates the
	 * repository ACTUALLY being committed, not the parent (finding 4). Only literal
	 * targets are captured; a `cd $VAR` / `cd -` / `cd ~` that cannot be resolved
	 * statically leaves this undefined (the gate then falls back to `event.cwd`).
	 */
	cwd?: string;
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

/**
 * Combine a base directory with a `next` one the way a shell does: `next` absolute
 * → `next` wins; otherwise join (posix, so `..` and trailing slashes normalize).
 * `null` base/next are the "no override yet" identity. Used to fold a chain of
 * `cd` segments and compounding `-C` flags into a single effective directory.
 */
function combineCwd(base: string | null, next: string | null): string | null {
	if (next === null) return base;
	// Absolute (posix or Windows-drive) → it replaces whatever came before.
	if (posix.isAbsolute(next) || /^[A-Za-z]:[\\/]/.test(next)) return next;
	return base ? posix.join(base, next) : next;
}

/**
 * The literal target of a `cd <dir>` segment, or null when the segment is not a
 * plain `cd` or its target cannot be resolved statically (`cd` with no arg, `cd
 * -`, `cd ~...`, or only flags like `cd -P`). A non-literal `cd` deliberately
 * yields null so the caller leaves the effective cwd undefined rather than guess.
 */
function parseCdTarget(segment: string): string | null {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2 || tokens[0] !== "cd") return null;
	const dir = tokens.slice(1).find((t) => !t.startsWith("-"));
	if (dir === undefined || dir === "-" || dir.startsWith("~")) return null;
	return literalDir(dir);
}

/**
 * A directory token that can be resolved STATICALLY, or null. A target carrying a
 * shell variable, command substitution, or glob metachar ($, *, ?) cannot be
 * known at parse time, so it yields null and the caller leaves the effective cwd
 * undefined (falling back to the shell cwd) rather than treating it as a literal
 * directory name. Shared by the cd and -C paths so both degrade identically.
 */
function literalDir(dir: string): string | null {
	return /[$*?]/.test(dir) ? null : dir;
}

/** A `git commit` detected in ONE segment, plus the compounded `-C` directory
 *  (null when no `-C`). Internal — `parseGitCommit` folds it into a `CommitParse`. */
interface SegmentCommit {
	isCommit: boolean;
	noVerify: boolean;
	all: boolean;
	/** `--include`/`-i`: the commit captures the staged index IN ADDITION to its
	 *  pathspecs (vs git's `--only` default, which commits the named paths alone). */
	include: boolean;
	/** Specific positional pathspecs on the commit itself (`git commit src/x.ts`). */
	pathspecs: string[];
	/** `--pathspec-from-file` — a broad constructed-content commit (paths in a file). */
	pathspecFromFile: boolean;
	cDir: string | null;
}

/** True for a `-a` / `--all` flag, including a short cluster like `-am` / `-aq` —
 *  but NOT a letter inside an attached option value (`-mfair` is `-m fair`):
 *  only {@link clusterBooleanLetters} count. */
function isAllFlag(token: string): boolean {
	if (token === "--all") return true;
	return clusterBooleanLetters(token).includes("a");
}

/** True for `--include` / `-i`, including a short cluster like `-im`. Only the
 *  cluster's BOOLEAN letters count — `-mfix` is `-m` with the attached value
 *  `fix`, not a cluster containing `i` (finding 2026-06: it set includesIndex
 *  and false-blocked pathspec commits). In `git commit`'s short-flag set a
 *  boolean `i` IS `--include` to git itself, so this cannot false-positive.
 *  The long `--interactive` is deliberately NOT matched (exact `--include` only). */
function isIncludeFlag(token: string): boolean {
	if (token === "--include") return true;
	return clusterBooleanLetters(token).includes("i");
}

/** Commit flags that consume the FOLLOWING token as a value (so it is not a pathspec).
 *  `--pathspec-from-file` is deliberately NOT here — it SUPPLIES pathspecs, so it marks
 *  a constructed-content commit (handled first in `hasPathspec`). `-S`/`--gpg-sign` are
 *  deliberately NOT here either: their key id is OPTIONAL and attached-only
 *  (`-Skey`, `--gpg-sign=key`), so `git commit -S file.ts` keeps `file.ts` as a
 *  pathspec — consuming it as a "value" silently dropped the pathspec and the gate
 *  evaluated the wrong commit model (finding 2026-06, attached-value class). */
const COMMIT_VALUE_FLAGS = new Set([
	"-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
	"--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup",
	// Repeatable; its "token: value" argument read as a PATHSPEC without this, so
	// `git commit --trailer "X: y" …` narrowed the changed set to a nonexistent
	// path and every staged file bypassed the gate (finding 2026-06).
	"--trailer",
]);

/** Short letters whose value may be ATTACHED (`-mfix`) or the SEPARATE next token
 *  (`-m fix`). Everything after such a letter in a cluster is its value. */
const VALUE_SHORT_LETTERS = "mFCct";

/** Short letters whose value is OPTIONAL and attached-only (`-S[keyid]`,
 *  `-u[mode]`): they terminate cluster scanning (any trailing chars are the
 *  attached value) but NEVER consume the next token. */
const OPTIONAL_ATTACHED_LETTERS = "Su";

/**
 * The BOOLEAN flag letters of a short cluster, respecting attached option
 * values: scanning stops at the first value-taking letter, because everything
 * after it is that option's ATTACHED VALUE, not more flags. `-mfix` is
 * `-m fix` — NO boolean flags — and must not read as a cluster containing `i`
 * (finding 2026-06: it set includesIndex and the default-on commit gate
 * evaluated unrelated staged files, a deterministic false block). `-amfix` is
 * `-a -m fix` → "a". Non-letter characters likewise end the scan. Returns ""
 * for long flags (`--…`) and non-flag tokens.
 */
function clusterBooleanLetters(token: string): string {
	if (token.length < 2 || token[0] !== "-" || token[1] === "-") return "";
	let letters = "";
	for (const ch of token.slice(1)) {
		if (!/[A-Za-z]/.test(ch)) return letters;
		if (VALUE_SHORT_LETTERS.includes(ch) || OPTIONAL_ATTACHED_LETTERS.includes(ch)) {
			return letters;
		}
		letters += ch;
	}
	return letters;
}

/** True when a short cluster consumes the FOLLOWING token as its value, so that
 *  token is not a pathspec: the cluster's first value-taking letter is its LAST
 *  character (`-am "wip"` → wip is the message). A value-taking letter with
 *  trailing characters has its value ATTACHED (`-amfix`), and an
 *  optional-attached letter (`-S`, `-u`) never consumes the next token. */
function shortClusterTakesValue(token: string): boolean {
	if (token.length < 2 || token[0] !== "-" || token[1] === "-") return false;
	const letters = token.slice(1);
	for (let i = 0; i < letters.length; i++) {
		const ch = letters[i] ?? "";
		if (!/[A-Za-z]/.test(ch)) return false;
		if (OPTIONAL_ATTACHED_LETTERS.includes(ch)) return false;
		if (VALUE_SHORT_LETTERS.includes(ch)) return i === letters.length - 1;
	}
	return false;
}

/** The SPECIFIC positional pathspecs of a commit's `rest` (after "commit"): bare
 *  positionals plus everything after a `--`. Flags (and their values) are skipped;
 *  `--pathspec-from-file` is broad (paths live in a file) and contributes none. */
function commitPathspecs(rest: string[]): string[] {
	const paths: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const t = rest[i];
		if (t === "--") {
			for (let k = i + 1; k < rest.length; k++) paths.push(rest[k]);
			break;
		}
		// The SEPARATE-value form consumes its file argument too — without the `i++`
		// the list file itself read as a pathspec and the gate evaluated it instead
		// of the sources named inside (finding 2026-06). The commit is already
		// marked broad via `hasPathspecFromFile`.
		if (t === "--pathspec-from-file") {
			i++;
			continue;
		}
		if (t.startsWith("--pathspec-from-file=")) continue;
		if (t.startsWith("-")) {
			if (COMMIT_VALUE_FLAGS.has(t) || shortClusterTakesValue(t)) i++; // its value is not a pathspec
			continue;
		}
		paths.push(t); // bare positional → pathspec
	}
	return paths;
}

/** True when the commit reads pathspecs from a file (`--pathspec-from-file[=<file>]`) —
 *  a constructed-content commit whose path set is broad/unknown (finding 2026-06). */
function hasPathspecFromFile(rest: string[]): boolean {
	return rest.some((t) => t === "--pathspec-from-file" || t.startsWith("--pathspec-from-file="));
}

/** Characters that make a pathspec NON-literal: glob (star / `?` / brackets / braces),
 *  shell variable or substitution (dollar), tilde expansion. A plain string scanned
 *  char-by-char (not a regex char class) for lexer friendliness. */
const NON_LITERAL_PATHSPEC_CHARS = "*?[]$~{}";

/**
 * True when a pathspec cannot be matched LITERALLY against changed-file paths:
 * glob chars, shell variables, tilde expansion, or git pathspec magic (leading `:`).
 * Git/the shell expands these at run time, so an exact-match filter would match
 * NOTHING and the gate would silently evaluate no source (finding 2026-06) — the
 * caller treats any non-literal spec as BROAD instead.
 */
function isNonLiteralPathspec(spec: string): boolean {
	for (const ch of NON_LITERAL_PATHSPEC_CHARS) {
		if (spec.includes(ch)) return true;
	}
	return spec.startsWith(":");
}

/** Paths a `git add` segment stages, and whether it stages BROADLY (`-A`/`.`/`-u`). */
function addSegmentPaths(segment: string): { paths: string[]; broad: boolean } {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	const { subIdx } = scanGitGlobalFlags(tokens);
	if (subIdx < 0) return { paths: [], broad: false };
	const paths: string[] = [];
	for (const t of tokens.slice(subIdx + 1)) {
		if (t === "-A" || t === "--all" || t === "-u" || t === "--update" || t === ".") {
			return { paths: [], broad: true }; // stages the whole worktree
		}
		// File-mediated pathspecs (`--pathspec-from-file files.txt`, `=<file>`, or
		// `-` for stdin): the real staged paths live INSIDE the file, which a static
		// parse cannot read — so this add is BROAD, never "the list file is the path"
		// (finding 2026-06: the gate evaluated files.txt itself and the named sources
		// bypassed). Same indirection class as pip's `-r requirements.txt`.
		if (t === "--pathspec-from-file" || t.startsWith("--pathspec-from-file=")) {
			return { paths: [], broad: true };
		}
		if (t === "--" || t.startsWith("-")) continue; // separator / other add flags
		paths.push(t);
	}
	return { paths, broad: false };
}

/** True when a segment is a `git add …` (its staging constructs the commit's content). */
function isGitAddSegment(segment: string): boolean {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2) return false;
	const head = tokens[0];
	if (head !== "git" && !head.endsWith("/git")) return false;
	const { subIdx } = scanGitGlobalFlags(tokens);
	return subIdx >= 0 && tokens[subIdx] === "add";
}

/**
 * Advance past git's global flags (`-C <dir>`, `-c key=val`, `--no-pager`, …) to
 * the subcommand token. Returns its index (or -1) AND the compounded `-C`
 * directory: multiple `-C` flags compound exactly like `cd` (each relative `-C`
 * is interpreted against the preceding one), so they fold through `combineCwd`.
 */
function scanGitGlobalFlags(tokens: string[]): { subIdx: number; cDir: string | null } {
	let i = 1;
	let cDir: string | null = null;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t === "-C") {
			const raw = tokens[i + 1];
			const dir = raw !== undefined ? literalDir(raw) : null;
			if (dir !== null) cDir = combineCwd(cDir, dir);
			i += 2; // flag + its argument
			continue;
		}
		if (t === "-c") {
			i += 2; // config `key=val` — consume both
			continue;
		}
		if (t.startsWith("-")) {
			i += 1;
			continue;
		}
		return { subIdx: i, cDir };
	}
	return { subIdx: -1, cDir };
}

/** Parse ONE shell segment for a `git commit`, capturing its `-C` dir, or null. */
function parseSegment(segment: string): SegmentCommit | null {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2) return null;
	// Head must be `git` (or a path ending in /git), not a comment or other binary.
	const head = tokens[0];
	if (head !== "git" && !head.endsWith("/git")) return null;

	const { subIdx, cDir } = scanGitGlobalFlags(tokens);
	if (subIdx < 0 || tokens[subIdx] !== "commit") return null;

	const rest = tokens.slice(subIdx + 1);
	// `-n` may ride in a cluster (`-anm "x"`); attached values are excluded the
	// same way as for -a / -i (clusterBooleanLetters).
	const noVerify = rest.some((t) => t === "--no-verify" || clusterBooleanLetters(t).includes("n"));
	const all = rest.some(isAllFlag);
	return {
		isCommit: true,
		noVerify,
		all,
		include: rest.some(isIncludeFlag),
		pathspecs: commitPathspecs(rest),
		pathspecFromFile: hasPathspecFromFile(rest),
		cDir,
	};
}

/** What the preceding `git add` segments of a compound command staged. */
interface AddState {
	sawGitAdd: boolean;
	addBroad: boolean;
	addPaths: string[];
}

/**
 * Fold the constructed-content path set and index-inclusion onto `parse`,
 * modeling git's `--only`/`--include` semantics (finding 2026-06):
 *
 *   - A pathspec commit WITHOUT `--include` commits ONLY the named paths
 *     (`--only` is git's default): a preceding `git add` — narrow or broad —
 *     changes the INDEX but not THIS commit's content, so its paths are
 *     excluded from the evaluation set (zero-FP: an unrelated staged file must
 *     not block) and the index is NOT marked included.
 *   - With `--include`, or with no pathspecs at all after a `git add`, the
 *     commit captures the staged index too → `includesIndex` tells the gate to
 *     union the staged set (previously those files bypassed evaluation).
 *
 * Paths stay SPECIFIC only when knowable statically — otherwise BROAD (evaluate
 * everything; the narrow filter exists only to avoid false BLOCKS, so unknowable
 * must fail toward evaluating MORE, never less):
 *   - `git add -A`/`.`/`-u` (when its paths are captured) / `--pathspec-from-file`
 *     — whole worktree;
 *   - `git commit -a` — `-a` stages EVERY tracked modification (finding 2026-06);
 *   - any NON-LITERAL pathspec (glob / variable / pathspec magic) — git expands
 *     it at run time, so an exact-match filter would match nothing and silently
 *     evaluate NO source (finding 2026-06).
 */
function applyConstructedContent(parse: CommitParse, seg: SegmentCommit, add: AddState): void {
	const onlyNamedPaths = seg.pathspecs.length > 0 && !seg.include;
	const specific = onlyNamedPaths ? [...seg.pathspecs] : [...seg.pathspecs, ...add.addPaths];
	const broad =
		(onlyNamedPaths ? false : add.addBroad) ||
		seg.pathspecFromFile ||
		seg.all ||
		specific.some(isNonLiteralPathspec);
	if (!broad && specific.length > 0) parse.constructedPaths = specific;
	if (seg.include || (add.sawGitAdd && seg.pathspecs.length === 0 && !seg.pathspecFromFile)) {
		parse.includesIndex = true;
	}
}

/**
 * Detect whether ANY segment of `command` is a real `git commit`. Distinguishes
 * `git commit` / `git commit -m` / `git commit -am` / `git commit --amend` from
 * non-commit git verbs (status / log / diff / show), `commit-graph`/`commit-tree`
 * (different subcommands), and a `# git commit` comment.
 *
 * Working-directory aware (finding 4): a `cd <dir>` prefix chain and the commit's
 * own `git -C <dir>` flag(s) are folded into `CommitParse.cwd` (relative to the
 * shell's cwd) so the gate evaluates the repo actually being committed —
 * `cd repo && git commit` and `git -C repo commit` both surface `cwd: "repo"`.
 * Returns the parse for the first matching segment, or `null`.
 */
export function parseGitCommit(command: string): CommitParse | null {
	if (!command || typeof command !== "string") return null;
	let runCwd: string | null = null; // accumulated `cd` chain, relative to shell cwd
	let sawGitAdd = false; // a `git add …` before the commit constructs its content
	let addBroad = false; // a `git add -A`/`.`/`-u` stages the whole worktree
	const addPaths: string[] = []; // narrow `git add <paths>` staged paths
	for (const segment of splitSegments(command)) {
		const cd = parseCdTarget(segment);
		if (cd !== null) {
			runCwd = combineCwd(runCwd, cd);
			continue;
		}
		if (isGitAddSegment(segment)) {
			sawGitAdd = true;
			const a = addSegmentPaths(segment);
			if (a.broad) addBroad = true;
			else addPaths.push(...a.paths);
			continue;
		}
		const seg = parseSegment(segment);
		if (seg) {
			const effective = combineCwd(runCwd, seg.cDir);
			const parse: CommitParse = { isCommit: seg.isCommit, noVerify: seg.noVerify };
			if (seg.all) parse.all = true;
			if (sawGitAdd || seg.pathspecs.length > 0 || seg.pathspecFromFile) {
				parse.constructsContent = true;
				applyConstructedContent(parse, seg, { sawGitAdd, addBroad, addPaths });
			}
			if (effective !== null) parse.cwd = effective;
			return parse;
		}
	}
	return null;
}
