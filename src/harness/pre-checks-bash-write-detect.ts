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
import { nonNull } from "../lib/non-null.js";

const CODE_FILE_EXT_RE =
	/\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|swift|c|cc|cpp|cxx|h|hpp|hxx|rb|php|cs|scala|clj|sh|bash|zsh)$/i;

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

export function detectBashCodeFileWrite(cmd: string): { target: string; mechanism: string } | null {
	if (!cmd) return null;

	// Normalize: strip CR/LF, collapse whitespace (but keep order)
	const normalized = cmd.replace(/[\r\n]+/g, " ");

	// Fast path: `interlinked write` self-gates. Let it through.
	if (CONTENT_GATE_ROUTED_RE.test(normalized)) return null;

	// 1. Shell redirection operators: `> file` and `>> file`.
	//    Scan for `>` not inside a quoted string. Ignore `2>`, `&>`, `>&` forms
	//    (those are fd redirection, not file writes).
	const redirRe = /(?<![0-9&])(>>?)(?![&])/g;
	const stripped = stripQuotedStrings(normalized);
	for (const m of stripped.matchAll(redirRe)) {
		const op = nonNull(m[1]);
		const idx = m.index ?? 0;
		const hit = parseRedirectTarget(normalized, idx, op);
		if (!hit) continue;
		if (!CODE_FILE_EXT_RE.test(hit.target)) continue;
		return hit;
	}

	// 2. tee: `... | tee <file>` (also `tee -a`, `tee --append`).
	const teeMatch = normalized.match(
		/\btee\s+(?:-a\s+|--append\s+)?(?:--\s+)?(['"]?)([^\s'"|&]+)\1/,
	);
	if (teeMatch) {
		const target = nonNull(teeMatch[2]);
		if (CODE_FILE_EXT_RE.test(target)) {
			return { target, mechanism: "tee" };
		}
	}

	// 3. sed -i (in-place edit).
	const sedInPlace = detectSedInPlaceEdit(normalized);
	if (sedInPlace) {
		return sedInPlace;
	}

	// 4. Inline interpreter calls that call writeFileSync / open+write.
	//    node -e "..." / python -c "..." / python3 -c "..." / ruby -e "..."
	const inlineInterp = normalized.match(
		/\b(node|python3?|ruby|perl|deno|bun)\s+(?:--[a-zA-Z0-9=_-]+\s+)*-[ec]\s+(["'])([\s\S]*?)\2/,
	);
	if (inlineInterp) {
		const script = inlineInterp[3];
		// Look for `writeFileSync('foo.ts', ...)` / `open('foo.ts','w')`
		const writeArg =
			nonNull(script).match(/writeFile(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/) ??
			nonNull(script).match(/open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][aw]/) ??
			nonNull(script).match(/fs\.writeFile\s*\(\s*['"]([^'"]+)['"]/);
		if (writeArg && CODE_FILE_EXT_RE.test(nonNull(writeArg[1]))) {
			return {
				target: nonNull(writeArg[1]),
				mechanism: `inline ${inlineInterp[1]} -${inlineInterp[0].includes("-c ") ? "c" : "e"} script`,
			};
		}
	}

	// 5. File-moving verbs that land bytes in a target path:
	//    cp / mv / ln (hard or symlink) / install / rsync / scp.
	//    All follow the shape `<verb> [flags...] <src> <dst>` — destination
	//    is the LAST positional argument. Detect via segment-walk so the
	//    flag count doesn't tilt the regex.
	const fileMoveHit = detectFileMoveToProtected(normalized);
	if (fileMoveHit) return fileMoveHit;

	// 6. dd if=<src> of=<dst> — block-level copy. Destination is in the
	//    `of=` arg, not the last positional.
	const ddHit = detectDdWriteToProtected(normalized);
	if (ddHit) return ddHit;

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
