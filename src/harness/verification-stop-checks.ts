// ===========================================
// Verification-Before-Stop — Stop-time reflection nudges
// ===========================================
//
// Companion to commit-cadence.ts. Three reflection nudges that fire at
// Stop / SessionEnd when the agent claims done without having verified
// the work it did. All deterministic; all warnings (stderr), never blocks
// — same "lever held in reserve" stance as the commit-cadence nudge.
//
//   1. Unverified code:    code files edited, no tsc/test/lint/build
//   2. UI not interacted:  UI files edited, no dev-server / browser MCP
//   3. Stubs introduced:   TODO/FIXME/throw-not-implemented/.skip pushed
//                          into Write/Edit content during the session
//
// Signal capture happens at event time (session-state.ts records
// verification_observed; evaluator/post-tool.ts records stubs_introduced
// from tool_input). This file is purely the formatters + the
// classification predicates the recorders need.

import { basename } from "node:path";
import { isDocFile } from "./commit-cadence.js";

/** Verification signal kinds tracked across a session.
 *
 *  Correctness signals (typecheck, test, lint, build, verify-suite)
 *  satisfy the "unverified code" check. UI-interaction signals
 *  (browser, dev-server) satisfy the "UI not interacted" check. Each
 *  kind is treated as a separate axis — running `bun run dev` proves
 *  the UI was at least loadable but does NOT prove the code typechecks.
 *
 *  `verify-suite` covers `interlinked verify`, the canonical local gate
 *  that runs tsc + biome + lint + secrets + SAST + docs:check (and
 *  mirrors the CI pipeline). Observing it satisfies all four
 *  individual correctness axes at once. */
export type VerificationSignal =
	| "typecheck"
	| "test"
	| "lint"
	| "build"
	| "verify-suite"
	| "browser"
	| "dev-server";

/** Bash commands that indicate a typechecker ran (tsc, ttsc, tspc).
 *  Word-boundary anchored so `tsconfig` / `tsc-multi-watch` don't match. */
const TYPECHECK_RE = /(?:^|[\s;&|])(?:tsc|tspc|ttsc)(?:\s|$|--)/;

/** Test runners across JS/TS, Python, Rust, Go, Bun, Deno, plus the
 *  generic `npm/bun/pnpm/yarn run test` and `script test`. */
const TEST_RE =
	/\b(?:vitest|jest|mocha|tap|ava|pytest|nose2|tox|cargo\s+(?:test|nextest)|go\s+test|bun\s+test|deno\s+test|rspec|phpunit|gradle\s+test|mvn\s+test)\b|\b(?:npm|bun|pnpm|yarn)\s+(?:run\s+)?test\b/;

/** Linters / formatters that double as correctness signals.
 *  `cargo check` is treated as a typecheck above? Actually it's neither —
 *  but it IS a correctness gate. Treat as lint for simplicity. */
const LINT_RE =
	/\b(?:biome(?:\s+(?:check|lint|ci))?|eslint|oxlint|ruff|clippy|tslint|stylelint|cargo\s+check|cargo\s+clippy)\b/;

/** Project-wide build commands. Excludes `tsc --watch` (development) and
 *  `bun build <file>` (one-off compile) — those don't prove the full
 *  project compiles. */
const BUILD_RE =
	/\b(?:tsc\s+--build|cargo\s+build|go\s+build|mvn\s+(?:compile|package)|gradle\s+build)\b|\b(?:npm|bun|pnpm|yarn)\s+run\s+build\b/;

/** Dev-server starters across the common JS frameworks plus the Python
 *  dev servers (`python -m http.server`, `uvicorn`, `flask run`). Matches
 *  `wrangler dev`, `npm run dev` / `bun run dev`, and the Python shapes. */
const DEV_SERVER_RE =
	/\b(?:wrangler\s+dev|next\s+dev|vite(?:\s+dev|\s+preview|\s+--port)?|astro\s+dev|nuxt\s+dev|svelte-kit\s+dev|webpack\s+serve|remix\s+dev|gatsby\s+develop)\b|\b(?:npm|bun|pnpm|yarn)\s+run\s+dev\b|\bpython3?\s+-m\s+http\.server\b|\buvicorn\b|\bflask\s+run\b/;

/** Browser-automation CLIs that prove the agent drove a real page:
 *  Simon Willison's Rodney (`uvx rodney …`), Vercel's agent-browser, and
 *  the Playwright CLI. The command-line counterpart of the chrome-devtools
 *  and playwright MCP tools that `classifyBrowserToolName` already covers —
 *  added so an agent that manual-tests via a CLI tool (per the
 *  agentic-engineering-patterns "agentic manual testing" guide) still
 *  satisfies the UI-not-interacted check. */
const BROWSER_CLI_RE =
	/\b(?:rodney|agent-browser)\b|(?:^|[\s;&|])(?:npx\s+|uvx\s+|bunx\s+)?playwright\s+(?:test|codegen|show-report|install|open)\b/;

/** `interlinked verify` — the project's canonical local gate. Recognized
 *  in all the common invocation shapes (direct binary, npx, ts-node, the
 *  built dist entry). Observing this command in the session trajectory is
 *  stronger evidence of correctness than any single tool signal because
 *  verify runs tsc + biome + lint + secrets + SAST + docs:check together
 *  and aggregates results. */
const VERIFY_SUITE_RE =
	/\b(?:npx\s+)?interlinked\s+verify\b|\bnode\s+\S*(?:dist|src)\S*\s+verify\b|\b(?:npx\s+)?tsx\s+\S*index\.ts\s+verify\b/;

/**
 * Public predicate — classify a Bash command into a single verification
 * signal kind, or null. The first matching pattern wins; commands that
 * chain multiple kinds (`bun run test && bun run build`) return whichever
 * the regex order resolves first.
 *
 * Verify-suite is checked FIRST so an `interlinked verify` invocation
 * doesn't get misclassified as just `tsc` because verify spawns tsc
 * internally — the suite signal is strictly more informative.
 */
export function classifyVerificationCommand(cmd: string): VerificationSignal | null {
	if (VERIFY_SUITE_RE.test(cmd)) return "verify-suite";
	if (TYPECHECK_RE.test(cmd)) return "typecheck";
	if (TEST_RE.test(cmd)) return "test";
	if (LINT_RE.test(cmd)) return "lint";
	if (BUILD_RE.test(cmd)) return "build";
	if (BROWSER_CLI_RE.test(cmd)) return "browser";
	if (DEV_SERVER_RE.test(cmd)) return "dev-server";
	return null;
}

/**
 * Public predicate — classify a tool name (typically an MCP-prefixed
 * tool) into a browser-interaction signal. Treats both `chrome-devtools`
 * and `playwright` MCP tools as evidence the agent loaded a page.
 */
export function classifyBrowserToolName(toolName: string | undefined): VerificationSignal | null {
	if (!toolName) return null;
	if (toolName.startsWith("mcp__chrome-devtools__")) return "browser";
	if (toolName.startsWith("mcp__playwright__browser_")) return "browser";
	return null;
}

/** UI source-file extensions. Covers the major component frameworks
 *  (React .tsx/.jsx, Vue, Svelte, Astro) plus raw markup and styles. */
const UI_FILE_RE = /\.(?:tsx|jsx|html?|css|scss|sass|less|vue|svelte|astro)$/i;

/** Code-file extensions for the "unverified code" check. Intentionally
 *  broader than UI files but excludes data files and lockfiles. Doc
 *  files are filtered separately via `isDocFile`. */
const CODE_FILE_RE =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|kt|swift|php|scala|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro)$/i;

/** Public predicate. UI files are a strict subset of code files. */
export function isUiFile(filePath: string): boolean {
	return UI_FILE_RE.test(filePath);
}

/** Public predicate. Code files exclude markdown/docs/plan files (per
 *  the existing `isDocFile`) and include source code across the
 *  supported languages. */
export function isCodeFile(filePath: string): boolean {
	if (isDocFile(filePath)) return false;
	return CODE_FILE_RE.test(filePath);
}

// ---------------------------------------------------------------------------
// Stub-introduction detection (PostToolUse content scan)
// ---------------------------------------------------------------------------

/** Kind label for one of the patterns we surface in the Stop nudge.
 *  Kept distinct from `VerificationSignal` so the two axes don't tangle. */
export type StubKind = "TODO" | "FIXME" | "not-implemented-throw" | "disabled-test";

interface StubPattern {
	kind: StubKind;
	re: RegExp;
}

/** Patterns that indicate the agent is leaving work unfinished or
 *  silenced. Each pattern is anchored to avoid the obvious false
 *  positives (`TODO` inside the word `KOMODO` etc.). */
const STUB_PATTERNS: ReadonlyArray<StubPattern> = [
	// `TODO:` / `TODO(name):` / `// TODO ` — require a punctuation or
	// space delimiter after to avoid matching identifiers like `MyTODOList`.
	{ kind: "TODO", re: /(?:^|[^A-Za-z0-9_])TODO\b\s*[:(\-\s]/m },
	{ kind: "FIXME", re: /(?:^|[^A-Za-z0-9_])FIXME\b/m },
	// `throw new Error("not implemented")` / `throw new TypeError("TODO")` etc.
	// The message must contain one of {not implemented, unimplemented, TODO, stub}.
	{
		kind: "not-implemented-throw",
		re: /\bthrow\s+new\s+\w*Error\s*\(\s*["'`][^"'`]*\b(?:not\s+implemented|unimplemented|TODO|stub)\b/i,
	},
	// `it.skip(`, `test.skip(`, `describe.skip(`, `xit(`, `xdescribe(`.
	{ kind: "disabled-test", re: /\b(?:it|test|describe)\.skip\s*\(|\b(?:xit|xdescribe)\s*\(/m },
];

/** Maximum stubs we'll record per session. Past this, additional
 *  introductions are dropped silently — the nudge is informational, not
 *  audit-grade, and an unbounded array on a long session is wasteful. */
export const STUB_INTRODUCED_CAP = 50;

export interface StubMatch {
	kind: StubKind;
	/** Trimmed line surrounding the match, capped at 120 chars. */
	snippet: string;
}

/**
 * Public — scan new content (Write `content`, Edit `new_string`,
 * MultiEdit `edits[].new_string`) for stub patterns. Returns at most one
 * match per kind so a file with three TODOs only contributes one TODO
 * record. Pure: caller decides whether to record into session state.
 */
export function scanForStubs(content: string): StubMatch[] {
	if (typeof content !== "string" || content.length === 0) return [];
	const found: StubMatch[] = [];
	const seen = new Set<StubKind>();
	for (const { kind, re } of STUB_PATTERNS) {
		if (seen.has(kind)) continue;
		const m = content.match(re);
		if (!m) continue;
		seen.add(kind);
		const idx = m.index ?? 0;
		const lineStart = content.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
		let lineEnd = content.indexOf("\n", idx);
		if (lineEnd === -1) lineEnd = content.length;
		const line = content.slice(lineStart, lineEnd).trim();
		const snippet = line.length > 120 ? `${line.slice(0, 117)}...` : line;
		found.push({ kind, snippet });
	}
	return found;
}

// ---------------------------------------------------------------------------
// Stop-event formatter functions
// ---------------------------------------------------------------------------

export interface FormatUnverifiedCodeOpts {
	/** Distinct code files written this session. */
	codeFilesEdited: number;
	/** Verification signals observed this session. */
	verificationObserved: ReadonlySet<string>;
}

/** The verify-suite signal — extracted as a named constant so the
 *  filter expression below reads as intent rather than a literal lookup. */
const VERIFY_SUITE_SIGNAL: VerificationSignal = "verify-suite";

/** Individual-tool correctness signals — the per-tool axes that
 *  collectively form the suite. Used as the "did the agent run anything
 *  at all" predicate for the partial-verification nudge below. */
const INDIVIDUAL_CORRECTNESS_SIGNALS: readonly VerificationSignal[] = [
	"typecheck",
	"test",
	"lint",
	"build",
];

/** Correctness-grade signals — any one satisfies the unverified-code check.
 *  `verify-suite` is the strongest signal (covers tsc + biome + lint +
 *  secrets + SAST + docs:check at once), but a standalone tsc/test/lint/
 *  build still satisfies the check on its own — the nudge fires only
 *  when none of these were observed. */
const CORRECTNESS_SIGNALS: readonly string[] = [
	...INDIVIDUAL_CORRECTNESS_SIGNALS,
	VERIFY_SUITE_SIGNAL,
];

/**
 * Public — Stop-time nudge when the session has code-file edits but
 * the agent never ran a typechecker / tests / linter / build. Returns
 * null when satisfied (no warning needed).
 *
 * Wording is deliberately reflective ("before stopping, run …") rather
 * than imperative — this is a stderr nudge, not a force-retry deny.
 */
export function formatUnverifiedCodeWarning(opts: FormatUnverifiedCodeOpts): string | null {
	if (opts.codeFilesEdited === 0) return null;
	if (CORRECTNESS_SIGNALS.some((k) => opts.verificationObserved.has(k))) return null;
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.codeFilesEdited} code file edit(s) ` +
		"and no verification this session — no tsc / test / lint / build invocation observed. " +
		"Before stopping, run the project's typecheck or tests " +
		"(e.g., `npx tsc --noEmit`, `bun run test`, or the project's verify command) " +
		"to confirm the edits actually compile and pass. Don't claim done on unverified work."
	);
}

export interface FormatVerifyNotRunOpts {
	/** Distinct code files written this session. */
	codeFilesEdited: number;
	/** Verification signals observed this session. */
	verificationObserved: ReadonlySet<string>;
}

/**
 * Public — Stop-time nudge when code files were edited and the agent
 * ran *some* verification (tsc, tests, lint, build) but never
 * `interlinked verify` specifically. The verify suite is broader than
 * any individual tool — it also runs docs:check, dep-audit, semgrep,
 * and the gen-marker validators that bit us in commit 5452fac. A
 * passing tsc + npm test does not prove the verify suite is green.
 *
 * Returns null when:
 *   - No code files were edited (nothing to verify), OR
 *   - `verify-suite` is already in `verificationObserved` (satisfied), OR
 *   - No correctness signals at all were observed (the broader
 *     `warn_unverified_code` nudge handles that case; this one would
 *     just add noise on top).
 */
export function formatVerifyNotRunWarning(opts: FormatVerifyNotRunOpts): string | null {
	if (opts.codeFilesEdited === 0) return null;
	if (opts.verificationObserved.has(VERIFY_SUITE_SIGNAL)) return null;
	// Don't double-nudge: if nothing was verified, let
	// formatUnverifiedCodeWarning carry the message. This nudge fires
	// only on the partial-verification case (some individual tool ran
	// but not the suite).
	if (!INDIVIDUAL_CORRECTNESS_SIGNALS.some((s) => opts.verificationObserved.has(s))) {
		return null;
	}
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.codeFilesEdited} code file edit(s) ` +
		"and partial verification — individual checks ran but `interlinked verify` did not. " +
		"The verify suite is the canonical local mirror of CI (tsc + biome + lint + secrets + " +
		"SAST + docs:check + dep-audit aggregated). Run `interlinked verify` before stopping to " +
		"confirm the full pipeline is clean — a green tsc doesn't catch docs drift, secrets, or " +
		"the lint/SAST findings verify aggregates."
	);
}

export interface FormatUiNotInteractedOpts {
	/** Distinct UI files written this session. */
	uiFilesEdited: number;
	/** Verification signals observed this session. */
	verificationObserved: ReadonlySet<string>;
}

/**
 * Public — Stop-time nudge when UI files were edited but no
 * dev-server / browser-MCP interaction was observed this session.
 *
 * Per `feedback_landing_test_before_push.md`: type-checking is not
 * feature-checking. UI work needs a browser load to verify behavior.
 */
export function formatUiNotInteractedWarning(opts: FormatUiNotInteractedOpts): string | null {
	if (opts.uiFilesEdited === 0) return null;
	if (
		opts.verificationObserved.has("browser") ||
		opts.verificationObserved.has("dev-server")
	) {
		return null;
	}
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.uiFilesEdited} UI file edit(s) ` +
		"(.tsx / .jsx / .html / .css / .vue / .svelte / .astro) and no browser interaction this session " +
		"— neither a dev server (wrangler dev / vite / npm run dev) nor a chrome-devtools / playwright MCP " +
		"call was observed. Type-checking is not feature-checking: load the page and verify what you built " +
		"before claiming done."
	);
}

export interface FormatStubsIntroducedOpts {
	stubs: ReadonlyArray<{ file: string; kind: string; snippet: string }>;
	maxShown?: number;
}

/**
 * Public — Stop-time nudge summarizing stubs / TODOs / disabled-tests /
 * not-implemented throws the agent introduced via Write/Edit content
 * during the session. Returns null when nothing was tracked.
 *
 * Shows the first `maxShown` (default 5) by file basename + kind +
 * line snippet, followed by an "...and N more" suffix when applicable.
 */
export function formatStubsIntroducedWarning(opts: FormatStubsIntroducedOpts): string | null {
	if (opts.stubs.length === 0) return null;
	const max = opts.maxShown ?? 5;
	const shown = opts.stubs.slice(0, max);
	const lines = shown.map((s) => `  - ${basename(s.file)} [${s.kind}]: ${s.snippet}`);
	const more = opts.stubs.length > max ? `\n  ...and ${opts.stubs.length - max} more` : "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.stubs.length} stub / TODO / disabled-test ` +
		`addition(s) introduced this session:\n${lines.join("\n")}${more}\n` +
		"If these are deliberate scaffolding, document the follow-up in a TODO list or issue. " +
		"If they're forgotten work, finish them before stopping."
	);
}

// ---------------------------------------------------------------------------
// TDD regression + git-bisect Stop nudges
// ---------------------------------------------------------------------------

/**
 * Public — Stop-time nudge when one or more tracked TDD cycles ended the
 * session in the `regression` state: a test that passed earlier this
 * session is now failing. A green→red transition is strong evidence the
 * session's edits broke previously-working behavior. Returns null when
 * there are no regressions.
 */
export function formatTddRegressionWarning(opts: {
	regressions: ReadonlyArray<{ sourceFile: string }>;
	maxShown?: number;
}): string | null {
	if (opts.regressions.length === 0) return null;
	const max = opts.maxShown ?? 5;
	const shown = opts.regressions.slice(0, max);
	const lines = shown.map((r) => `  - ${basename(r.sourceFile)}`);
	const more =
		opts.regressions.length > max
			? `\n  ...and ${opts.regressions.length - max} more`
			: "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.regressions.length} test ` +
		"regression(s) — a test that was passing earlier this session is now failing:\n" +
		`${lines.join("\n")}${more}\n` +
		"A green→red transition means this session's edits broke previously-working " +
		"behavior. Re-run the test(s) and fix the regression before stopping."
	);
}

/** A `git bisect` sub-command that puts the repo INTO bisect state (or keeps
 *  it there). `reset` is deliberately excluded — it is the exit. */
const BISECT_OP_RE = /\bgit\s+bisect\s+(?:start|good|bad|new|old|skip|run)\b/;
/** `git bisect reset` — the command that restores HEAD and ends a bisect. */
const BISECT_RESET_RE = /\bgit\s+bisect\s+reset\b/;

/**
 * Public — Stop-time nudge when the session ran `git bisect start` (or any
 * bisect step) without a later `git bisect reset`. An unfinished bisect
 * leaves the working tree on an old commit in detached-HEAD state, which is
 * a confusing place to stop. Returns null when there is no bisect activity,
 * or a reset followed the last bisect step.
 */
export function formatBisectNotResetWarning(opts: {
	commandsRun: ReadonlyArray<string>;
}): string | null {
	let lastOp = -1;
	let lastReset = -1;
	for (let i = 0; i < opts.commandsRun.length; i++) {
		const c = opts.commandsRun[i];
		if (BISECT_OP_RE.test(c)) lastOp = i;
		if (BISECT_RESET_RE.test(c)) lastReset = i;
	}
	if (lastOp === -1 || lastReset > lastOp) return null;
	return (
		"[interlinked:verify-before-stop] Stopping with an unfinished git bisect — a " +
		"`git bisect start/good/bad/run` ran this session with no `git bisect reset` " +
		"after it. The working tree is likely still on an old commit in detached-HEAD " +
		"bisect state. Run `git bisect reset` to restore HEAD before stopping."
	);
}

// ---------------------------------------------------------------------------
// Aggregation helpers for the Stop branch
// ---------------------------------------------------------------------------

/**
 * Public — count distinct code files (non-doc) written this session.
 *
 * `files_written` stores BOTH the raw and resolved-absolute form per
 * the existing convention in session-state.ts, so a naive `.size`
 * double-counts. We dedupe by skipping the raw form when the resolved
 * absolute form is also present.
 */
export function countCodeFilesEdited(filesWritten: ReadonlySet<string>): number {
	return countMatchingFiles(filesWritten, isCodeFile);
}

/** Public — count distinct UI files (subset of code files) written this session. */
export function countUiFilesEdited(filesWritten: ReadonlySet<string>): number {
	return countMatchingFiles(filesWritten, isUiFile);
}

function countMatchingFiles(
	filesWritten: ReadonlySet<string>,
	predicate: (p: string) => boolean,
): number {
	const matching: string[] = [];
	for (const path of filesWritten) {
		if (predicate(path)) matching.push(path);
	}
	// Dedupe: if both `src/foo.ts` and `/abs/path/src/foo.ts` are
	// present, keep only the absolute form. Heuristic: a path is the
	// "raw" duplicate of an absolute path if some absolute path in the
	// set ends with `/` + raw.
	const absolutes = matching.filter((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p));
	const relatives = matching.filter((p) => !absolutes.includes(p));
	const dedupedRelatives = relatives.filter(
		(rel) => !absolutes.some((abs) => abs.endsWith(`/${rel}`) || abs.endsWith(`\\${rel}`)),
	);
	return absolutes.length + dedupedRelatives.length;
}

// ---------------------------------------------------------------------------
// Doc-fact drift (gen-marker) — Stop nudge
// ---------------------------------------------------------------------------
// The landing page and README embed `<!-- gen:* -->` counters (built-in rule
// count, runner list, mode names) that scripts/extract-doc-facts.mjs computes
// from source. Editing one of those source files without regenerating the docs
// drifts the counters — a failure CI's docs:check (and the pre-push gate)
// catch, but only at push time, after a whole session of edits. This Stop
// nudge surfaces it the moment the session ends instead. (The 113→116 rule
// count that landed red is the canonical instance.)
//
// The matched set mirrors extract-doc-facts.mjs's extract*() inputs that
// produce a COUNT or LIST — the values that silently drift:
//   - src/harness/rules/builtin-rules-*.ts → builtin_rule_count
//   - src/lib/hooks.ts                     → runner_count / runners_inline
//   - src/harness/modes.ts                 → mode_names_*
// package.json (node-min) is deliberately excluded: it changes rarely and is
// edited for many unrelated reasons, so including it would over-fire.
const DOC_FACT_SOURCE_RE =
	/(?:^|\/)(?:src\/harness\/rules\/builtin-rules-[\w-]+\.ts|src\/lib\/hooks\.ts|src\/harness\/modes\.ts)$/;

/** Public predicate — a source file the doc-fact extractor reads to compute a
 *  gen-marker counter. Editing one can drift the landing/README counters. */
export function isDocFactSourceFile(filePath: string): boolean {
	return DOC_FACT_SOURCE_RE.test(filePath);
}

/** Public — count distinct doc-fact source files written this session. */
export function countDocFactSourcesEdited(filesWritten: ReadonlySet<string>): number {
	return countMatchingFiles(filesWritten, isDocFactSourceFile);
}

/** Commands that regenerate or validate the gen-markers. Seeing one in the
 *  session's command history means the agent already reconciled the docs, so
 *  the nudge would be noise. `interlinked verify` aggregates docs:check. */
const DOCS_REGEN_CMD_RE = /\bdocs:(?:build|check)\b|\bcheck-docs(?:\.mjs)?\b|\binterlinked\s+verify\b/;

export interface FormatDocMarkerDriftOpts {
	/** Distinct doc-fact source files written this session. */
	docSourcesEdited: number;
	/** Shell commands run this session (to suppress once docs were regenerated). */
	commandsRun: ReadonlyArray<string>;
}

/**
 * Public — Stop-time nudge when a gen-marker SOURCE file (a built-in rule
 * family, the runner registry, or the modes type) was edited this session but
 * no `docs:build` / `docs:check` / `interlinked verify` was run. Those edits
 * drift the `<!-- gen:* -->` counters on the landing page and README, which
 * CI's docs:check and the pre-push gate block on. Firing here turns a
 * push-time / CI-only signal into an in-session one.
 *
 * Returns null when no doc-fact source was edited, or when the docs were
 * already regenerated / validated this session.
 */
export function formatDocMarkerDriftWarning(opts: FormatDocMarkerDriftOpts): string | null {
	if (opts.docSourcesEdited === 0) return null;
	if (opts.commandsRun.some((c) => DOCS_REGEN_CMD_RE.test(c))) return null;
	return (
		`[interlinked:verify-before-stop] Stopping with ${opts.docSourcesEdited} edit(s) to a ` +
		"doc-fact source (a built-in rule family, the runner registry, or the modes type) and no " +
		"`docs:build` / `docs:check` run this session. These files feed the generated " +
		"`<!-- gen:* -->` counters on the landing page and README; CI's docs:check (and the pre-push " +
		"gate) block on drift. Run `npm run docs:build && npm run docs:check` before pushing — a stale " +
		"rule count is otherwise a CI-only signal that lands red on main."
	);
}
