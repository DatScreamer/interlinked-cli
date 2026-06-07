// Diff-aware behavioral checks (Batch 3).
//
// Each check reads `git diff --cached HEAD` for files in
// `session.files_written` and surfaces a CheckResultEntry when the staged
// diff exhibits a known test-suite-gaming or claim-vs-reality drift
// pattern. All run at PreToolUse time on `git commit` invocations
// alongside the existing commit gates in `server.ts`.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, basename as pathBasename, resolve } from "node:path";
import { extractAddedLines, getStagedDiff } from "./behavioral-checks.js";
import type { CheckResultEntry, SessionTrajectory } from "./types.js";

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

function basename(p: string): string {
	return p.split("/").pop() || p;
}

// ==========================================================================
// 1. Disabled-test delta
// ==========================================================================
// Staged diff added `.skip`, `xit`, `xdescribe`, `it.skip(`, etc. to a test
// file. The transition is the tell — pre-existing skips don't fire.

const DISABLE_DIRECTIVES_RE =
	/(?:^|\b)(?:it|test|describe|context)\s*\.\s*(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest|xcontext)\s*\(/;

function countDisabledIntros(text: string): number {
	const matches = text.match(new RegExp(DISABLE_DIRECTIVES_RE.source, "g"));
	return matches ? matches.length : 0;
}

/** Public API — flags newly-added `.skip` / `xit` directives in test files. */
export function checkDisabledTestDelta(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		let added = 0;
		let removed = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+") && DISABLE_DIRECTIVES_RE.test(line)) added++;
			else if (line.startsWith("-") && DISABLE_DIRECTIVES_RE.test(line)) removed++;
		}
		const delta = added - removed;
		if (delta <= 0) continue;
		results.push({
			source: "structural",
			name: "disabled_test_delta",
			severity: "error",
			message: `${basename(file)} adds ${delta} new disabled-test directive(s) (.skip / xit / .todo). Fix the failing test instead of skipping it. If skipping is genuinely necessary, document why with a TICKET-XXX reference.`,
			file,
			determinism: "fully_deterministic",
		});
	}
	return results;
}

// ==========================================================================
// 2. Test-block count regression
// ==========================================================================
// File's `it()` / `test()` / `specify()` count is lower than HEAD. The
// agent deleted tests instead of fixing them.

const TEST_BLOCK_INTRO_RE =
	/\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(\s*['"`]/;

function countTestBlocks(text: string): number {
	const re = new RegExp(TEST_BLOCK_INTRO_RE.source, "g");
	const matches = text.match(re);
	return matches ? matches.length : 0;
}

/** Public API — flags test files whose `it()` / `test()` count dropped. */
export function checkTestBlockCountRegression(
	session: SessionTrajectory,
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		// Count test-intro lines on `+` vs `-` halves. A net-negative count
		// means tests were removed rather than added.
		let plus = 0;
		let minus = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+") && TEST_BLOCK_INTRO_RE.test(line)) plus++;
			else if (line.startsWith("-") && TEST_BLOCK_INTRO_RE.test(line)) minus++;
		}
		const net = plus - minus;
		if (net >= 0) continue;
		results.push({
			source: "structural",
			name: "test_block_count_regression",
			severity: "warning",
			message: `${basename(file)} removed ${-net} more test block(s) than it added (-${minus}, +${plus}). If a test is wrong, fix it; if the SUT moved, move the test. Don't drop coverage to make the suite pass.`,
			file,
			determinism: "fully_deterministic",
		});
	}
	return results;
}

// ==========================================================================
// 3. Assertion-strength weakening
// ==========================================================================
// Diff replaces a strong matcher (`toBe(<literal>)`, `toEqual(<literal>)`,
// `toMatch(/.../)`) with a weaker one (`toBeTruthy()`, `toBeDefined()`,
// `not.toThrow()`). Strong agent tell.

const STRONG_MATCHER_RE = /\.\s*(?:toBe|toEqual|toStrictEqual|toMatch)\s*\(/;
const WEAK_MATCHER_RE =
	/\.\s*(?:toBeTruthy|toBeDefined|toBeFalsy|toBeUndefined|not\s*\.\s*toThrow)\s*\(/;

/** Public API — flags assertion weakening in staged diffs. */
export function checkAssertionStrengthWeakening(
	session: SessionTrajectory,
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		let strongRemoved = 0;
		let weakAdded = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("-") && STRONG_MATCHER_RE.test(line)) strongRemoved++;
			else if (line.startsWith("+") && WEAK_MATCHER_RE.test(line)) weakAdded++;
		}
		// Heuristic: a strong matcher removed AND a weak matcher added in
		// the same diff is an assertion-weakening tell. Don't fire on
		// pure additions or pure deletions.
		if (strongRemoved === 0 || weakAdded === 0) continue;
		results.push({
			source: "structural",
			name: "assertion_strength_weakening",
			severity: "warning",
			message: `${basename(file)} replaces strong assertions (toBe/toEqual/toMatch x${strongRemoved}) with weak ones (toBeTruthy/toBeDefined/not.toThrow x${weakAdded}). Either restore the strong assertion (and fix what made it fail), or document why the looser matcher is correct.`,
			file,
			determinism: "heuristic",
		});
	}
	return results;
}

// ==========================================================================
// 4. Conventional-commit ↔ diff coherence
// ==========================================================================
// Parse the `-m "msg"` argument from the `git commit` invocation, classify
// its conventional-commit prefix, and surface a finding when the diff
// contradicts the claim:
//   - `fix:` claim, diff is comment-only / whitespace / import-only / test-only
//   - `feat:` claim, no new exports introduced
//   - `refactor:` claim, but assertion arguments / business logic mutated
//   - `test:` claim, but production source touched
//   - `docs:` claim, but `.ts` / `.tsx` files outside docs touched

interface ParsedCommitMessage {
	type: string;
	subject: string;
}

const COMMIT_TYPE_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.+)$/;
const COMMIT_M_FLAG_RE = /-m\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/;

export function parseCommitMessageFromBash(command: string): ParsedCommitMessage | null {
	const match = COMMIT_M_FLAG_RE.exec(command);
	if (!match) return null;
	const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
	if (!raw) return null;
	const typeMatch = COMMIT_TYPE_RE.exec(raw);
	if (!typeMatch) return null;
	return { type: typeMatch[1].toLowerCase(), subject: typeMatch[2] };
}

const PROD_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function isDocsPath(file: string): boolean {
	return /(?:^|\/)(?:docs|documentation|website|site)\//.test(file) ||
		extname(file) === ".md" ||
		extname(file) === ".mdx";
}

function isTestPath(file: string): boolean {
	return TEST_FILE_RE.test(file);
}

function isProdSource(file: string): boolean {
	return PROD_EXTS.has(extname(file)) && !isTestPath(file);
}

function extractRemovedLines(diff: string): string {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("-") || line.startsWith("---")) continue;
		out.push(line.slice(1));
	}
	return out.join("\n");
}

function isCommentOrWhitespaceOnly(text: string): boolean {
	if (!text.trim()) return true;
	const substantive = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.filter((l) => !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
	return substantive.length === 0;
}

/**
 * A diff is a true no-op (worth flagging on a `fix:` claim) only when BOTH
 * added and removed sides are comment/whitespace-only. A deletion-only
 * change that removes substantive code IS a real fix even though the
 * added side is empty — return false so the gate doesn't false-positive
 * on legitimate cleanup commits.
 */
function diffIsCommentOrWhitespaceOnly(diff: string): boolean {
	const addedNoOp = isCommentOrWhitespaceOnly(extractAddedLines(diff));
	const removedNoOp = isCommentOrWhitespaceOnly(extractRemovedLines(diff));
	return addedNoOp && removedNoOp;
}

const EXPORT_NAME_RE =
	/^\s*export\s+(?:async\s+)?(?:default\s+)?(?:function\s+\*?|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][\w$]*)/gm;
// Barrel-style named re-exports: `export { Foo, Bar } from "./mod"` and
// (rarer) plain `export { Foo, Bar }` for surface-redeclarations.
const EXPORT_NAMED_LIST_RE = /^\s*export\s*\{\s*([^}]+)\s*\}/gm;
// Catch-all re-export: `export * from "./mod"` and `export * as ns from "./mod"`.
const EXPORT_STAR_RE = /^\s*export\s+\*(?:\s+as\s+\w+)?\s+from\s+["']/m;
// Anonymous default export: `export default function () { … }`,
// `export default () => …`, `export default {`, `export default 1`.
// Distinct from the named-default form which the main regex already covers.
const EXPORT_DEFAULT_ANY_RE =
	/^\s*export\s+default\s+(?:async\s+)?(?:function\s*\*?\s*\(|class\s*(?:\{|extends)|\(|\{|\[|[A-Za-z_$])/m;

function exportedNamesIn(text: string): Set<string> {
	const names = new Set<string>();
	EXPORT_NAME_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPORT_NAME_RE.exec(text);
	while (m !== null) {
		names.add(m[1]);
		m = EXPORT_NAME_RE.exec(text);
	}
	EXPORT_NAMED_LIST_RE.lastIndex = 0;
	let n: RegExpExecArray | null = EXPORT_NAMED_LIST_RE.exec(text);
	while (n !== null) {
		// Each entry is `Foo` or `Foo as Bar` — credit the public-facing
		// alias (the right side of `as`) since that's the surface name.
		for (const raw of n[1].split(",")) {
			const local = (raw.split(/\s+as\s+/i)[1] ?? raw).trim().replace(/^type\s+/, "");
			if (local) names.add(local);
		}
		n = EXPORT_NAMED_LIST_RE.exec(text);
	}
	return names;
}

function diffIntroducesNewExport(diff: string): boolean {
	const added = extractAddedLines(diff);
	// Star re-exports propagate an unknown surface; treat their *addition*
	// as a new export so feat: claims about them don't false-positive.
	if (EXPORT_STAR_RE.test(added)) return true;
	// Anonymous-default export added — counts as new public surface.
	if (EXPORT_DEFAULT_ANY_RE.test(added)) return true;
	const addedNames = exportedNamesIn(added);
	if (addedNames.size === 0) return false;
	// Subtract names that also appear on `-` lines — those are edits to
	// pre-existing exports, not new public surface.
	const removedLines: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("-") && !line.startsWith("---")) removedLines.push(line.slice(1));
	}
	const removedNames = exportedNamesIn(removedLines.join("\n"));
	for (const name of addedNames) {
		if (!removedNames.has(name)) return true;
	}
	return false;
}

/** Public API — flags conventional-commit prefix vs staged-diff mismatches. */
export function checkConventionalCommitCoherence(
	session: SessionTrajectory,
	message: ParsedCommitMessage | null,
): CheckResultEntry[] {
	if (!message) return [];
	const results: CheckResultEntry[] = [];
	const files = [...session.files_written];
	if (files.length === 0) return [];

	const allDiffs = files.map((f) => ({ file: f, diff: getStagedDiff(f) }));
	// Only files with a non-empty staged diff belong to THIS commit. session
	// .files_written also includes files written earlier in the session and
	// committed separately; using it directly false-fires (e.g. test:/docs: on
	// prod files that are not part of this commit).
	const stagedFiles = allDiffs.filter((d) => d.diff).map((d) => d.file);
	if (stagedFiles.length === 0) return [];

	switch (message.type) {
		case "fix": {
			// Every touched file's added lines should be more than just
			// comments / imports / test-only.
			const allCommentOrWs = allDiffs.every((d) => !d.diff || diffIsCommentOrWhitespaceOnly(d.diff));
			const onlyTests = stagedFiles.every((f) => !isProdSource(f) || isTestPath(f));
			if (allCommentOrWs) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "fix:" but every staged change is comment-only / whitespace-only. Either rewrite the message (e.g. \`docs:\`, \`chore:\`) or include the actual fix.`,
					file: "<session>",
					determinism: "heuristic",
				});
			} else if (onlyTests) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "fix:" but no production source was modified — only tests. If the bug was in a test, use \`test:\`. If the production fix is missing, add it before committing.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "feat": {
			const introducesExport = allDiffs.some(
				(d) => isProdSource(d.file) && d.diff && diffIntroducesNewExport(d.diff),
			);
			if (!introducesExport) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "feat:" but the staged diff introduces no new exported symbol. New features typically expose a callable surface — verify the message matches the change (try \`fix:\` or \`refactor:\` if you didn't add a public API).`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "test": {
			const touchesProd = stagedFiles.some((f) => isProdSource(f));
			if (touchesProd) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "test:" but production source files are also modified. Split the production change into its own commit (with \`fix:\` / \`feat:\` / \`refactor:\`) so the history accurately reflects what changed.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "docs": {
			const touchesNonDocs = stagedFiles.some((f) => !isDocsPath(f) && PROD_EXTS.has(extname(f)));
			if (touchesNonDocs) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "warning",
					message: `Commit message says "docs:" but non-docs files (.ts / .tsx outside docs paths) are modified. Either narrow the diff to docs only or re-classify the commit type.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		case "refactor": {
			// `refactor:` means "behavior preserved." Heuristic for behavior
			// change: assertion-argument mutations OR new-test additions
			// (suggests behavior was different than the prior tests captured).
			const testsWithMutation = allDiffs.filter((d) => isTestPath(d.file) && d.diff)
				.filter((d) => /\b(?:expect|assert)\s*\([^)]*\)\s*\.\s*to[A-Z]/.test(extractAddedLines(d.diff)));
			if (testsWithMutation.length > 0) {
				results.push({
					source: "structural",
					name: "commit_message_diff_mismatch",
					severity: "info",
					message: `Commit message says "refactor:" but test assertions changed in ${testsWithMutation.length} file(s). Refactors preserve behavior — assertion changes suggest a behavior delta. Consider \`fix:\` or \`feat:\` if the SUT contract moved.`,
					file: "<session>",
					determinism: "heuristic",
				});
			}
			break;
		}
		default:
			break;
	}

	return results;
}

// ==========================================================================
// 5. vi.setSystemTime added to a test that didn't have it before
// ==========================================================================
// Diff signal that the agent silenced a time-sensitive test failure by
// reaching for the clock mock instead of fixing the underlying issue.
// Sometimes legitimate (test newly tests time-dependent behavior); always
// worth surfacing.

const VI_SET_SYSTEM_TIME_RE = /\b(?:vi|jest)\s*\.\s*(?:setSystemTime|useFakeTimers)\s*\(/;

/** Public API — flags newly-added vi.setSystemTime / vi.useFakeTimers in tests. */
export function checkClockMockAdded(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (!TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		let added = 0;
		let removed = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+") && VI_SET_SYSTEM_TIME_RE.test(line)) added++;
			else if (line.startsWith("-") && VI_SET_SYSTEM_TIME_RE.test(line)) removed++;
		}
		const net = added - removed;
		if (net <= 0) continue;
		results.push({
			source: "structural",
			name: "clock_mock_added",
			severity: "info",
			message: `${basename(file)} adds ${net} clock-mock call(s) (vi.setSystemTime / vi.useFakeTimers). If this is to silence a real timing bug, fix the SUT instead. If the test genuinely depends on time, consider injecting a Clock interface so production code is the same shape.`,
			file,
			determinism: "fully_deterministic",
		});
	}
	return results;
}

void pathBasename; // suppress unused-import after refactor — keep available for future expansion

// ==========================================================================
// 6. Re-introduces removed code
// ==========================================================================
// For added lines matching loud-pattern markers (`console.log`, `// TODO`,
// `as any`, `// FIXME`, `debugger`, `xit`, `.skip`, `@ts-ignore`), run a
// targeted `git log -S<phrase>` to detect whether a recent commit removed
// the same line. A hit means the agent re-introduced something a prior
// commit deliberately deleted.
//
// Scoped narrowly because `git log -S` is O(history-size). Only fires on
// known-loud markers — full re-introduction detection at scale would need
// the trigram index, deferred to a later batch.

const LOUD_REINTRO_RE =
	/(?:console\s*\.\s*(?:log|info|debug|warn)\s*\(|\/\/\s*(?:TODO|FIXME|XXX|HACK)\b|\bas\s+any\b|\bdebugger\b|\bxit\s*\(|\bxdescribe\s*\(|\.\s*skip\s*\(|\/\/\s*@ts-(?:ignore|expect-error)\b)/;

const REINTRO_LOG_TIMEOUT_MS = 3000;
const REINTRO_LOOKBACK_COMMITS = 50;

function gitLogContainsRemoval(repoCwd: string, phrase: string): string | null {
	if (phrase.length < 8) return null;
	try {
		// `git log -S<phrase>` (the "pickaxe" search) returns commits whose
		// diff changes the count of <phrase>. We want commits that
		// REDUCED the count (removed the line), so iterate the matches and
		// keep the first whose diff contains a `-` line matching the phrase.
		const r = spawnSync(
			"git",
			[
				"-C",
				repoCwd,
				"log",
				`-${REINTRO_LOOKBACK_COMMITS}`,
				`-S${phrase}`,
				"--pretty=format:%H %s",
				"--no-color",
			],
			{ encoding: "utf-8", timeout: REINTRO_LOG_TIMEOUT_MS },
		);
		if (r.status !== 0 || !r.stdout) return null;
		const candidateCommits = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
		for (const commitLine of candidateCommits) {
			const sha = commitLine.split(" ", 1)[0];
			if (!sha) continue;
			// Confirm THIS commit's diff actually removed the phrase (rather
			// than added it). Without this filter, the original-introduction
			// commit also matches `-S` and we'd false-positive.
			const show = spawnSync(
				"git",
				["-C", repoCwd, "show", "--no-color", "--unified=0", sha],
				{ encoding: "utf-8", timeout: REINTRO_LOG_TIMEOUT_MS },
			);
			if (show.status !== 0 || !show.stdout) continue;
			for (const line of show.stdout.split("\n")) {
				if (line.startsWith("-") && !line.startsWith("---") && line.includes(phrase)) {
					return commitLine;
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

function findRepoCwd(file: string): string | null {
	let dir = existsSync(file) && statSync(file).isFile() ? dirname(file) : file;
	dir = resolve(dir);
	for (let i = 0; i < 10; i++) {
		if (existsSync(resolve(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Public API — flags lines re-introduced after a prior commit removed them. */
export function checkReintroducesRemovedCode(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	const MAX_PER_FILE = 2;
	const MAX_TOTAL = 5;

	for (const file of session.files_written) {
		if (results.length >= MAX_TOTAL) break;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		const repoCwd = findRepoCwd(file);
		if (!repoCwd) continue;
		const seenPhrases = new Set<string>();
		let perFile = 0;
		for (const rawLine of extractAddedLines(diff).split("\n")) {
			if (perFile >= MAX_PER_FILE) break;
			if (results.length >= MAX_TOTAL) break;
			const line = rawLine.trim();
			if (line.length < 8) continue;
			// Search by the loud-marker substring, not the full line — agents
			// often re-introduce a `console.log("X")` inside a different
			// surrounding statement, and pickaxe needs an exact substring match.
			const loud = LOUD_REINTRO_RE.exec(line);
			if (!loud) continue;
			const phrase = extractDistinctivePhrase(line, loud[0]);
			if (!phrase || seenPhrases.has(phrase)) continue;
			seenPhrases.add(phrase);
			const removalCommit = gitLogContainsRemoval(repoCwd, phrase);
			if (!removalCommit) continue;
			perFile++;
			results.push({
				source: "structural",
				name: "reintroduces_removed_code",
				severity: "warning",
				message: `Re-introduces \`${phrase.slice(0, 80)}\` — a prior commit removed this (last removal: ${removalCommit.slice(0, 70)}). Verify the cleanup wasn't intentional before re-adding.`,
				file,
				determinism: "fully_deterministic",
			});
		}
	}
	return results;
}

/**
 * Pickaxe (`git log -S`) needs an exact substring. We start from the
 * regex-matched marker (e.g. `console.log(`) and grow forward through the
 * line until we capture a balanced closing paren or a meaningful token —
 * giving pickaxe enough context to avoid noise on every occurrence of the
 * bare marker, while still being a real substring of any prior commit
 * that contained the same call.
 */
function extractDistinctivePhrase(line: string, marker: string): string | null {
	const idx = line.indexOf(marker);
	if (idx < 0) return null;
	// Walk forward, tracking paren depth, until depth hits 0 after opening.
	let depth = 0;
	let opened = false;
	for (let i = idx; i < line.length; i++) {
		const ch = line[i];
		if (ch === "(") {
			depth++;
			opened = true;
		} else if (ch === ")") {
			depth--;
			if (opened && depth === 0) {
				return line.slice(idx, i + 1);
			}
		}
	}
	// Marker has no balanced parens — fall back to the marker plus 30 chars.
	return line.slice(idx, Math.min(line.length, idx + 30));
}

// ==========================================================================
// 7. "Done" without verify
// ==========================================================================
// Commit-gate signal: agent is committing source-file changes without ever
// running a test in the session. Distinct from the existing
// checkProdTestLocRatio (which compares LOC) — this fires when test_runs
// is empty entirely.

const TEST_FILE_RE_LOCAL = /\.(test|spec)\.|__tests__\/|\/tests\//;

/** Public API — flags committing without running tests in the session.
 *  Scoped to actual source files (`isProdSource` extension + non-test
 *  filter) so docs-only / config-only / lockfile-only commits don't get
 *  warned to "run the test suite" — those paths have no tests to run. */
export function checkDoneWithoutVerify(session: SessionTrajectory): CheckResultEntry[] {
	if (session.test_runs.size > 0) return [];
	const sourceEdits = [...session.files_written].filter(isProdSource);
	if (sourceEdits.length === 0) return [];
	void TEST_FILE_RE_LOCAL; // legacy ref: superseded by isProdSource — keep import alive in case future logic re-uses it.

	return [
		{
			source: "structural",
			name: "done_without_verify",
			severity: "warning",
			message: `Committing ${sourceEdits.length} source file edit(s) without running any tests in this session. Run the test suite (or the relevant subset) before committing — typecheck and lint don't substitute for running the code.`,
			file: "<session>",
			determinism: "fully_deterministic",
		},
	];
}
