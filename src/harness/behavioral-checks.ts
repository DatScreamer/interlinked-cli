// ===========================================
// Interlinked Harness — Behavioral Checks
// ===========================================
// Session-level behavioral pattern checks.
// These detect anti-patterns across a session trajectory
// (repeated edits without testing, suppression as workaround,
// domain-sensitive test nudges, persistent warning escalation).

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

const SECURITY_DOMAIN_RE =
	/\/(auth|crypto|security|oauth|jwt|password|secret|encrypt|decrypt|token|credential|session|permission|acl)\//i;

// ---- Individual checks ----

/**
 * Detect a source file edited multiple times without any test run in the session.
 * Skips test files themselves and sessions where any test has been run.
 */
export function checkRepeatedEditWithoutTest(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	const count = session.file_edit_counts.get(filePath);
	if (count === undefined || count < 3) return null;

	// Don't warn about test files — they ARE the tests.
	if (TEST_FILE_RE.test(filePath)) return null;

	// Agent has already run some tests this session — give benefit of the doubt.
	if (session.test_runs.size > 0) return null;

	return {
		source: "structural",
		name: "repeated_edit_without_test",
		severity: "warning",
		message: `File edited ${count} times without running tests. Consider running the test suite.`,
		file: filePath,
		determinism: "heuristic",
	};
}

/**
 * Detect suppression directives added right after a harness warning on the same file.
 * This catches the pattern: warning fires -> agent adds `// @ts-expect-error` or `eslint-disable`
 * instead of fixing the underlying issue.
 */
export function checkSuppressionAsWorkaround(
	session: SessionTrajectory,
	filePath: string,
	currentSuppressionCount: number,
	previousSuppressionCount: number,
): CheckResultEntry | null {
	// No new suppressions added — nothing to flag.
	if (currentSuppressionCount <= previousSuppressionCount) return null;

	// Only flag if the file had a recent harness warning (likely the motivation).
	if (!session.failed_files.has(filePath)) return null;

	const delta = currentSuppressionCount - previousSuppressionCount;
	return {
		source: "structural",
		name: "suppression_as_workaround",
		severity: "warning",
		message: `Added ${delta} suppression directive(s) after a harness warning. Fix the underlying issue instead of suppressing it.`,
		file: filePath,
		determinism: "partially_deterministic",
	};
}

/**
 * Nudge agents to run tests when editing security-sensitive code.
 * Only fires when no tests have been run in the current session.
 */
export function checkDomainSensitiveTestNudge(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	const match = SECURITY_DOMAIN_RE.exec(filePath);
	if (!match) return null;

	// Agent has already run tests — no need to nag.
	if (session.test_runs.size > 0) return null;

	const domain = match[1];
	return {
		source: "structural",
		name: "domain_sensitive_test_nudge",
		severity: "warning",
		message: `Editing security-sensitive code (${domain}). Run the auth/security test suite to verify changes.`,
		file: filePath,
		determinism: "heuristic",
	};
}

/**
 * Predicate for `checkPersistentWarningEscalation`'s diff-aware gate:
 * does any line in `findingLines` sit within `radius` of any line in
 * `editedLines`? Pulled out to keep the escalation function's main loop
 * at two-deep nesting; the predicate itself is a clean O(F × E) scan
 * with early exit on the first match.
 */
function anyFindingNearEditedLine(
	findingLines: ReadonlyArray<number>,
	editedLines: ReadonlySet<number>,
	radius: number,
): boolean {
	for (const line of findingLines) {
		if (editedLineWithinRadius(editedLines, line, radius)) return true;
	}
	return false;
}

// Matches the `L<number>:` prefix every inline-check producer writes into a
// finding's `detail` block (e.g. `  L18: export function foo(` or
// `  L18 (in scope): ...`). The single source of per-finding line numbers
// the escalation can attribute to an edit — `CheckResultEntry.line` is a
// single optional slot, but one check (magic_literal, missing_return_types,
// …) routinely reports many lines, all of which live only in `detail`.
const DETAIL_LINE_PREFIX_RE = /(?:^|\n)\s*L(\d+)\b/g;

/**
 * Parse every `L<n>:` finding line out of a check result's `detail` block.
 * Deterministic (regex over the harness's own detail format), no I/O.
 * Returns [] when `detail` is absent or carries no line prefixes (file-level
 * checks like `export_surface` that have no per-line anchor).
 */
function extractDetailLines(detail: string | undefined): number[] {
	if (!detail) return [];
	const out: number[] = [];
	DETAIL_LINE_PREFIX_RE.lastIndex = 0;
	let m: RegExpExecArray | null = DETAIL_LINE_PREFIX_RE.exec(detail);
	while (m !== null) {
		const n = Number.parseInt(m[1], 10);
		if (Number.isFinite(n)) out.push(n);
		m = DETAIL_LINE_PREFIX_RE.exec(detail);
	}
	return out;
}

function editedLineWithinRadius(
	editedLines: ReadonlySet<number>,
	target: number,
	radius: number,
): boolean {
	for (const el of editedLines) {
		if (Math.abs(el - target) <= radius) return true;
	}
	return false;
}

/**
 * Escalate warnings that persist after the agent re-edits the same file.
 * If a warning was already issued and the agent edits the file again without
 * fixing it, escalate from warning to error.
 *
 * Per-finding line attribution (refinement 2026-05, sharpened 2026-05-29) —
 * addresses the FP class where pre-existing findings (already in HEAD before
 * the session started) re-fire on every edit and the escalation amplifies the
 * noise without value. The agent is only responsible for a finding when its
 * edit actually touched the finding's line. Three gates:
 *
 *  1. **Edited-line attribution (fail-CLOSED when edit data is present)** —
 *     when `editedLines` is provided, escalate a finding only if at least one
 *     of its lines is within `±PROXIMITY_RADIUS` of a line the agent's
 *     current edit changed. Critically, this is fail-CLOSED: a finding that
 *     carries NO line evidence (file-level checks, or a finding whose lines we
 *     couldn't recover) is NOT escalated when we have edit data — we cannot
 *     prove the agent is responsible for it, and "findings on unchanged lines
 *     must not escalate" is the contract. This is the fix for the observed FP
 *     where a stable advisory on line X amplified to an error on every edit to
 *     an unrelated line. (The previous gate failed OPEN whenever a finding
 *     lacked a `line` field — and in production findings never carried one,
 *     so the gate never engaged and every pre-existing finding escalated.)
 *  2. **Once-per-record rate limit** — at most one escalation per
 *     (file, check) per session. After the first escalation fires the record
 *     is flagged; subsequent emissions of the same check on the same file
 *     don't re-escalate. Caps amplification independent of the proximity test.
 *  3. **Legacy fail-open** — only when `editedLines` is entirely absent
 *     (truly legacy callers with no edit context at all) does the gate fall
 *     back to the old issue-count-only behavior, so those callers still nag.
 *
 * Finding lines arrive two ways: an explicit `line` slot AND a `lines[]`
 * array (one check often reports many lines). Callers that pass `string[]`
 * or `{name, line}` keep working — `runBehavioralChecks` enriches the input
 * with lines parsed from each finding's `detail` block.
 */
export interface EscalationFinding {
	name: string;
	/** Single finding line (legacy single-slot callers / tests). */
	line?: number;
	/** All lines this check fired on, recovered from the `detail` block. */
	lines?: number[];
}

export function checkPersistentWarningEscalation(
	session: SessionTrajectory,
	filePath: string,
	currentResults: ReadonlyArray<string | EscalationFinding>,
	editedLines?: ReadonlySet<number>,
): CheckResultEntry[] {
	const escalated: CheckResultEntry[] = [];
	const PROXIMITY_RADIUS = 3;

	// Group current findings by check name; collect every line number per
	// check (from both the single `line` slot and the `lines[]` array).
	const linesByCheck = new Map<string, number[]>();
	for (const r of currentResults) {
		const name = typeof r === "string" ? r : r.name;
		if (!linesByCheck.has(name)) linesByCheck.set(name, []);
		const list = linesByCheck.get(name);
		if (!list || typeof r === "string") continue;
		if (typeof r.line === "number" && Number.isFinite(r.line)) list.push(r.line);
		if (Array.isArray(r.lines)) {
			for (const l of r.lines) {
				if (typeof l === "number" && Number.isFinite(l)) list.push(l);
			}
		}
	}

	const haveEditData = editedLines !== undefined && editedLines.size > 0;

	for (const [name, currentLines] of linesByCheck) {
		const key = `${filePath}::${name}`;
		const record = session.warnings_issued.get(key);
		if (!record || record.issue_count < 1) continue;
		if (record.escalation_emitted) continue;

		// Diff-aware attribution gate. When we know which lines the edit
		// touched, the agent is responsible for a finding ONLY if one of its
		// lines sits within PROXIMITY_RADIUS of an edited line. Fail closed:
		// a finding with no recoverable line (or no nearby edit) is not the
		// agent's to answer for, so we do not amplify it. The legacy fall-back
		// (escalate on issue_count alone) applies only when there is no edit
		// data at all.
		if (haveEditData) {
			if (currentLines.length === 0) continue;
			if (!anyFindingNearEditedLine(currentLines, editedLines, PROXIMITY_RADIUS)) {
				continue;
			}
		}

		escalated.push({
			source: "structural",
			name: "persistent_warning_escalation",
			severity: "error",
			message: `Warning "${name}" persists after re-edit (issued ${record.issue_count + 1} times). Fix the underlying issue.`,
			file: filePath,
			determinism: "fully_deterministic",
		});
		record.escalation_emitted = true;
	}

	return escalated;
}

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
 * Suppression rule: a single source file may be covered by multiple test
 * files (e.g. ubs-language-specific.ts has tests in
 * __tests__/ubs-hardcoded-localhost.test.ts AND others). If ANY test file
 * edited in this session imports / references this source by basename, the
 * "no test was updated" framing is a false positive — tests WERE updated,
 * just not under the conventional name.
 */
export function checkProdDeltaWithoutTestDelta(session: SessionTrajectory): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];
	const editedTestFiles = [...session.files_written].filter((f) => TEST_FILE_RE.test(f));
	for (const file of session.files_written) {
		if (TEST_FILE_RE.test(file)) continue;
		const testFile = findTestFilePath(file);
		if (!testFile || session.files_written.has(testFile)) continue;
		if (anyEditedTestReferencesSource(editedTestFiles, file)) continue;

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

// ---- Orchestrator ----

/**
 * Run all behavioral checks for a single file edit and return combined results.
 */
export function runBehavioralChecks(
	session: SessionTrajectory,
	filePath: string,
	currentCheckResults: CheckResultEntry[],
	previousSuppressionCount?: number,
	currentSuppressionCount?: number,
	editedLines?: ReadonlySet<number>,
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];

	// 1. Repeated edit without test (legacy — skipped if TDD cycles are active for this file)
	if (!session.tdd_cycles.has(filePath)) {
		const repeated = checkRepeatedEditWithoutTest(session, filePath);
		if (repeated) results.push(repeated);
	}

	// 2. Suppression as workaround
	if (previousSuppressionCount !== undefined && currentSuppressionCount !== undefined) {
		const suppression = checkSuppressionAsWorkaround(
			session,
			filePath,
			currentSuppressionCount,
			previousSuppressionCount,
		);
		if (suppression) results.push(suppression);
	}

	// 3. Domain-sensitive test nudge
	const nudge = checkDomainSensitiveTestNudge(session, filePath);
	if (nudge) results.push(nudge);

	// 4. Persistent warning escalation — pass full result objects so the
	// diff-aware attribution gate can read each finding's line numbers, plus
	// the optional editedLines set so the gate can decide whether the agent
	// had agency over each persistent finding. A single `CheckResultEntry`
	// carries at most one `line`, but most inline checks report several lines,
	// all of which live only in the `detail` block — so we recover them here.
	// Without this, the gate saw zero finding lines, failed open, and
	// amplified every stale pre-existing finding on every unrelated edit.
	const escalationInputs: EscalationFinding[] = currentCheckResults.map((r) => ({
		name: r.name,
		line: r.line,
		lines: extractDetailLines(r.detail),
	}));
	const escalations = checkPersistentWarningEscalation(
		session,
		filePath,
		escalationInputs,
		editedLines,
	);
	results.push(...escalations);

	// 5. TDD cycle checks
	const cycleViolation = checkTddCycleViolation(session, filePath);
	if (cycleViolation) results.push(cycleViolation);

	const regression = checkTddRegression(session, filePath);
	if (regression) results.push(regression);

	const greenConfirm = checkTddGreenConfirmation(session, filePath);
	if (greenConfirm) results.push(greenConfirm);

	return results;
}
