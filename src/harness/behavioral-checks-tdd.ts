// ===========================================
// Interlinked Harness — Behavioral Checks (TDD cycle + commit gates)
// ===========================================
// TDD-cycle state-machine checks (red→green tracking, regression, green
// confirmation), the git-diff-based commit gates (TPP leapfrog, prod/test
// delta, prod/test LOC ratio), and the assertion-density check. Split out
// of `behavioral-checks.ts` to keep each module under the per-file line
// cap; the public API is re-exported from `behavioral-checks.ts` so all
// importers are unchanged.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, basename as pathBasename } from "node:path";
import { isTypeOnlyModule, stripCommentsAndStrings } from "./checks/shared.js";
import { hasTddExemptDirective, isTddExemptPath } from "./evaluator/tdd-new-file-gate.js";
import type { AssertionCounts, CheckResultEntry, SessionTrajectory } from "./types.js";
import { isCodeFile } from "./verification-stop-checks.js";

// ---- Helpers ----

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

// Source-code extensions where TDD cycle tracking is meaningful. The cycle
// state machine and the "write a failing test first" nudge are about CODE
// — not docs, configs, JSON data, lockfiles, or generated bundles. Without
// this gate, editing a markdown design doc N times produces a misleading
// "write a test for it" warning.
const TDD_SOURCE_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp)$/i;

// ---- TDD Cycle Checks ----

/**
 * Detect TDD cycle violations: implementation edits without establishing a red test first.
 * Supersedes `repeated_edit_without_test` when TDD cycles are being tracked.
 */
export function checkTddCycleViolation(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	if (!TDD_SOURCE_EXT_RE.test(filePath)) return null;
	if (TEST_FILE_RE.test(filePath)) return null;
	if (isTddExemptPath(filePath)) return null;

	const cycle = session.tdd_cycles.get(filePath);
	if (!cycle) return null;

	// Agent is editing implementation with no test interaction at all
	if (cycle.impl_edits_before_test >= 3 && cycle.state === "no_test") {
		// Pure type-definition modules have nothing to unit-test — exempt
		// them from the "write a failing test" nudge (tsc is their test).
		if (isTypeOnlySourceFile(filePath)) return null;
		const msg = cycle.test_file
			? `${cycle.impl_edits_before_test} implementation edits to ${basename(filePath)} without running its test. Run the test first to establish a baseline.`
			: `${cycle.impl_edits_before_test} implementation edits to ${basename(filePath)} with no test file. Write a failing test that captures the expected behavior, then make it pass.`;
		return {
			source: "structural",
			name: "tdd_cycle_violation",
			severity: "warning",
			message: msg,
			file: filePath,
			determinism: "partially_deterministic",
		};
	}

	// Agent is editing implementation while tests are failing — stay focused
	if (cycle.state === "red" && cycle.impl_edits_before_test >= 2) {
		return {
			source: "structural",
			name: "tdd_cycle_violation",
			severity: "warning",
			message: `Tests for ${basename(filePath)} are RED (failing). Focus on making them green before making more changes.`,
			file: filePath,
			determinism: "partially_deterministic",
		};
	}

	return null;
}

/**
 * Detect green→red regression: tests were passing but a subsequent edit broke them.
 */
export function checkTddRegression(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	if (!TDD_SOURCE_EXT_RE.test(filePath)) return null;
	if (TEST_FILE_RE.test(filePath)) return null;
	if (isTddExemptPath(filePath)) return null;

	const cycle = session.tdd_cycles.get(filePath);
	if (!cycle) return null;

	if (cycle.state === "regression" && cycle.previous_state === "green") {
		return {
			source: "structural",
			name: "tdd_regression",
			severity: "error",
			message: `Tests for ${basename(filePath)} were GREEN but are now FAILING (regression). Your last edit broke something — fix before continuing.`,
			file: filePath,
			determinism: "partially_deterministic",
		};
	}

	return null;
}

/**
 * Positive signal: tests transitioned from red to green.
 * This is the only "good news" check — confirms the TDD cycle completed.
 */
export function checkTddGreenConfirmation(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	if (TEST_FILE_RE.test(filePath)) return null;

	const cycle = session.tdd_cycles.get(filePath);
	if (!cycle) return null;

	if (cycle.state === "green" && cycle.previous_state === "red") {
		return {
			source: "structural",
			name: "tdd_green_confirmation",
			severity: "info",
			message: `Tests passing for ${basename(filePath)}. Red→green cycle complete.`,
			file: filePath,
			determinism: "fully_deterministic",
		};
	}

	return null;
}

/**
 * Commit gate: check TDD cycle state before allowing git commit.
 * Returns warnings/errors for files with unresolved test issues.
 *
 * @param mode - "nudge" emits info, "warn" emits warnings, "enforce" emits errors (blocks)
 */
export function checkTddCommitGate(
	session: SessionTrajectory,
	mode: "nudge" | "warn" | "enforce",
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	let severity: "error" | "warning" | "info" = "info";
	if (mode === "enforce") severity = "error";
	else if (mode === "warn") severity = "warning";

	for (const [sourceFile, cycle] of session.tdd_cycles) {
		if (cycle.state === "red" || cycle.state === "regression") {
			results.push({
				source: "structural",
				name: "tdd_commit_gate",
				severity,
				message: `Tests are ${cycle.state === "regression" ? "REGRESSING" : "FAILING"} for ${basename(sourceFile)}. Fix before committing.`,
				file: sourceFile,
				determinism: "partially_deterministic",
			});
		} else if (cycle.state === "no_test" && cycle.impl_edits_before_test > 0) {
			// Disk reality check: state-machine tracking can miss a transition
			// (path mismatch, harness restart mid-session, hydration gap), but
			// if a test file actually exists on disk for this source, the
			// "no tests written" framing is wrong — tests exist, the tracker
			// just didn't see the green transition. Suppress.
			const candidateTest = cycle.test_file ?? findTestFilePath(sourceFile);
			if (candidateTest && existsSync(candidateTest)) continue;
			// Pure type-definition modules have nothing to unit-test.
			if (isTypeOnlySourceFile(sourceFile)) continue;
			// Inherit the same exemption surface the in-edit TDD checks already
			// apply at lines 153/155 + 200/202: non-source extensions (e.g. a
			// .patch / .md / .json the agent happened to Write) and exempt
			// paths (.interlinked/, dist/, node_modules/, scripts/, …). Without
			// these the commit-gate had a wider net than the in-edit checks,
			// so a transient `.interlinked/foo.patch` write fired the gate.
			if (!TDD_SOURCE_EXT_RE.test(sourceFile)) continue;
			if (isTddExemptPath(sourceFile)) continue;
			// A file that no longer exists on disk can't be tested. Covers the
			// transient-file case (agent Writes a working file, then deletes
			// it later in the same session) and renames where the cycle's
			// recorded path no longer resolves.
			if (!existsSync(sourceFile)) continue;

			results.push({
				source: "structural",
				name: "tdd_commit_gate",
				severity: severity === "error" ? "warning" : severity,
				message: `No tests written or run for ${basename(sourceFile)} (edited ${cycle.impl_edits_before_test} times). Verify changes before committing.`,
				file: sourceFile,
				determinism: "partially_deterministic",
			});
		}
	}

	return results;
}

// ---- Helper ----

function basename(filePath: string): string {
	const parts = filePath.split("/");
	return parts[parts.length - 1] || filePath;
}

/**
 * Find the test file path for a source file using common conventions.
 * Returns null if no test file exists on disk.
 */
function findTestFilePath(filePath: string): string | null {
	const ext = extname(filePath);
	if (!ext) return null;
	const base = filePath.slice(0, -ext.length);
	const dir = dirname(filePath);
	const baseName = pathBasename(filePath, ext);
	if (baseName.endsWith(".test") || baseName.endsWith(".spec")) return null;
	const candidates = [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		join(dir, "__tests__", `${baseName}.test${ext}`),
		join(dir, "__tests__", `${baseName}.spec${ext}`),
	];
	return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Best-effort: is `filePath` a pure type-definition module on disk?
 * Reads the file and delegates to {@link isTypeOnlyModule}. A missing or
 * unreadable file returns false so the caller's check still runs.
 */
function isTypeOnlySourceFile(filePath: string): boolean {
	try {
		if (!existsSync(filePath)) return false;
		return isTypeOnlyModule(filePath, readFileSync(filePath, "utf-8"));
	} catch {
		// unreadable — fall through; the caller's check still applies
		return false;
	}
}

const PROD_TEST_LOC_RATIO_LIMIT = 5;
const TPP_LEAPFROG_THRESHOLD = 2;

// "Heavy" TPP transformations — high priority in the TPP list. Introducing
// two or more in one commit without a red→green cycle suggests leapfrogging
// the priority ladder.
const HEAVY_CONSTRUCTS: Array<{ re: RegExp; name: string }> = [
	{ re: /\bwhile\s*\(/g, name: "while loop" },
	{ re: /\bfor\s*\(/g, name: "for loop" },
	{ re: /\bclass\s+[A-Z]/g, name: "class" },
	{ re: /\bswitch\s*\(/g, name: "switch" },
	{ re: /\bfunction\s*\*/g, name: "generator function" },
];

export function getStagedDiff(file: string): string {
	try {
		const r = spawnSync("git", ["-C", dirname(file), "diff", "--cached", "HEAD", "--", file], {
			encoding: "utf-8",
			timeout: 2000,
		});
		if (r.status !== 0 || !r.stdout) {
			// Fall back to unstaged diff (in case changes aren't staged yet).
			const r2 = spawnSync("git", ["-C", dirname(file), "diff", "HEAD", "--", file], {
				encoding: "utf-8",
				timeout: 2000,
			});
			if (r2.status !== 0) return "";
			return r2.stdout || "";
		}
		return r.stdout;
	} catch {
		return "";
	}
}

export function extractAddedLines(diff: string): string {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue;
		out.push(line.slice(1));
	}
	return out.join("\n");
}

/**
 * Commit gate: flag commits that introduce ≥2 heavy TPP transformations
 * (while/for/class/switch/generator) without a preceding red→green TDD cycle.
 * Per Uncle Bob's Transformation Priority Premise — disciplined TDD cycles
 * introduce the smallest possible transformation per test. Information-level
 * only; never blocking.
 */
export function checkTppLeapfrog(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	for (const file of session.files_written) {
		if (TEST_FILE_RE.test(file)) continue;
		const diff = getStagedDiff(file);
		if (!diff) continue;
		const added = extractAddedLines(diff);
		if (!added) continue;

		const constructs: string[] = [];
		for (const { re, name } of HEAVY_CONSTRUCTS) {
			const matches = added.match(re);
			if (!matches || matches.length === 0) continue;
			constructs.push(matches.length === 1 ? name : `${matches.length}× ${name}`);
		}
		if (constructs.length < TPP_LEAPFROG_THRESHOLD) continue;

		// Suppress when a disciplined red→green cycle ran for this file.
		const cycle = session.tdd_cycles.get(file);
		if (cycle && cycle.state === "green" && cycle.red_at !== undefined) continue;

		results.push({
			source: "structural",
			name: "tpp_leapfrog",
			severity: "info",
			message: `${basename(file)} adds ${constructs.join(" + ")} without a prior red→green cycle. Consider splitting into smaller transformations (Transformation Priority Premise).`,
			file,
			determinism: "heuristic",
		});
	}
	return results;
}

/**
 * Commit gate: flag production files edited this session without a matching
 * test-file edit. Fires on `git commit` detection.
 *
 * Suppression rules: a single source file may be covered by multiple test
 * files (e.g. ubs-language-specific.ts has tests in
 * __tests__/ubs-hardcoded-localhost.test.ts AND others). The "no test was
 * updated" framing is a false positive — tests WERE updated, just not under
 * the conventional name — when ANY test edited this session either
 *   (a) imports / references this source by basename, OR
 *   (b) references a symbol this source EXPORTS (barrel / differently-named
 *       coverage — the test exercises the public API without the source
 *       basename in its import path).
 */
export function checkProdDeltaWithoutTestDelta(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	const editedTestFiles = [...session.files_written].filter((f) => TEST_FILE_RE.test(f));
	for (const file of session.files_written) {
		if (TEST_FILE_RE.test(file)) continue;
		const testFile = findTestFilePath(file);
		if (!testFile || session.files_written.has(testFile)) continue;
		if (anyEditedTestReferencesSource(editedTestFiles, file)) continue;
		// Barrel / differently-named coverage: an edited test that references a
		// symbol this source EXPORTS exercises it even without the source
		// basename in an import path (pre-tool.ts ← evaluator-files.test.ts via
		// the evaluator barrel + the `evaluatePreToolUse` symbol).
		if (anyEditedTestUsesSourceExports(editedTestFiles, file)) continue;

		results.push({
			source: "structural",
			name: "prod_delta_no_test_delta",
			severity: "warning",
			message: `Edited ${basename(file)} but no corresponding test was updated (expected ${basename(testFile)}).`,
			file,
			determinism: "heuristic",
		});
	}
	return results;
}

function anyEditedTestReferencesSource(testFiles: string[], sourceFile: string): boolean {
	const ext = extname(sourceFile);
	const sourceBase = pathBasename(sourceFile, ext);
	if (!sourceBase) return false;
	// Boundary-anchored regex: matches an import / require path that contains
	// the source basename as a path segment. `./ubs-language-specific.js`
	// matches; `./other-file.js` doesn't even if "ubs" appears.
	const re = new RegExp(`["']\\.{1,2}/[^"']*\\b${escapeRe(sourceBase)}\\b[^"']*["']`);
	for (const testFile of testFiles) {
		try {
			const content = readFileSync(testFile, "utf-8");
			if (re.test(content)) return true;
		} catch {
			// intentional: best-effort read; an unreadable test file just means
			// we can't confirm it covers this source — fall through.
		}
	}
	return false;
}

/** Top-level exported symbol names of a source file (best-effort regex, no
 *  AST): `export function/const/class/let/var/type/interface/enum NAME`,
 *  `export default function NAME`, and re-export lists `export { a, b as c }`
 *  (the exported alias `c` is what a consumer references). */
function exportedSymbolsOf(sourceFile: string): string[] {
	let content: string;
	try {
		content = readFileSync(sourceFile, "utf-8");
	} catch {
		return [];
	}
	const names = new Set<string>();
	const declRe =
		/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
	for (const m of content.matchAll(declRe)) names.add(m[1]);
	const listRe = /\bexport\s*\{([^}]*)\}/g;
	for (const m of content.matchAll(listRe)) {
		for (const part of m[1].split(",")) {
			const exported = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (exported && /^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
		}
	}
	return [...names];
}

/** True when an edited test references a symbol EXPORTED by the source file —
 *  i.e. the test exercises the source's public API even though it imports it
 *  via a barrel or a differently-named path (so `anyEditedTestReferencesSource`'s
 *  import-path basename match misses it). Canonical case: `evaluator-files.test.ts`
 *  references `evaluatePreToolUse`, which `pre-tool.ts` exports and the
 *  `evaluator.ts` barrel re-exports — tests WERE updated, just not under the
 *  sibling name. Symbols shorter than 4 chars are ignored so a generic
 *  `id` / `run` export can't over-suppress on an incidental token match. */
function anyEditedTestUsesSourceExports(testFiles: string[], sourceFile: string): boolean {
	const symbols = exportedSymbolsOf(sourceFile).filter((s) => s.length >= 4);
	if (symbols.length === 0) return false;
	const re = new RegExp(`\\b(?:${symbols.map(escapeRe).join("|")})\\b`);
	for (const testFile of testFiles) {
		try {
			if (re.test(readFileSync(testFile, "utf-8"))) return true;
		} catch {
			// best-effort: an unreadable test file just can't confirm coverage.
		}
	}
	return false;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lines added + deleted, split by prod vs test path. */
export interface LocDelta {
	prodLoc: number;
	testLoc: number;
}

/**
 * Compute LOC delta covering BOTH tracked changes (`git diff --numstat HEAD`)
 * AND untracked-but-not-ignored files (counted at full line count, since
 * they're entirely new). Counts added + deleted for tracked files so a
 * 50-line refactor registers as 100 churn — that's what the ratio gate
 * cares about (proportional test coverage of touched code).
 *
 * Three-bucket classification: a path counts toward testLoc if it matches
 * the test convention, prodLoc if it's a known code-file extension, and
 * is dropped otherwise. The third bucket exists because the previous
 * bipartite split routed every non-test path into prodLoc — docs
 * (CLAUDE.md), JSON data, lockfiles, and shell-script bootstraps then
 * tripped the "wrote N lines of production code with no tests" warning
 * on doc-only sessions. `isCodeFile` is the shared positive predicate
 * used by the Stop-event verification nudges.
 *
 * The untracked path matters because `git diff` doesn't see new files
 * before they're staged, and the gate fires at PreToolUse time on
 * `git add ... && git commit ...` — before staging happens. Without
 * untracked accounting, a brand-new test file wouldn't count.
 *
 * Returns zeroes on any failure (not in a repo, no HEAD, git missing).
 */
export function gitNumstatDelta(cwd: string = process.cwd()): LocDelta {
	let prodLoc = 0;
	let testLoc = 0;
	try {
		const numstat = execSync("git diff --numstat HEAD", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const line of numstat.split("\n")) {
			const parts = line.split("\t");
			if (parts.length < 3) continue;
			const added = Number.parseInt(parts[0], 10);
			const deleted = Number.parseInt(parts[1], 10);
			if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
			const path = parts[2];
			const delta = added + deleted;
			if (TEST_FILE_RE.test(path)) testLoc += delta;
			else if (isCodeFile(path)) prodLoc += delta;
			// else: docs, JSON data, lockfiles, etc. — not "production code"
		}
		const untracked = execSync("git ls-files --others --exclude-standard", {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const path of untracked.split("\n")) {
			if (!path) continue;
			if (!TEST_FILE_RE.test(path) && !isCodeFile(path)) continue;
			try {
				const content = readFileSync(join(cwd, path), "utf-8");
				const loc = content.split("\n").length;
				if (TEST_FILE_RE.test(path)) testLoc += loc;
				else prodLoc += loc;
			} catch {
				// intentional: best-effort read; skip an unreadable untracked file.
			}
		}
	} catch {
		// intentional: git unavailable / not a repo / no HEAD — fall back to 0
	}
	return { prodLoc, testLoc };
}

/**
 * Commit gate: flag when prod LOC delta exceeds test LOC delta by more than
 * PROD_TEST_LOC_RATIO_LIMIT × — measured against `git diff HEAD`, NOT against
 * file totals. Touching a 1000-line file with a 2-line edit contributes 2 to
 * the delta, not 1000. The previous file-total approach made the gate fire
 * on any session that brushed a large file, even when the actual change was
 * small and well-tested.
 */
export function checkProdTestLocRatio(
	session: SessionTrajectory,
	getDelta: () => LocDelta = gitNumstatDelta,
): CheckResultEntry[] {
	void session; // signature kept for symmetry with other commit gates
	const { prodLoc, testLoc } = getDelta();
	if (testLoc === 0 && prodLoc === 0) return [];
	if (testLoc === 0) {
		return [
			{
				source: "structural",
				name: "prod_test_loc_ratio",
				severity: "warning",
				message: `Wrote ${prodLoc} lines of production code this session with no tests written. Add tests before committing.`,
				file: "<session>",
				determinism: "heuristic",
			},
		];
	}
	const ratio = prodLoc / testLoc;
	if (ratio > PROD_TEST_LOC_RATIO_LIMIT) {
		return [
			{
				source: "structural",
				name: "prod_test_loc_ratio",
				severity: "warning",
				message: `Prod/test LOC ratio is ${ratio.toFixed(1)}:1 (limit ${PROD_TEST_LOC_RATIO_LIMIT}:1). Production code is growing faster than test coverage.`,
				file: "<session>",
				determinism: "heuristic",
			},
		];
	}
	return [];
}

// ---- Assertion density (delta-based; called outside runBehavioralChecks) ----

// Matches plain `it(`, `test(`, `specify(` AND the chained variants vitest /
// jest expose: `.each`, `.only`, `.skip`, `.concurrent`, `.skipIf`, `.runIf`,
// `.todo`, `.failing`, `.sequential`. Also accepts the table-form
// `it.each([...])\`...\`(` so each tagged-template case counts as one block.
// Matching is on the call-site, not the chain — `.each` followed by `(...)`
// is one block; without that we'd miss every data-driven test in the repo.
const TEST_BLOCK_RE =
	/\b(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*(?:\([^)]*\)\s*)?(?:\(\s*['"`]|`+\s*\()/g;

// Default regex stays narrow on purpose — bare `ok(`, `match(`, `equal(`,
// `fail(` would false-positive on jQuery's `.match()`, lodash's `_.equal`,
// business-logic helpers, etc. Named-import awareness (below) handles
// `node:assert` cases properly without false-positives.
const ASSERTION_RE =
	/\b(?:expect|assert|chai\.assert|should|sinon\.assert|toMatchSnapshot|toMatchInlineSnapshot)\s*[(.]/g;

// Names that are unambiguous as Node:assert calls only when imported from
// `node:assert` / `assert`. Detected from the import statement, then matched
// in the body. Drops the bare-name FP risk.
const NODE_ASSERT_NAMES = [
	"strictEqual",
	"deepStrictEqual",
	"notStrictEqual",
	"notDeepStrictEqual",
	"deepEqual",
	"notEqual",
	"ifError",
	"doesNotThrow",
	"doesNotMatch",
	"throws",
	"rejects",
	"fail",
	"match",
	"ok",
	"equal",
] as const;

const NODE_ASSERT_IMPORT_RE =
	/import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"](?:node:)?assert(?:\/strict)?['"]/g;

function importedAssertNames(content: string): Set<string> {
	const out = new Set<string>();
	NODE_ASSERT_IMPORT_RE.lastIndex = 0;
	let m: RegExpExecArray | null = NODE_ASSERT_IMPORT_RE.exec(content);
	while (m !== null) {
		for (const raw of m[1].split(",")) {
			// Handle `strictEqual as eq` rename — credit the local binding.
			const local = (raw.split(/\s+as\s+/i)[1] ?? raw).trim();
			if (
				local &&
				NODE_ASSERT_NAMES.includes(local as (typeof NODE_ASSERT_NAMES)[number])
			) {
				out.add(local);
			} else if (local) {
				const src = raw.split(/\s+as\s+/i)[0]?.trim();
				if (
					src &&
					NODE_ASSERT_NAMES.includes(src as (typeof NODE_ASSERT_NAMES)[number])
				) {
					out.add(local);
				}
			}
		}
		m = NODE_ASSERT_IMPORT_RE.exec(content);
	}
	return out;
}

export function countAssertions(rawContent: string): AssertionCounts {
	// Strip comments + strings so a comment that mentions `expect(` or a
	// string containing `assert.ok(` doesn't inflate counts.
	const stripped = stripCommentsAndStrings(rawContent);

	TEST_BLOCK_RE.lastIndex = 0;
	ASSERTION_RE.lastIndex = 0;

	const blocks = (stripped.match(TEST_BLOCK_RE) || []).length;
	let assertions = (stripped.match(ASSERTION_RE) || []).length;

	// Named-import credit — only for names actually imported from node:assert.
	// Use the *raw* content for import detection (strip can mangle import
	// specifier strings); use the *stripped* content for call-site matching.
	const named = importedAssertNames(rawContent);
	if (named.size > 0) {
		const namedRe = new RegExp(`\\b(?:${[...named].join("|")})\\s*\\(`, "g");
		assertions += (stripped.match(namedRe) || []).length;
	}

	return { blocks, assertions };
}

/**
 * Detect test files where the agent added `it()`/`test()` blocks without
 * adding any assertions. Heuristic, warning-severity, session-delta-based:
 * the first sight of any test file silently establishes baseline; the check
 * fires on the *second* same-session edit when blocks grew but assertions
 * did not.
 *
 * Brand-new assertion-free test files are an accepted blind spot — see
 * `docs/plans/09-local-runtime-quality-hooks.md` (Failure modes table).
 * `tdd_new_file_gate` does NOT cover this case (it exempts test files at
 * `evaluator/tdd-new-file-gate.ts:35-48`); Plan 10 (mutation testing)
 * catches it asynchronously.
 */
export function checkAssertionDensity(
	session: SessionTrajectory,
	filePath: string,
	content: string,
): CheckResultEntry | null {
	if (!TEST_FILE_RE.test(filePath)) return null;
	if (hasTddExemptDirective(content)) return null;

	const after = countAssertions(content);
	const before = session.assertion_counts.get(filePath);

	// Always refresh the cache — every visit becomes the new baseline for
	// the *next* edit's delta.
	session.assertion_counts.set(filePath, after);

	// First time we see this file in the session: silently establish
	// baseline. Firing on `before === undefined` would false-positive on
	// every pre-existing assertion-free test the agent touches.
	if (before === undefined) return null;

	const dBlocks = after.blocks - before.blocks;
	const dAssertions = after.assertions - before.assertions;

	if (dBlocks > 0 && dAssertions <= 0) {
		const assertionPart =
			dAssertions === 0
				? "0 new assertions"
				: `${-dAssertions} fewer assertion${-dAssertions === 1 ? "" : "s"}`;
		return {
			source: "structural",
			name: "assertion_density",
			severity: "warning",
			message: `Added ${dBlocks} test block(s) with ${assertionPart}. Each it()/test() block typically needs at least one expect()/assert*() call.`,
			file: filePath,
			determinism: "heuristic",
		};
	}

	return null;
}
