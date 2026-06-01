// Test-file hygiene checks (Batch 2).
//
// Seven inline detectors that fire only on test files. Each catches a
// distinct test-suite-gaming or test-isolation failure mode common in
// LLM-authored test code. All are <1ms regex-based.

import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

const TEST_BLOCK_INTRO_RE =
	/\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(\s*(["'`])([^"'`]*)\1/g;

/** Length-preserving code mask for checkDuplicateTestNames: blanks TS comments
 *  AND string-literal interiors with spaces, keeping every offset aligned with
 *  the original `content`. stripComments is length-preserving but KEEPS strings;
 *  stripStrings blanks strings but COLLAPSES them (`"dup"` → `""`), which shifts
 *  every downstream offset. We need both blanked AND offset-stable so a regex
 *  match on the raw content can be asked "is this `it(` real code, or does it
 *  live inside a comment / string literal?" — the latter is the
 *  duplicate_test_names FP (doc examples like `it.skip(`, and test fixtures like
 *  `writeFileSync(f, "it('x')")`). */
function codeOnlyMask(content: string): string {
	let mask = stripComments(content);
	const blank = (m: string) => " ".repeat(m.length);
	mask = mask.replace(/"(?:[^"\\]|\\.)*"/g, blank);
	mask = mask.replace(/'(?:[^'\\]|\\.)*'/g, blank);
	mask = mask.replace(/`(?:[^`\\]|\\.)*`/g, blank);
	return mask;
}

// ==========================================================================
// 1. Duplicate test names within a file
// ==========================================================================
// `it("returns 404")` declared twice in the same file. Catches the
// copy-paste-then-edit-half-of-it bug — both blocks pass, reviewers see
// two test names that look identical and assume one is a typo, but in
// fact the assertions diverged.

// Refinement (2026-05): account for the parent `describe()` scope.
// `it("x")` in `describe("A", ...)` and `it("x")` in `describe("B", ...)` are
// NOT duplicates — vitest reports them as `A > x` and `B > x` and the
// reporter is unambiguous. The pre-refinement check ignored describe nesting
// and FP'd on any sibling describes that happened to use the same test
// name (the canonical case: three "does NOT fire for test files" tests in
// tdd-cycle.test.ts, each under a different SUT's describe block).
const DESCRIBE_INTRO_RE = /\bdescribe(?:\.(?:each|only|skip|skipIf|runIf|sequential))*\s*\(/g;

/**
 * Build the offset of each describe() body in the ORIGINAL content. Each entry
 * says: "from `bodyStart` to `bodyEnd`, this describe's body extends." Operates
 * on `content` directly, not on `stripCommentsAndStrings`-cleaned content,
 * because the stripper COMPACTS quoted strings — `"checkA"` becomes `""` —
 * so offsets in `stripped` diverge from offsets in `content`. The walker
 * tracks inline quote state so a `{` inside a string literal doesn't move
 * brace depth. Returns describes in source order.
 *
 * The second `_stripped` parameter is retained for signature stability across
 * the refactor and is intentionally unused.
 */
function findDescribeRanges(
	content: string,
	_stripped: string,
): Array<{ bodyStart: number; bodyEnd: number }> {
	void _stripped;
	const ranges: Array<{ bodyStart: number; bodyEnd: number }> = [];
	DESCRIBE_INTRO_RE.lastIndex = 0;
	let m: RegExpExecArray | null = DESCRIBE_INTRO_RE.exec(content);
	while (m !== null) {
		// Find the callback body's opening `{`, skipping any `{`/`}` that
		// sit inside string literals (e.g. `describe("a {b} c", ...)`).
		const open = scanForOpenBraceSkippingStrings(content, m.index + m[0].length);
		if (open < 0) {
			m = DESCRIBE_INTRO_RE.exec(content);
			continue;
		}
		const end = findMatchingCloseBraceSkippingStrings(content, open);
		if (end > open) ranges.push({ bodyStart: open, bodyEnd: end });
		m = DESCRIBE_INTRO_RE.exec(content);
	}
	return ranges;
}

/** Skip forward to the next top-level `{` after `start`, ignoring any `{`
 *  that appears inside a `"…"` / `'…'` / `` `…` `` string. -1 if none. */
function scanForOpenBraceSkippingStrings(content: string, start: number): number {
	let inQuote: '"' | "'" | "`" | null = null;
	for (let i = start; i < content.length; i++) {
		const ch = content[i];
		if (inQuote) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inQuote = ch;
			continue;
		}
		if (ch === "{") return i;
	}
	return -1;
}

/** Walk balanced braces from `openIdx` (where `content[openIdx] === '{'`),
 *  ignoring any `{` / `}` inside string literals. Returns the index of the
 *  matching `}`, or -1 if unbalanced. */
function findMatchingCloseBraceSkippingStrings(content: string, openIdx: number): number {
	let depth = 0;
	let inQuote: '"' | "'" | "`" | null = null;
	for (let i = openIdx; i < content.length; i++) {
		const ch = content[i];
		if (inQuote) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inQuote = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Innermost describe range that contains `offset`. Returns `null` for an
 * `it()` at file root (no enclosing describe). Used as the dedup-scope key:
 * two `it()`s with the same name share a key only when they sit inside the
 * same describe body.
 */
function innermostDescribeAt(
	offset: number,
	ranges: ReadonlyArray<{ bodyStart: number; bodyEnd: number }>,
): { bodyStart: number; bodyEnd: number } | null {
	let best: { bodyStart: number; bodyEnd: number } | null = null;
	for (const r of ranges) {
		if (offset > r.bodyStart && offset < r.bodyEnd) {
			// More-deeply-nested wins (smaller body → strictly inside).
			if (!best || r.bodyStart > best.bodyStart) best = r;
		}
	}
	return best;
}

/** Public API — flags duplicate `it()` / `test()` names within the SAME
 *  enclosing `describe()` scope. Sibling describes can reuse a test name. */
export function checkDuplicateTestNames(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const describeRanges = findDescribeRanges(content, stripped);
	const codeMask = codeOnlyMask(content);

	// Scope key: bodyStart of the enclosing describe, or "" for file-root.
	// Per-scope `seen` map gives us "same name in the same describe" while
	// allowing the same name across sibling describes.
	const seenByScope = new Map<string, Map<string, number>>();
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 10;

	// Match declarations on RAW content — the test name is a string literal we
	// must read intact — but skip any `it(` whose opener is blanked in the
	// length-preserving codeMask, i.e. it lives inside a comment or a string.
	TEST_BLOCK_INTRO_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TEST_BLOCK_INTRO_RE.exec(content);
	while (m !== null) {
		const offset = m.index;
		if (codeMask[offset] === " ") {
			m = TEST_BLOCK_INTRO_RE.exec(content);
			continue;
		}
		const name = m[2].trim();
		if (name.length === 0) {
			m = TEST_BLOCK_INTRO_RE.exec(content);
			continue;
		}
		const enclosing = innermostDescribeAt(offset, describeRanges);
		const scopeKey = enclosing ? String(enclosing.bodyStart) : "";
		const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;

		let scope = seenByScope.get(scopeKey);
		if (!scope) {
			scope = new Map();
			seenByScope.set(scopeKey, scope);
		}
		const prev = scope.get(name);
		if (prev !== undefined) {
			matches.push({
				line: lineIdx + 1,
				text: `duplicate test name "${name.slice(0, 80)}" — first declared on line ${prev + 1} in the same describe scope. Rename one or merge the cases.`,
			});
			if (matches.length >= MAX_MATCHES) break;
		} else {
			scope.set(name, lineIdx);
		}
		m = TEST_BLOCK_INTRO_RE.exec(content);
	}
	return matches;
}

// ==========================================================================
// 2. Real network / filesystem in tests
// ==========================================================================
// `fetch(`, `http.request(`, `https.request(`, `writeFileSync` to non-tmp
// paths inside test files. Allowlist localhost / 127.0.0.1 / os.tmpdir() /
// __fixtures__ / tmp/ paths. Hits = flaky test or test that hits the real
// internet.

const NETWORK_CALL_RE =
	/\b(?:fetch|axios\s*\.\s*(?:get|post|put|patch|delete|request)|got|node-fetch|undici\.fetch|https?\.(?:request|get))\s*\(/;
const HTTP_LITERAL_URL_RE = /["'`](https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0))[^"'`]+)["'`]/;

const FS_WRITE_RE =
	/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\s*\(\s*["'`]([^"'`]+)["'`]/;
const TMP_PATH_RE = /(?:^|[/\\])(?:tmp|__fixtures__|fixtures|tmp\/|\.tmp|os\.tmpdir|tmpdir)/i;

/** Public API — flags real-network/FS calls in test files. */
export function checkRealIoInTests(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const original = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const line = strippedLines[i];

		// Network: only flag if the same line in the ORIGINAL contains a URL
		// pointing somewhere that isn't localhost / 127.0.0.1 / 0.0.0.0.
		if (NETWORK_CALL_RE.test(line)) {
			const urlMatch = HTTP_LITERAL_URL_RE.exec(original[i]);
			if (urlMatch) {
				matches.push({
					line: i + 1,
					text: `real network call in test (${urlMatch[1].slice(0, 80)}). Mock with msw / fetch-mock / nock — real upstreams make tests flaky.`,
				});
				continue;
			}
		}

		// FS write: only flag when the path literal isn't under a tmp / fixtures dir.
		const fsMatch = FS_WRITE_RE.exec(original[i]);
		if (fsMatch) {
			const target = fsMatch[1];
			if (!TMP_PATH_RE.test(target) && !target.startsWith("/tmp")) {
				matches.push({
					line: i + 1,
					text: `test writes to real filesystem path "${target.slice(0, 80)}". Use os.tmpdir() / a __fixtures__ dir / a memfs mock.`,
				});
			}
		}
	}
	return matches;
}

// ==========================================================================
// 3. Date.now / Math.random in test bodies
// ==========================================================================
// Same pattern as Batch 1's untestable_time_in_source, scoped to test
// files. Tests using these globals directly are flake breeders.

const TEST_NONDETERMINISM_RE =
	/\b(?:Date\s*\.\s*now\s*\(|new\s+Date\s*\(\s*\)|Math\s*\.\s*random\s*\(|crypto\s*\.\s*randomUUID\s*\(|crypto\s*\.\s*randomBytes\s*\(|performance\s*\.\s*now\s*\()/;

// Inside common mock-setup APIs, these are fine.
const MOCK_SETUP_LINE_RE =
	/\b(?:vi|jest)\s*\.\s*(?:setSystemTime|useFakeTimers|useRealTimers|spyOn|mock)\b/;

/** Public API — flags Date.now / Math.random in test code without mocking. */
export function checkTestNondeterminism(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const original = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	// If the file uses fake-timers, Date.now is mocked at the global level —
	// suppress the check entirely for that file.
	if (/\bvi\s*\.\s*useFakeTimers\b|\bjest\s*\.\s*useFakeTimers\b/.test(stripped)) return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (MOCK_SETUP_LINE_RE.test(strippedLines[i])) continue;
		const m = TEST_NONDETERMINISM_RE.exec(strippedLines[i]);
		if (!m) continue;
		matches.push({
			line: i + 1,
			text: `test uses ${m[0].replace(/\s+/g, "")} without mocking — use vi.setSystemTime / vi.useFakeTimers / a stubbed clock. ${original[i].trim().slice(0, 80)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 4. Hardcoded setTimeout(_, NNNN) in tests
// ==========================================================================
// Tests waiting on a literal millisecond delay are a tell that the agent
// gave up debugging the timing condition. Allowlists `setTimeout(_, 0)`
// (microtask flush is legitimate).

const HARDCODED_TIMEOUT_RE =
	/\b(?:setTimeout|setImmediate)\s*\(\s*[^,)]+,\s*([1-9]\d*)\s*\)/;

/** Public API — flags hardcoded ms timeouts in test bodies. */
export function checkHardcodedTimeoutInTests(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const original = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = HARDCODED_TIMEOUT_RE.exec(strippedLines[i]);
		if (!m) continue;
		const ms = m[1];
		matches.push({
			line: i + 1,
			text: `hardcoded ${ms}ms wait in test — fix the timing condition (vi.waitFor / poll a deterministic predicate) instead of adding sleep. ${original[i].trim().slice(0, 80)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 5. Test file missing SUT import
// ==========================================================================
// `foo.test.ts` should import something resembling `./foo`. Without that,
// the test almost certainly isn't testing what its name claims.
// Conservative: only fires if NO relative import in the file matches the
// SUT basename — type-only imports / namespace imports / re-exports all
// count.

/** Public API — flags test files that don't import their SUT. */
export function checkTestMissingSutImport(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return [];

	const norm = filePath.replace(/\\/g, "/");
	const fileName = norm.split("/").pop() || "";
	const sutBase = fileName.replace(/\.(test|spec)\.(tsx?|jsx?|mjs|cjs)$/, "");
	if (!sutBase || sutBase === fileName) return [];
	if (sutBase === "index") return [];
	if (norm.includes("__fixtures__/") || norm.includes("/__mocks__/")) return [];

	// Build a pattern that looks for the SUT in any relative import — quote
	// kind, optional ./ ../, optional path prefix, basename, optional .js.
	const escaped = sutBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const importPattern = new RegExp(
		`(?:from|require)\\s*\\(?\\s*["']\\.{1,2}\\/(?:[^"']*\\/)?${escaped}(?:\\.(?:js|ts|tsx|mjs|cjs))?["']`,
	);
	if (importPattern.test(content)) return [];
	if (hasAnyProjectSourceImport(content)) return [];

	return [
		{
			line: 1,
			text: `test file does not import its SUT (\`./${sutBase}\` not found, and the file imports no other project source). The test is not testing what its name claims.`,
		},
	];
}

// ==========================================================================
// 6. Mocking the SUT in its own test
// ==========================================================================
// `vi.mock("./foo")` / `jest.mock("./foo")` inside `foo.test.ts` where
// the relative path resolves to the SUT itself. Almost always means the
// agent silenced the actual code under test rather than fixing it.

const SUT_MOCK_RE = /\b(?:vi|jest)\s*\.\s*mock\s*\(\s*["']([^"']+)["']/g;

/** Public API — flags mocks of the SUT inside its own test file. */
export function checkMockingTheSutSelf(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const norm = filePath.replace(/\\/g, "/");
	const fileName = norm.split("/").pop() || "";
	const sutBase = fileName.replace(/\.(test|spec)\.(tsx?|jsx?|mjs|cjs)$/, "");
	if (!sutBase || sutBase === fileName) return [];

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 3;

	SUT_MOCK_RE.lastIndex = 0;
	let m: RegExpExecArray | null = SUT_MOCK_RE.exec(content);
	while (m !== null && matches.length < MAX_MATCHES) {
		const target = m[1];
		// Resolve the target's basename and compare to the SUT.
		const targetBase = target.split("/").pop()?.replace(/\.(js|ts|tsx|mjs|cjs)$/, "") ?? "";
		if (targetBase === sutBase) {
			const offset = m.index;
			const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `test mocks the system under test (\`${target}\`). The test is no longer verifying its target — fix the SUT or test something else.`,
			});
		}
		m = SUT_MOCK_RE.exec(content);
	}
	return matches;
}

// ==========================================================================
// 7. it() / test() spawning a known-slow subprocess with no explicit timeout
// ==========================================================================
// A vitest case whose callback shells out to a known-slow tool — `tsc`,
// `biome`, `npx`, `tsx`, `eslint`, `vitest`, or the project's own CLI — but
// relies on the default `testTimeout`. Under CI's worker cap a cold `tsc`
// start can exceed the 10s default and intermittently redden the suite (see
// the runPerFileChecks / write.test.ts / verify.test.ts pattern). An explicit
// `{ timeout: N }` (options-object form) or a trailing numeric-timeout
// argument suppresses the finding — that is the established fix.
//
// Deliberately scoped to KNOWN-SLOW invocations: spawning `tsc` is genuinely
// slow, spawning `echo` is not, so a `child_process` call to a trivial
// command does NOT fire — this keeps the false-positive rate low.

// `it` / `test` (with the usual modifier chain), capturing only the call
// opening. `specify` is intentionally excluded — vitest's slow-subprocess
// flake is `it`/`test`, and `specify` carries no `{ timeout }` overload.
const IT_TEST_OPEN_RE = /\b(it|test)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|sequential|failing))*\s*\(/g;

// child_process spawn primitives. `exec`/`execFile`/`spawn` are matched with
// a word boundary so member calls like `cp.execSync` and bare `execSync`
// both hit; the leading boundary keeps `myExec(` from matching.
const CHILD_PROCESS_SPAWN_RE =
	/\b(?:execSync|spawnSync|execFileSync|execFile|exec|spawn)\s*\(/;

// Known-slow tools. Each entry is matched as a shell token (start-of-string,
// whitespace, or a quote boundary on the left; whitespace / end / quote on
// the right) so `tsc` matches `npx tsc --noEmit` but not `tscfg` or a path
// fragment like `artscript`.
const SLOW_TOOL_RE =
	/(?:^|["'`\s/])(?:tsc|tsgo|biome|npx|tsx|eslint|vitest|vite|interlinked)(?:["'`\s]|$)/;

/** Public API — flags it()/test() spawning a slow subprocess with no explicit timeout. */
export function checkTestSubprocessDefaultTimeout(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	// The check only makes sense when child_process is in play at all — a cheap
	// pre-filter that skips the brace-matching scan for the common case.
	if (!/child_process/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	IT_TEST_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = IT_TEST_OPEN_RE.exec(stripped);
	while (m !== null && matches.length < MAX_MATCHES) {
		const callName = m[1];
		// Index of the char right after the opening `(`.
		const argsStart = m.index + m[0].length;
		const span = findCallSpan(stripped, argsStart);
		if (span === null) {
			m = IT_TEST_OPEN_RE.exec(stripped);
			continue;
		}
		// The body region — the original (un-stripped) text so we can read the
		// real command-string contents to identify the slow tool.
		const bodyOriginal = content.slice(argsStart, span.end);
		const bodyStripped = stripped.slice(argsStart, span.end);

		// A spawn call has to be present as real code (stripped view), and the
		// slow-tool token has to be present in the original (string contents
		// survive there). Both conditions guard against fixture-string FPs.
		const spawnsSubprocess =
			CHILD_PROCESS_SPAWN_RE.test(bodyStripped) && SLOW_TOOL_RE.test(bodyOriginal);
		if (spawnsSubprocess && !hasExplicitTimeout(stripped, argsStart, span)) {
			const lineIdx = (stripped.slice(0, m.index).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `\`${callName}(...)\` spawns a known-slow subprocess (tsc / biome / npx / tsx / eslint / vitest / the CLI) but has no explicit timeout — under CI's worker cap a cold start can exceed the default testTimeout and flake. Pass an options object: \`${callName}(name, { timeout: 60_000 }, fn)\`.`,
			});
		}
		m = IT_TEST_OPEN_RE.exec(stripped);
	}
	return matches;
}

/**
 * Brace/paren-balanced span of an `it(...)` / `test(...)` call argument list.
 * `from` is the index just inside the opening `(`. Returns the index of the
 * matching close `)` plus the comma offsets at depth 0 (argument separators),
 * or null if unbalanced (truncated file / regex artifact).
 */
function findCallSpan(
	text: string,
	from: number,
): { end: number; topLevelCommas: number[] } | null {
	let depth = 1; // already inside the `it(` paren
	const topLevelCommas: number[] = [];
	const MAX_SCAN = 20_000; // a single test block past this is pathological
	const limit = Math.min(text.length, from + MAX_SCAN);
	for (let i = from; i < limit; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return { end: i, topLevelCommas };
		} else if (ch === "," && depth === 1) {
			topLevelCommas.push(i);
		}
	}
	return null;
}

// An object literal carrying a `timeout:` key — the vitest options-object form
// `it(name, { timeout: N }, fn)`.
const TIMEOUT_OPTION_RE = /\{[^{}]*\btimeout\s*:/;
// A trailing numeric (or numeric-separator) literal as the last argument:
// `it(name, fn, 60_000)` / `it(name, fn, 30000)`.
const TRAILING_NUMERIC_RE = /^\s*[0-9][0-9_]*\s*$/;

/**
 * True when an `it(...)` / `test(...)` call declares an explicit timeout —
 * either the `{ timeout: N }` options-object argument or a trailing numeric
 * timeout argument. Both are the documented vitest ways to override the
 * default, so either one means the author opted in deliberately.
 */
function hasExplicitTimeout(
	stripped: string,
	argsStart: number,
	span: { end: number; topLevelCommas: number[] },
): boolean {
	const argRegion = stripped.slice(argsStart, span.end);
	// Options-object form: a `{ ... timeout: ... }` anywhere in the arg list.
	if (TIMEOUT_OPTION_RE.test(argRegion)) return true;
	// Trailing-numeric form: text of the final argument is a bare number.
	if (span.topLevelCommas.length > 0) {
		const lastComma = span.topLevelCommas[span.topLevelCommas.length - 1];
		const lastArg = stripped.slice(lastComma + 1, span.end);
		if (TRAILING_NUMERIC_RE.test(lastArg)) return true;
	}
	return false;
}

// ==========================================================================
// 8. Mock-only test — every assertion is a call-interaction matcher
// ==========================================================================
// An it()/test() block whose only assertions are toHaveBeenCalled* /
// toHaveReturned* checks that a collaborator was *called* — never that the
// code produced a correct value, output, or state. It is a change-detector:
// it restates the call the author wrote, so it passes even when the behavior
// is wrong. A block whose call assertions are ALL negated (only
// `not.toHaveBeenCalled()`) is exempt — asserting a call did NOT happen is a
// genuine behavioral guarantee (a guard fired), not a tautology.

// Vitest / Jest call- and return-interaction matchers. Every member asserts
// *that a mock was invoked*, not what the code computed.
const CALL_INTERACTION_MATCHERS = new Set<string>([
	"toHaveBeenCalled",
	"toHaveBeenCalledTimes",
	"toHaveBeenCalledWith",
	"toHaveBeenLastCalledWith",
	"toHaveBeenNthCalledWith",
	"toHaveBeenCalledOnce",
	"toHaveBeenCalledExactlyOnceWith",
	"toHaveBeenCalledBefore",
	"toHaveBeenCalledAfter",
	"toBeCalled",
	"toBeCalledTimes",
	"toBeCalledWith",
	"lastCalledWith",
	"nthCalledWith",
	"toHaveReturned",
	"toHaveReturnedTimes",
	"toHaveReturnedWith",
	"toHaveLastReturnedWith",
	"toHaveNthReturnedWith",
	"toReturn",
	"toReturnTimes",
	"toReturnWith",
	"lastReturnedWith",
	"nthReturnedWith",
	"toHaveResolved",
	"toHaveResolvedTimes",
	"toHaveResolvedWith",
	"toHaveLastResolvedWith",
	"toHaveNthResolvedWith",
]);

// `expect(` in assertion position. `expect.objectContaining(` etc. is
// `expect.` — the `\(` requirement skips it (asymmetric matchers, not
// assertions).
const EXPECT_ASSERTION_RE = /\bexpect\s*\(/g;
// The `.mod.mod.matcher(` chain that follows an `expect(...)` close paren.
const MATCHER_CHAIN_RE = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/;
const ZERO_INTERACTION_COUNT_MATCHERS = new Set<string>([
	"toHaveBeenCalledTimes",
	"toBeCalledTimes",
	"toHaveReturnedTimes",
	"toReturnTimes",
	"toHaveResolvedTimes",
]);
const NODE_ASSERT_MODULE_RE = /^(?:node:assert(?:\/strict)?|assert)$/;
const NODE_ASSERT_HELPERS = new Set<string>([
	"deepEqual",
	"deepStrictEqual",
	"doesNotMatch",
	"doesNotReject",
	"doesNotThrow",
	"equal",
	"fail",
	"ifError",
	"match",
	"notDeepEqual",
	"notDeepStrictEqual",
	"notEqual",
	"notStrictEqual",
	"ok",
	"rejects",
	"strictEqual",
	"throws",
]);

interface ExpectClassification {
	/** True when the matcher is a call/return-interaction matcher. */
	isCallInteraction: boolean;
	/** True when the matcher chain contains a `.not` modifier. */
	negated: boolean;
}

// A non-call classification, shared for every expect whose matcher cannot be
// resolved. Read-only at every use site, so a single instance is safe.
const NON_CALL_EXPECT: ExpectClassification = { isCallInteraction: false, negated: false };

/**
 * Classify every `expect(...)` assertion in a stripped block body. An expect
 * whose matcher can't be resolved is reported as a non-call assertion — that
 * keeps the caller conservative: an unrecognized matcher prevents a
 * mock-only verdict rather than forcing one.
 */
function classifyBlockExpects(body: string): ExpectClassification[] {
	const out: ExpectClassification[] = [];
	EXPECT_ASSERTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPECT_ASSERTION_RE.exec(body);
	while (m !== null) {
		const span = findCallSpan(body, m.index + m[0].length);
		if (span === null) {
			out.push(NON_CALL_EXPECT);
			break;
		}
		const chain = MATCHER_CHAIN_RE.exec(body.slice(span.end + 1));
		if (chain === null) {
			out.push(NON_CALL_EXPECT);
		} else {
			const segments = chain[1]
				.split(".")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			const matcher = segments[segments.length - 1] ?? "";
			const matcherArgsStart = span.end + 1 + chain[0].length;
			out.push({
				isCallInteraction: CALL_INTERACTION_MATCHERS.has(matcher),
				negated:
					segments.includes("not") ||
					matcherHasZeroInteractionCount(body, matcher, matcherArgsStart),
			});
		}
		EXPECT_ASSERTION_RE.lastIndex = span.end + 1;
		m = EXPECT_ASSERTION_RE.exec(body);
	}
	return out;
}

function matcherHasZeroInteractionCount(
	body: string,
	matcher: string,
	argsStart: number,
): boolean {
	if (!ZERO_INTERACTION_COUNT_MATCHERS.has(matcher)) return false;
	const span = findCallSpan(body, argsStart);
	if (span === null) return false;
	const firstArgEnd = span.topLevelCommas[0] ?? span.end;
	const firstArg = body.slice(argsStart, firstArgEnd);
	return /^\s*0(?:\s+as\s+const)?\s*$/.test(firstArg);
}

/** Read an it()/test() case's name from its first argument's string literal. */
function readCaseName(content: string, argsStart: number, firstArgEnd: number): string {
	const nameMatch = content
		.slice(argsStart, firstArgEnd)
		.match(/["'`]([^"'`]{0,80})["'`]/);
	return nameMatch ? `"${nameMatch[1]}" ` : "";
}

function escapeRegexLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectImportedAssertHelpers(content: string): Set<string> {
	const helpers = new Set<string>();
	const withoutComments = stripComments(content);

	const importRe =
		/\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*(["'])([^"']+)\2/g;
	let m: RegExpExecArray | null = importRe.exec(withoutComments);
	while (m !== null) {
		if (NODE_ASSERT_MODULE_RE.test(m[3])) addAssertSpecifiers(helpers, m[1], "esm");
		m = importRe.exec(withoutComments);
	}

	const requireRe =
		/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*(["'])([^"']+)\2\s*\)/g;
	m = requireRe.exec(withoutComments);
	while (m !== null) {
		if (NODE_ASSERT_MODULE_RE.test(m[3])) addAssertSpecifiers(helpers, m[1], "cjs");
		m = requireRe.exec(withoutComments);
	}

	return helpers;
}

function addAssertSpecifiers(
	helpers: Set<string>,
	specifiers: string,
	mode: "esm" | "cjs",
): void {
	for (const raw of specifiers.split(",")) {
		const part = raw.trim().replace(/^type\s+/, "");
		if (part.length === 0) continue;
		const parsed =
			mode === "esm"
				? /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part)
				: /^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/.exec(part);
		if (!parsed) continue;
		const imported = parsed[1];
		const local = parsed[2] ?? imported;
		if (NODE_ASSERT_HELPERS.has(imported)) helpers.add(local);
	}
}

function hasImportedAssertHelperCall(body: string, helpers: Set<string>): boolean {
	for (const helper of helpers) {
		if (new RegExp(`\\b${escapeRegexLiteral(helper)}\\s*\\(`).test(body)) return true;
	}
	return false;
}

/** Public API — flags it()/test() blocks that assert only mock interactions. */
export function checkMockOnlyTest(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const importedAssertHelpers = collectImportedAssertHelpers(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 12;

	IT_TEST_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = IT_TEST_OPEN_RE.exec(stripped);
	while (m !== null && matches.length < MAX_MATCHES) {
		const argsStart = m.index + m[0].length;
		const span = findCallSpan(stripped, argsStart);
		if (span === null) {
			m = IT_TEST_OPEN_RE.exec(stripped);
			continue;
		}
		const body = stripped.slice(argsStart, span.end);
		// A non-expect assertion library (node:assert, chai `.should`) means
		// the block may well check a value — don't call it mock-only.
		const hasOtherAssertions =
			/\bassert\s*[(.]/.test(body) ||
			/\.\s*should\b/.test(body) ||
			hasImportedAssertHelperCall(body, importedAssertHelpers);
		const expects = classifyBlockExpects(body);
		// Mock-only: at least one assertion, EVERY assertion is a call
		// interaction, and at least one of them is a positive (non-negated)
		// call assertion. A block of only `not.toHaveBeenCalled()` is a real
		// guard test and is left alone.
		const everyCall = expects.length > 0 && expects.every((e) => e.isCallInteraction);
		const anyPositiveCall = expects.some((e) => e.isCallInteraction && !e.negated);
		if (!hasOtherAssertions && everyCall && anyPositiveCall) {
			const lineIdx = (stripped.slice(0, m.index).match(/\n/g) || []).length;
			const firstArgEnd = span.topLevelCommas[0] ?? span.end;
			const name = readCaseName(content, argsStart, firstArgEnd);
			matches.push({
				line: lineIdx + 1,
				text: `test ${name}asserts only mock interactions (toHaveBeenCalled / toHaveReturned) — it checks that a collaborator was called, not that the code produced a correct value, output, or state, so it passes even when the behavior is wrong. Assert a return value, rendered output, or observable state. A bare not.toHaveBeenCalled() is fine; a positive call-only assertion is not.`,
			});
		}
		m = IT_TEST_OPEN_RE.exec(stripped);
	}
	return matches;
}

// ==========================================================================
// 9. Happy-path-only test file — never asserts a failure path
// ==========================================================================
// A test file with three or more cases that never once asserts a negative
// outcome: no `.not.*`, no toThrow / `.rejects`, no false/null/undefined
// assertion, no error-handling case, and no test/describe NAMED for a
// failure path. A suite that can only observe success still passes when a
// regression breaks the error path. Any single negative assertion OR
// failure-named case clears the file — the escape hatch is one line.

const MIN_CASES_FOR_HAPPY_PATH = 3;

// A negative-outcome assertion anywhere in the (stripped) file.
const NEGATIVE_ASSERTION_RE =
	/\.\s*not\s*\.|\btoThrow(?:Error)?\s*\(|\.\s*rejects\b|\btoReject\w*\s*\(|\bto(?:BeFalsy|BeNull|BeUndefined|BeNaN)\s*\(|\bto(?:Be|Equal|StrictEqual)\s*\(\s*(?:false|null|undefined|NaN)\s*\)|\btoBeInstanceOf\s*\(\s*[A-Za-z_$][\w$]*Error|\binstanceof\s+[A-Za-z_$][\w$]*Error\b|\bcatch\s*[({]/;

// Failure-intent words in an it()/test()/describe() name. Deliberately broad:
// a single failure-named case is proof the file is not happy-path-only, so a
// wide net here only ever PREVENTS a finding — it cannot cause a false one.
const NEGATIVE_NAME_RE =
	/\b(?:error|errors|throw|throws|throwing|reject|rejects|rejected|fail|fails|failing|failure|invalid|malformed|missing|absent|empty|not|no|without|negative|guard|guards|block|blocks|blocked|deny|denies|denied|forbidden|unauthorized|refuse|refuses|crash|crashes|abort|aborts|edge|bad|wrong|conflict|unsupported|null|undefined|false|exception|raises?|catch|404|500|nonexistent)\b/i;

const DESCRIBE_NAME_RE =
	/\bdescribe(?:\.(?:each|only|skip|skipIf|runIf))?\s*\(\s*(["'`])([^"'`]*)\1/g;

function maskCommentsAndStrings(content: string): string {
	const chars = content.split("");
	let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" = "code";

	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		const next = chars[i + 1];

		if (mode === "line-comment") {
			if (ch === "\n") {
				mode = "code";
			} else {
				chars[i] = " ";
			}
			continue;
		}

		if (mode === "block-comment") {
			chars[i] = ch === "\n" ? "\n" : " ";
			if (ch === "*" && next === "/") {
				chars[i + 1] = " ";
				i++;
				mode = "code";
			}
			continue;
		}

		if (mode === "single" || mode === "double" || mode === "template") {
			chars[i] = ch === "\n" ? "\n" : " ";
			if (ch === "\\") {
				if (next !== undefined) {
					chars[i + 1] = next === "\n" ? "\n" : " ";
					i++;
				}
				continue;
			}
			if (
				(mode === "single" && ch === "'") ||
				(mode === "double" && ch === '"') ||
				(mode === "template" && ch === "`")
			) {
				mode = "code";
			}
			continue;
		}

		if (ch === "/" && next === "/") {
			chars[i] = " ";
			chars[i + 1] = " ";
			i++;
			mode = "line-comment";
		} else if (ch === "/" && next === "*") {
			chars[i] = " ";
			chars[i + 1] = " ";
			i++;
			mode = "block-comment";
		} else if (ch === "'") {
			chars[i] = " ";
			mode = "single";
		} else if (ch === '"') {
			chars[i] = " ";
			mode = "double";
		} else if (ch === "`") {
			chars[i] = " ";
			mode = "template";
		}
	}

	return chars.join("");
}

function isCodeMatch(maskedContent: string, offset: number): boolean {
	return /\S/.test(maskedContent[offset] ?? "");
}

function isSkippedOrTodoCall(matchText: string): boolean {
	const head = matchText.slice(0, Math.max(0, matchText.indexOf("(")));
	return /\.(?:skip|todo)\b/.test(head);
}

function blankRange(chars: string[], start: number, end: number): void {
	for (let i = start; i < Math.min(end, chars.length); i++) {
		chars[i] = chars[i] === "\n" ? "\n" : " ";
	}
}

function blankNonExecutingTestCalls(content: string, maskedContent: string): string {
	const chars = content.split("");
	for (const re of [TEST_BLOCK_INTRO_RE, DESCRIBE_NAME_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(content);
		while (m !== null) {
			if (isCodeMatch(maskedContent, m.index) && isSkippedOrTodoCall(m[0])) {
				const openParen = content.indexOf("(", m.index);
				const span = openParen === -1 ? null : findCallSpan(maskedContent, openParen + 1);
				blankRange(chars, m.index, span === null ? m.index + m[0].length : span.end + 1);
			}
			m = re.exec(content);
		}
	}
	return chars.join("");
}

/** Public API — flags test files whose every case asserts only success. */
export function checkHappyPathOnlyTest(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	// Count cases and collect their names from the original content — the
	// names ARE string literals, so they must not be stripped.
	const maskedContent = maskCommentsAndStrings(content);
	const executableContent = blankNonExecutingTestCalls(content, maskedContent);
	const executableMaskedContent = maskCommentsAndStrings(executableContent);
	const names: string[] = [];
	let caseCount = 0;
	let firstCaseLine = 1;
	TEST_BLOCK_INTRO_RE.lastIndex = 0;
	let t: RegExpExecArray | null = TEST_BLOCK_INTRO_RE.exec(executableContent);
	while (t !== null) {
		if (!isCodeMatch(executableMaskedContent, t.index)) {
			t = TEST_BLOCK_INTRO_RE.exec(executableContent);
			continue;
		}
		if (caseCount === 0) {
			firstCaseLine = (executableContent.slice(0, t.index).match(/\n/g) || []).length + 1;
		}
		caseCount++;
		names.push(t[2]);
		t = TEST_BLOCK_INTRO_RE.exec(executableContent);
	}
	if (caseCount < MIN_CASES_FOR_HAPPY_PATH) return [];

	DESCRIBE_NAME_RE.lastIndex = 0;
	let d: RegExpExecArray | null = DESCRIBE_NAME_RE.exec(executableContent);
	while (d !== null) {
		if (isCodeMatch(executableMaskedContent, d.index)) {
			names.push(d[2]);
		}
		d = DESCRIBE_NAME_RE.exec(executableContent);
	}

	// A failure-named case or block means the file exercises a negative path.
	if (names.some((name) => NEGATIVE_NAME_RE.test(name))) return [];
	// A negative assertion in the code means the same.
	if (NEGATIVE_ASSERTION_RE.test(stripCommentsAndStrings(executableContent))) return [];

	return [
		{
			line: firstCaseLine,
			text: `this test file has ${caseCount} cases but never asserts a failure path — no .not.* matcher, no toThrow, no .rejects, no false/null/undefined assertion, no error-handling case, no failure-named test. A suite that only checks success passes even when the error path regresses. Add at least one negative case — an invalid input, a thrown error, a rejected promise — or name a case for the failure it covers.`,
		},
	];
}

// Tier 2 helper for checkTestMissingSutImport. Defined here at file end
// rather than near its caller because of a diff-overlay tsc anomaly that
// fires on the regex-escape literal at line 314 when nearby content
// shifts. The helper itself is referenced once.
//
// SCOPE: only PARENT-directory imports (`../...`) count as Tier 2
// evidence. The shape captured is the multi-SUT test grouping pattern
// (e.g. `__tests__/tdd-cycle.test.ts` imports `../behavioral-checks.js`
// to test a related-but-differently-named module). Same-directory imports
// (`./xxx`) are intentionally excluded: a `foo.test.ts` that imports
// `./bar.js` but not `./foo.js` is still the canonical "misnamed test"
// bug class the strict tier was built to catch.
export function hasAnyProjectSourceImport(content: string): boolean {
	const re = /(?:from|require)\s*\(?\s*["'](\.\.\/[^"']+)["']/g;
	let m: RegExpExecArray | null = re.exec(content);
	while (m !== null) {
		const spec = m[1];
		const isTestImport = /\.(test|spec)\./.test(spec);
		const isMockImport = /(?:^|\/)__mocks__\//.test(spec);
		const isFixtureImport = /(?:^|\/)__fixtures__\//.test(spec);
		const isAssetImport =
			/\.(?:json|css|scss|less|html|svg|png|jpg|jpeg|gif|md)$/i.test(spec);
		if (!isTestImport && !isMockImport && !isFixtureImport && !isAssetImport) {
			return true;
		}
		m = re.exec(content);
	}
	return false;
}
