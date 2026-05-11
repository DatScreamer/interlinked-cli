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
 *  Correctness signals (typecheck, test, lint, build) satisfy the
 *  "unverified code" check. UI-interaction signals (browser, dev-server)
 *  satisfy the "UI not interacted" check. Each kind is treated as a
 *  separate axis — running `bun run dev` proves the UI was at least
 *  loadable but does NOT prove the code typechecks. */
export type VerificationSignal =
	| "typecheck"
	| "test"
	| "lint"
	| "build"
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

/** Dev-server starters across the common JS frameworks.
 *  Pattern matches both `wrangler dev` and `npm run dev` / `bun run dev`
 *  shapes. */
const DEV_SERVER_RE =
	/\b(?:wrangler\s+dev|next\s+dev|vite(?:\s+dev|\s+preview|\s+--port)?|astro\s+dev|nuxt\s+dev|svelte-kit\s+dev|webpack\s+serve|remix\s+dev|gatsby\s+develop)\b|\b(?:npm|bun|pnpm|yarn)\s+run\s+dev\b/;

/**
 * Public predicate — classify a Bash command into a single verification
 * signal kind, or null. The first matching pattern wins; commands that
 * chain multiple kinds (`bun run test && bun run build`) return whichever
 * the regex order resolves first.
 */
export function classifyVerificationCommand(cmd: string): VerificationSignal | null {
	if (TYPECHECK_RE.test(cmd)) return "typecheck";
	if (TEST_RE.test(cmd)) return "test";
	if (LINT_RE.test(cmd)) return "lint";
	if (BUILD_RE.test(cmd)) return "build";
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

/** Correctness-grade signals — any one satisfies the unverified-code check. */
const CORRECTNESS_SIGNALS: readonly string[] = ["typecheck", "test", "lint", "build"];

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
