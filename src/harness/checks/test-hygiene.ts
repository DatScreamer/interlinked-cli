// Test-file hygiene checks (Batch 2).
//
// Six inline detectors that fire only on test files. Each catches a
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
