// interlinked-tdd: exempt

// ===========================================
// Check: Bash-routed code-file writes
// ===========================================
// Detects shell commands that write to a tracked source-file extension via
// redirection or inline interpreter calls. These bypass the content-quality
// gates that run on Write/Edit/MultiEdit (pre_block registry, biome and tsc
// diff-overlay). Returning a non-null result tells the caller to block with
// a message asking the agent to use the Write tool instead.

/** File extensions the harness's content-gate checks care about. */
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { nonNull } from "../lib/non-null.js";

export const CODE_FILE_EXT_RE =
	/\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|swift|c|cc|cpp|cxx|h|hpp|hxx|rb|php|cs|scala|clj|sh|bash|zsh)$/i;

/**
 * True when the write target lands INSIDE the guarded project root — the only
 * territory the content-quality gates protect. A code-extension file in the
 * session scratchpad, /tmp, or any other out-of-repo path is NOT a "tracked
 * source file", and blocking it was a measured false positive (2026-07-06
 * dogfood: a scratchpad .mts probe script). `~` is expanded (bash would);
 * with no root available the guard keeps its historical conservative reach.
 * A target that cannot be resolved (leading `$VAR` with no same-command
 * assignment) is NOT provably in-root, so it passes through (2026-07-09
 * dogfood FP: `> $SCRATCH/schema-draft.ts` was literal-resolved to
 * `<root>/$SCRATCH/…` and blocked as a tracked source file).
 */
function withinGuardedRoot(
	target: string,
	projectRoot: string | undefined,
	vars: ReadonlyMap<string, string>,
	base: string | null | undefined,
): boolean {
	if (!projectRoot) return true; // no root context ⇒ preserve old behavior
	const abs = resolveTargetForRootCheck(target, vars, base === undefined ? projectRoot : base);
	if (abs === null) return false;
	const root = resolve(projectRoot);
	return abs === root || abs.startsWith(root + sep);
}

/** Absolutize a redirect/verb target the way the shell would: expand a
 *  leading variable, expand `~`, then resolve relative paths against `base`
 *  (the project root, or the last same-command `cd` destination). Returns
 *  null when the leading variable has no known value — or when the target is
 *  relative and `base` is null (an earlier `cd` hop was itself unresolvable,
 *  so the working directory is unknown; treating it as the project root was
 *  the 2026-07-24 FP). */
function resolveTargetForRootCheck(
	target: string,
	vars: ReadonlyMap<string, string>,
	base: string | null,
): string | null {
	const expanded = expandLeadingVariable(target, vars);
	if (expanded === null) return null;
	if (expanded === "~" || expanded.startsWith("~/")) {
		return resolve(homedir(), expanded.slice(2));
	}
	if (isAbsolute(expanded)) return resolve(expanded);
	return base === null ? null : resolve(base, expanded);
}

/** Pick what a leading variable resolves to: a known non-empty assignment
 *  wins; else a static, non-empty colon-dash default (one containing `$`
 *  would need nested expansion — unmodeled); else null (unresolvable). */
function resolveVariableValue(
	value: string | undefined,
	fallback: string | undefined,
): string | null {
	if (value !== undefined && value !== "") return value;
	if (fallback === undefined || fallback === "" || fallback.includes("$")) return null;
	return fallback;
}

/** Expand a LEADING variable — bare `$VAR`, braced, or braced with a
 *  colon-dash default — in a target using same-command assignments (plus
 *  stable process-env prefixes seeded by {@link collectShellAssignments}).
 *  Returns the target unchanged when it doesn't start with a variable, and
 *  null when it starts with one we can't resolve: an unknown name with no
 *  usable default, or any other braced-operator form (command substitution,
 *  cross-call exports, and arithmetic stay unmodeled). A braced form we
 *  don't recognize is a VARIABLE we can't resolve, never a literal — the
 *  2026-07-24 dogfood FP was a `cd` into a TMPDIR-with-default path whose
 *  target fell through BOTH branches of the old regex, was treated as a
 *  literal, and resolved to a phantom path "inside" the repo root. */
function expandLeadingVariable(
	target: string,
	vars: ReadonlyMap<string, string>,
): string | null {
	const m = target.match(
		/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/,
	);
	if (!m) return /^\$\{/.test(target) ? null : target;
	const name = m[1] ?? m[3];
	const chosen = resolveVariableValue(name !== undefined ? vars.get(name) : undefined, m[2]);
	return chosen === null ? null : chosen + target.slice(m[0].length);
}

/** Simple same-command `VAR=value` assignments, seeded with the stable
 *  process-env prefixes (`$HOME`, `$TMPDIR`) a target may start with. Values
 *  keep quotes stripped; escaped quotes inside a value are not modeled (a
 *  mis-parse only fail-opens a quality gate). Later assignments win, matching
 *  shell evaluation order for the straight-line commands agents write. */
function collectShellAssignments(cmd: string): Map<string, string> {
	const vars = new Map<string, string>();
	for (const name of ["HOME", "TMPDIR"]) {
		const v = process.env[name];
		if (v) vars.set(name, v);
	}
	const re = /(?:^|[\s;&|({])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
	for (const m of cmd.matchAll(re)) {
		vars.set(nonNull(m[1]), stripOuterQuotes(nonNull(m[2])));
	}
	return vars;
}

/** The directory a RELATIVE target resolves against, following same-command
 *  `cd` hops (`cd /tmp/x && echo hi > probe.ts` writes /tmp/x/probe.ts, not
 *  <root>/probe.ts — the cd-into-scratchpad pattern). Position-insensitive:
 *  the last `cd` wins for every target in the command. The prefix class
 *  admits a bare-space prefix (newlines are collapsed to spaces upstream,
 *  erasing the separator), so `echo cd /x` can false-match — the error
 *  direction is a missed block on a quality gate, accepted. */
function resolveCdBase(
	cmd: string,
	vars: ReadonlyMap<string, string>,
	projectRoot: string,
): string | null {
	let base: string | null = resolve(projectRoot);
	const re = /(?:^|[\s;&|])cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g;
	for (const m of cmd.matchAll(re)) {
		const rawTarget = m[1] ?? m[2] ?? m[3];
		if (rawTarget === undefined || rawTarget === "-") continue;
		// An unresolvable hop POISONS the base (null = unknown cwd) instead of
		// silently keeping the previous one — a later absolute or resolvable
		// `cd` re-establishes it. Pre-fix, `cd <unresolvable> && echo > p.ts`
		// kept base = project root and flagged p.ts as in-repo (2026-07-24 FP).
		base = resolveTargetForRootCheck(rawTarget, vars, base);
	}
	return base;
}

/** Public resolver for a detected bash write target: same-command `VAR=`
 *  expansion + `cd`-hop base + absolutization, exactly as the in-root
 *  containment check sees it. Consumers (the scratchpad placement steer in
 *  pre-tool-rules.ts) get the canonical absolute path, or null when the
 *  target is unresolvable (unknown leading variable). */
export function resolveBashWriteTarget(
	cmd: string,
	target: string,
	projectRoot: string,
): string | null {
	const normalized = cmd.replace(/[\r\n]+/g, " ");
	const vars = collectShellAssignments(normalized);
	const base = resolveCdBase(normalized, vars, projectRoot);
	return resolveTargetForRootCheck(target, vars, base);
}

/** Supermodel `.graph.*` shards are owned by Supermodel's daemon —
 *  always treat them as protected regardless of the inner extension. */
const SHARD_FILE_RE = /\.graph(\.[a-zA-Z0-9]+)?$/i;

/** Returns true when the path is something the content-gates protect:
 *  either a tracked-source extension OR a Supermodel shard. */
function isProtectedTarget(target: string): boolean {
	return SHARD_FILE_RE.test(target) || CODE_FILE_EXT_RE.test(target);
}

/**
 * Offset-preserving blank of quoted string contents so we don't match redirect
 * operators INSIDE argument strings (`echo "x > y"` is not a redirect). Pads
 * interiors with spaces of the same length so downstream match indices remain
 * valid on the original `cmd`.
 */
function stripQuotedStrings(cmd: string): string {
	return cmd
		.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => `"${" ".repeat(inner.length)}"`)
		.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => `'${" ".repeat(inner.length)}'`);
}

/**
 * Parse a redirect target from a command fragment starting at the `>` or
 * `>>` operator. Returns the target path and the operator mechanism name,
 * or null if it can't be resolved. Handles single-quoted, double-quoted,
 * and unquoted filenames.
 */
function parseRedirectTarget(
	cmd: string,
	operatorIdx: number,
	operator: string,
): { target: string; mechanism: string } | null {
	const afterOp = cmd.slice(operatorIdx + operator.length).trim();
	// Match: "path", 'path', or bare path until whitespace/operator
	const quoted = afterOp.match(/^(["'])([^"']+)\1/);
	if (quoted) return { target: nonNull(quoted[2]), mechanism: `shell redirect (${operator})` };
	const bare = afterOp.match(/^(\S+)/);
	if (bare) return { target: nonNull(bare[1]), mechanism: `shell redirect (${operator})` };
	return null;
}

/**
 * Commands that route THROUGH the content gate (rather than around it).
 * `interlinked write` runs the same `gateProposedContent` pipeline used by
 * the Edit/Write hooks, so we allow it unconditionally here — the command
 * does its own gating and blocking it would double-gate (and prevent the
 * legitimate multi-site-atomic use case described in the design doc).
 */
const CONTENT_GATE_ROUTED_RE = /\binterlinked\s+write\b/;

type WriteHit = { target: string; mechanism: string };

/** Mechanism 1 — shell redirection operators: `> file` and `>> file`. Scans
 *  for `>` not inside a quoted string; ignores `2>`, `&>`, `>&` fd forms. */
function scanRedirects(normalized: string, inRoot: (t: string) => boolean): WriteHit | null {
	const redirRe = /(?<![0-9&])(>>?)(?![&])/g;
	const stripped = stripQuotedStrings(normalized);
	for (const m of stripped.matchAll(redirRe)) {
		const op = nonNull(m[1]);
		const idx = m.index ?? 0;
		const hit = parseRedirectTarget(normalized, idx, op);
		if (!hit) continue;
		if (!CODE_FILE_EXT_RE.test(hit.target)) continue;
		if (!inRoot(hit.target)) continue;
		return hit;
	}
	return null;
}

/** Mechanism 2 — tee: `... | tee <file>` (also `tee -a`, `tee --append`). */
function scanTee(normalized: string, inRoot: (t: string) => boolean): WriteHit | null {
	const teeMatch = normalized.match(
		/\btee\s+(?:-a\s+|--append\s+)?(?:--\s+)?(['"]?)([^\s'"|&]+)\1/,
	);
	if (!teeMatch) return null;
	const target = nonNull(teeMatch[2]);
	if (CODE_FILE_EXT_RE.test(target) && inRoot(target)) {
		return { target, mechanism: "tee" };
	}
	return null;
}

/** Mechanism 4 — inline interpreter scripts that call writeFileSync / open+write:
 *  node -e "..." / python -c "..." / ruby -e "..." etc. */
function scanInlineInterpreter(
	normalized: string,
	inRoot: (t: string) => boolean,
): WriteHit | null {
	const inlineInterp = normalized.match(
		/\b(node|python3?|ruby|perl|deno|bun)\s+(?:--[a-zA-Z0-9=_-]+\s+)*-[ec]\s+(["'])([\s\S]*?)\2/,
	);
	if (!inlineInterp) return null;
	const script = inlineInterp[3];
	// Look for `writeFileSync('foo.ts', ...)` / `open('foo.ts','w')`
	const writeArg =
		nonNull(script).match(/writeFile(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/) ??
		nonNull(script).match(/open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][aw]/) ??
		nonNull(script).match(/fs\.writeFile\s*\(\s*['"]([^'"]+)['"]/);
	if (writeArg && CODE_FILE_EXT_RE.test(nonNull(writeArg[1])) && inRoot(nonNull(writeArg[1]))) {
		return {
			target: nonNull(writeArg[1]),
			mechanism: `inline ${inlineInterp[1]} -${inlineInterp[0].includes("-c ") ? "c" : "e"} script`,
		};
	}
	return null;
}

export function detectBashCodeFileWrite(
	cmd: string,
	projectRoot?: string,
): WriteHit | null {
	if (!cmd) return null;
	// Normalize: strip CR/LF, collapse whitespace (but keep order)
	const normalized = cmd.replace(/[\r\n]+/g, " ");

	// Fast path: `interlinked write` self-gates. Let it through.
	if (CONTENT_GATE_ROUTED_RE.test(normalized)) return null;

	// Root confinement (2026-07-06): only targets landing INSIDE the guarded
	// project are the content gates' territory — a code-extension path in the
	// session scratchpad / /tmp / anywhere out-of-repo is not a tracked source
	// file (measured dogfood FP). Targets are resolved the way the shell
	// would — same-command `VAR=` assignments and `cd` hops (2026-07-09 FP:
	// `> $SCRATCH/x.ts`) — before containment. No root context ⇒ historical
	// behavior.
	const vars = collectShellAssignments(normalized);
	const cdBase = projectRoot ? resolveCdBase(normalized, vars, projectRoot) : undefined;
	const inRoot = (target: string): boolean =>
		withinGuardedRoot(target, projectRoot, vars, cdBase);

	const redirect = scanRedirects(normalized, inRoot);
	if (redirect) return redirect;

	const tee = scanTee(normalized, inRoot);
	if (tee) return tee;

	// sed -i (in-place edit).
	const sedInPlace = detectSedInPlaceEdit(normalized);
	if (sedInPlace && inRoot(sedInPlace.target)) return sedInPlace;

	const inline = scanInlineInterpreter(normalized, inRoot);
	if (inline) return inline;

	// File-moving verbs (cp/mv/ln/install/rsync/scp): destination is the LAST
	// positional argument; segment-walk so flag count doesn't tilt the regex.
	const fileMoveHit = detectFileMoveToProtected(normalized);
	if (fileMoveHit && inRoot(fileMoveHit.target)) return fileMoveHit;

	// dd if=<src> of=<dst> — destination is in the `of=` arg.
	const ddHit = detectDdWriteToProtected(normalized);
	if (ddHit && inRoot(ddHit.target)) return ddHit;

	return null;
}

/** Verbs whose effect is "place bytes at <last positional arg>". Every
 *  one of these bypasses Write/Edit if the destination is a code file or
 *  a Supermodel shard. */
const FILE_MOVE_VERBS = new Set(["cp", "mv", "ln", "install", "rsync", "scp"]);

function detectFileMoveToProtected(
	cmd: string,
): { target: string; mechanism: string } | null {
	for (const segment of splitCommandSegments(cmd)) {
		const args = splitShellWordsLoose(segment).map(stripOuterQuotes);
		if (args.length < 2) continue;
		const verb = nonNull(args[0]).split("/").pop() ?? nonNull(args[0]);
		if (!FILE_MOVE_VERBS.has(verb)) continue;
		// Skip any subsequent flag-token (starts with `-`), find the last
		// positional argument. `cp` and friends always put the destination
		// last when called with N positionals.
		const positionals: string[] = [];
		for (let i = 1; i < args.length; i++) {
			const arg = args[i];
			if (nonNull(arg).startsWith("-")) {
				// Some flags take a value in two-token form (`-m 644`,
				// `--mode 644`, `-t DIR`). Skip the next token only for those.
				// `-T` is `--no-target-directory` — a boolean; do NOT skip,
				// or the destination gets parsed away and `cp -T /tmp/x src/foo.ts`
				// slips past the guard. Long forms with `=` (e.g. `--mode=644`)
				// are one token and handled by the no-skip path.
				const flagTakesArg =
					arg === "-m" ||
					arg === "--mode" ||
					arg === "-t" ||
					arg === "--target-directory" ||
					arg === "-S" ||
					arg === "--suffix";
				if (flagTakesArg && i + 1 < args.length && !nonNull(args[i + 1]).startsWith("-")) {
					i++;
				}
				continue;
			}
			positionals.push(nonNull(arg));
		}
		if (positionals.length < 2) continue;
		const target = nonNull(positionals[positionals.length - 1]);
		if (isProtectedTarget(target)) {
			return { target, mechanism: `${verb} (write to tracked file)` };
		}
	}
	return null;
}

function detectDdWriteToProtected(
	cmd: string,
): { target: string; mechanism: string } | null {
	for (const segment of splitCommandSegments(cmd)) {
		if (!/\bdd\b/.test(segment)) continue;
		const ofMatch = segment.match(/\bof=(\S+)/);
		if (!ofMatch) continue;
		const target = stripOuterQuotes(nonNull(ofMatch[1]));
		if (isProtectedTarget(target)) {
			return { target, mechanism: "dd (block-level write)" };
		}
	}
	return null;
}

function detectSedInPlaceEdit(cmd: string): { target: string; mechanism: string } | null {
	for (const segment of splitCommandSegments(cmd)) {
		const args = splitShellWordsLoose(segment);
		const sedIdx = args.findIndex((arg) => /(?:^|\/)sed$/.test(stripOuterQuotes(arg)));
		if (sedIdx < 0) continue;

		const sedArgs = args.slice(sedIdx + 1).map(stripOuterQuotes);
		if (!sedArgs.some(isSedInPlaceOption)) continue;

		for (let i = sedArgs.length - 1; i >= 0; i--) {
			const arg = nonNull(sedArgs[i]);
			if (arg.startsWith("-")) continue;
			if (CODE_FILE_EXT_RE.test(arg)) {
				return { target: arg, mechanism: "sed -i (in-place)" };
			}
		}
	}
	return null;
}

function isSedInPlaceOption(arg: string): boolean {
	return arg === "-i" || /^-[A-Za-z]*i(?:$|[^A-Za-z].*)/.test(arg);
}

function splitCommandSegments(cmd: string): string[] {
	return cmd.split(/\s+(?:&&|\|\||;|\|)\s+/).filter(Boolean);
}

function splitShellWordsLoose(segment: string): string[] {
	// Flatten nested-quantifier alternation: `(?:[^"\\]|\\[\s\S])*` advances
	// one character per iteration with no backtracking, avoiding the
	// catastrophic-backtracking shape of `[^"\\]*(?:\\.[^"\\]*)*`.
	const words: string[] = [];
	const re = /"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|(\S+)/g;
	for (const match of segment.matchAll(re)) {
		words.push(match[0]);
	}
	return words;
}

function stripOuterQuotes(value: string): string {
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith("\"") && value.endsWith("\""))
	) {
		return value.slice(1, -1);
	}
	return value;
}
