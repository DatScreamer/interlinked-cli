// Test-file hygiene checks — isolation & determinism family (Batch 2).
//
// The "tests must be deterministic & isolated" group: detectors that fire on
// test files where a test reaches real network/filesystem, depends on wall-clock
// or randomness, hardcodes a millisecond sleep, or shells out to a known-slow
// subprocess without an explicit timeout. All are <1ms regex-based.
//
// Public symbols are re-exported from `test-hygiene.ts` (the barrel) so the
// check registry and every importer stay unchanged.

import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
import { findCallSpan, IT_TEST_OPEN_RE } from "./test-hygiene-shared.js";

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

// Group 1 = the fs verb, group 2 = the path literal. Capturing the verb lets us
// drop calls to a locally-defined helper of the same name (see FS_HELPER_DEF_RE).
const FS_WRITE_RE =
	/\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\s*\(\s*["'`]([^"'`]+)["'`]/;
// Call token only (no path arg) — tested against the comment/string-stripped
// line to confirm the write is REAL code and not a write quoted inside a string
// fixture (e.g. a detector's own test feeding `writeFileSync("/etc/passwd")` as
// sample data). The path itself is then read back from the original line.
const FS_WRITE_CALL_RE =
	/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\s*\(/;
// A test that defines its own `function writeFile(name)` / `const writeFile = …`
// is almost always a tmpdir-scoped wrapper (`join(tmpDir, name)`); its bare-name
// call sites pass a relative leaf, not a real path. Calls to such locally-defined
// helpers are NOT raw node:fs I/O, so exclude those verb names for this file.
const FS_HELPER_DEF_RE =
	/\b(?:function|const|let|var)\s+(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|unlinkSync)\b/g;
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

	// Names the file defines itself — calls to these are wrapper helpers, not
	// raw node:fs writes. Scan the literal-stripped content so a verb mentioned
	// inside a string/comment doesn't register as a definition.
	const localFsHelpers = new Set<string>();
	for (const m of stripped.matchAll(FS_HELPER_DEF_RE)) localFsHelpers.add(m[1]);

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

		// FS write: require the call to survive in the STRIPPED line (real code,
		// not a write quoted inside a string fixture), then read the path literal
		// from the original line. Only flag paths outside a tmp / fixtures dir.
		if (FS_WRITE_CALL_RE.test(line)) {
			const fsMatch = FS_WRITE_RE.exec(original[i]);
			if (fsMatch) {
				const verb = fsMatch[1];
				const target = fsMatch[2];
				const isMemberCall = original[i][fsMatch.index - 1] === ".";
				const isLocalHelper = !isMemberCall && localFsHelpers.has(verb);
				if (!isLocalHelper && !TMP_PATH_RE.test(target) && !target.startsWith("/tmp")) {
					matches.push({
						line: i + 1,
						text: `test writes to real filesystem path "${target.slice(0, 80)}". Use os.tmpdir() / a __fixtures__ dir / a memfs mock.`,
					});
				}
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
