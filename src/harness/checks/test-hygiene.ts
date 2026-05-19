// Test-file hygiene checks (Batch 2).
//
// Seven inline detectors that fire only on test files. Each catches a
// distinct test-suite-gaming or test-isolation failure mode common in
// LLM-authored test code. All are <1ms regex-based.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

const TEST_BLOCK_INTRO_RE =
	/\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(\s*(["'`])([^"'`]*)\1/g;

// ==========================================================================
// 1. Duplicate test names within a file
// ==========================================================================
// `it("returns 404")` declared twice in the same file. Catches the
// copy-paste-then-edit-half-of-it bug — both blocks pass, reviewers see
// two test names that look identical and assume one is a typo, but in
// fact the assertions diverged.

/** Public API — flags duplicate `it()` / `test()` names within a single file. */
export function checkDuplicateTestNames(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	void stripped;
	// Use original content to read literal names. We DON'T strip strings
	// because the names ARE the strings.
	const seen = new Map<string, number>();
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 10;

	TEST_BLOCK_INTRO_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TEST_BLOCK_INTRO_RE.exec(content);
	while (m !== null) {
		const name = m[2].trim();
		if (name.length === 0) {
			m = TEST_BLOCK_INTRO_RE.exec(content);
			continue;
		}
		const offset = m.index;
		const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;
		const prev = seen.get(name);
		if (prev !== undefined) {
			matches.push({
				line: lineIdx + 1,
				text: `duplicate test name "${name.slice(0, 80)}" — first declared on line ${prev + 1}. Rename one or merge the cases.`,
			});
			if (matches.length >= MAX_MATCHES) break;
		} else {
			seen.set(name, lineIdx);
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
	if (!isTestFile(filePath)) return [];
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
	if (!isTestFile(filePath)) return [];
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
	if (!isTestFile(filePath)) return [];
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
	if (!isTestFile(filePath)) return [];
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

	return [
		{
			line: 1,
			text: `test file does not import its SUT (\`./${sutBase}\` not found in any \`from\` / \`require\` specifier). The test is not testing what its name claims.`,
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
	if (!isTestFile(filePath)) return [];
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
	if (!isTestFile(filePath)) return [];
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
