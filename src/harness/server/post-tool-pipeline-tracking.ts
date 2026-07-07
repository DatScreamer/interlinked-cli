// interlinked-tdd: exempt
// ===========================================
// PostToolUse pipeline — tracking & classification helpers
// ===========================================
// Leaf helpers split verbatim out of `post-tool-pipeline.ts` to keep the
// orchestrator under the per-file line cap. Covers: the trigram dirty-layer
// update, test-run tracking, the observed-check (tsc/build/lint) red/green
// classifier + tracker, and deferred-coverage discharge on a green run. No
// module-private state — each depends only on its arguments + imports.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	dischargeObligationsAfterGreenRun,
	isCoverageSuiteCommand,
} from "../coverage-discharge.js";
import {
	ALL_TESTS_SENTINEL,
	detectTestRunFile,
	recordTestRunCycle,
} from "../server-tdd-cycle.js";
import type {
	HarnessDecision,
	HarnessEvent,
	ObservedCheck,
	SessionTrajectory,
} from "../types.js";
import { classifyVerificationCommand } from "../verification-stop-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Tool names that write a file to disk (direct dirty-layer + index update). */
export const FILE_WRITE_TOOLS = [
	"Write",
	"Edit",
	"Update",
	"WriteFile",
	"EditFile",
	"write_file",
	"edit_file",
	"NotebookEdit",
];

/** Append messages to `decision.warnings`, lazily creating the array. Mirrors
 *  the `if (!decision.warnings) decision.warnings = []` idiom that was repeated
 *  at every push site, keeping each phase helper a single branch lighter. */
export function pushWarnings(decision: HarnessDecision, ...msgs: string[]): void {
	if (msgs.length === 0) return;
	if (!decision.warnings) decision.warnings = [];
	decision.warnings.push(...msgs);
}

/**
 * Dirty layer: keep the trigram index + content cache fresh for a file the
 * agent just wrote, so its own edits are immediately searchable. No-op when
 * the index isn't built, the tool isn't a write, or the path is out-of-tree.
 */
export function updateTrigramDirtyLayer(ctx: ServerRuntime, event: HarnessEvent): void {
	if (!ctx.trigramIndex) return;
	const editedPath = (event.tool_input?.file_path as string) || "";
	const toolName = event.tool_name || "";
	if (!FILE_WRITE_TOOLS.includes(toolName) || !editedPath) return;
	try {
		const absPath = editedPath.startsWith("/") ? editedPath : join(ctx.cwd, editedPath);
		const relPath = relative(ctx.cwd, absPath);
		if (existsSync(absPath) && !relPath.startsWith("..")) {
			const content = readFileSync(absPath, "utf-8");
			ctx.trigramIndex.updateFile(relPath, content);
			ctx.fileContentCache.set(relPath, content);
			ctx.log(`Trigram index dirty update: ${relPath}`);
		}
	} catch (e) {
		void e;
	}
}

/**
 * Test-run tracking: when the tool was a test-runner command, record pass/fail
 * for the detected test file on the session and advance the TDD cycle state.
 *
 * Pass/fail uses the shared tool_outcome-first classifier
 * ({@link classifyObservedOutcome}) — the old `hook_event !==
 * "PostToolUseFailure"` rule mis-counted a folded `tool_outcome === "error"`
 * on a regular PostToolUse as PASSED (the documented latent bug the
 * observed-check tracker was written to avoid). A "neither" outcome
 * (interrupted run, or no outcome/failure marker at all) records nothing:
 * an unproven run must not flip a cycle green OR red.
 */
export function trackTestRun(event: HarnessEvent, session: SessionTrajectory, cwd: string): void {
	if (!session) return;
	const cmd = (event.tool_input?.command as string) || "";
	const testRunFile = detectTestRunFile(cmd, cwd);
	if (!testRunFile) return;
	const outcome = classifyObservedOutcome(event);
	if (outcome === "neither") return;
	const passed = outcome === "green";
	session.test_runs.set(testRunFile, {
		status: passed ? "pass" : "fail",
		at_step: session.tool_call_count,
	});
	recordTestRunCycle(session, testRunFile, passed);
}

/** A per-file test-FILE argument for a runner `detectTestRunFile` doesn't
 *  parse: a token shaped like a test/spec source file — a `.test.` / `.spec.` /
 *  `_test.` / `_spec.` marker inside a dotted filename (`foo.test.ts`,
 *  `spec/user_spec.rb`, `bar_test.ts`). The token can't span an `=`, so flag
 *  VALUES (`--reporter-options file=out.test.xml`) and bare option words
 *  (`--reporter spec`) never match, and the trailing `.ext` keeps a bare
 *  directory (`mocha test/`) or grep pattern from matching. Mirrors the
 *  `.test`/`.spec` filename shape `detectTestRunFile` keys on for vitest/jest,
 *  extended with `_spec`/`_test` for rspec / bun / deno. */
const PER_FILE_TEST_ARG_RE = /(?:^|\s)[^\s=]*[._](?:test|spec)\.[A-Za-z0-9]+/;

/** A test command that ran the WHOLE suite (no specific test file targeted).
 *  For a command `classifyVerificationCommand` already called a test run,
 *  `detectTestRunFile` returns one of three things:
 *   - a resolved file path → per-file (NOT whole suite).
 *   - `ALL_TESTS_SENTINEL` → a runner it parses run with no file (bare
 *     `vitest run`, `npm test`) → whole suite.
 *   - null → a runner it doesn't parse (`mocha`, `bun test`, `ava`,
 *     `deno test`, `tap`, `rspec`). Here a bare whole-suite run and an
 *     explicit per-file run are indistinguishable to `detectTestRunFile`
 *     (both null), so scan the command directly for a per-file test-file
 *     argument — matching how vitest/jest per-file runs are already detected
 *     there. Without this a per-file run of those runners was misread as
 *     whole-suite, so a per-file green could clear (or a per-file red
 *     spuriously set) the whole-suite red axis.
 *  The cwd only absolutizes a *matched* path, so any value works here. */
function isWholeSuiteTestCommand(cmd: string): boolean {
	const target = detectTestRunFile(cmd, "/");
	if (target === ALL_TESTS_SENTINEL) return true;
	if (target !== null) return false; // a resolved per-file path
	// Runner `detectTestRunFile` doesn't parse: whole-suite unless the command
	// carries an explicit per-file test argument.
	return !PER_FILE_TEST_ARG_RE.test(cmd);
}

/** Narrow a Bash command to an observed verification-check kind
 *  (typecheck / build / lint / test-suite), or null. Reuses the shared
 *  `classifyVerificationCommand` classifier. A `test` signal maps to
 *  `test-suite` ONLY for whole-suite runs — per-file test runs are
 *  intentionally dropped (the TDD cycle owns per-file red/green, and
 *  double-tracking would double-report the same red at Stop).
 *  `dev-server` / `browser` (not pass/fail signals) and `verify-suite`
 *  (its own aggregate axis) stay dropped. */
function observedCheckKindFor(cmd: string): ObservedCheck["kind"] | null {
	const signal = classifyVerificationCommand(cmd);
	if (signal === "typecheck" || signal === "build" || signal === "lint") return signal;
	if (signal === "test" && isWholeSuiteTestCommand(cmd)) return "test-suite";
	return null;
}

/** Classify a completed PostToolUse outcome into red / green / neither for
 *  the observed-check tracker.
 *
 *  tool_outcome-FIRST (deliberately NOT trackTestRun's
 *  `passed = hook_event !== "PostToolUseFailure"`, which mis-counts a folded
 *  `tool_outcome === "error"` on a regular PostToolUse as passed):
 *   - `interrupted`            → "neither" (a cancelled run proves nothing).
 *   - `success`                → "green".
 *   - `error` / PostToolUseFailure → "red".
 *   - outcome absent (undefined) → conservative body scan: red ONLY on a
 *     definitive failure marker (nonzero exit_code or non-empty
 *     error_message); otherwise "neither". Never flips green from a body
 *     scan — absence of an error marker is not proof of success. */
export function classifyObservedOutcome(event: HarnessEvent): "red" | "green" | "neither" {
	if (event.tool_outcome === "interrupted") return "neither";
	if (event.tool_outcome === "success") return "green";
	if (event.tool_outcome === "error" || event.hook_event === "PostToolUseFailure") return "red";
	// tool_outcome undefined and not a dedicated failure event — body-scan
	// fallback, applied only because tool_outcome !== "success" here.
	const exitFailed = typeof event.exit_code === "number" && event.exit_code !== 0;
	const errMsg = typeof event.error_message === "string" && event.error_message.trim().length > 0;
	return exitFailed || errMsg ? "red" : "neither";
}

/** Apply a red/green outcome to one observed-check entry (last-status-wins).
 *  Green clears a prior red; a later red after a green re-reds it. Optional
 *  `*_at` / `detail` fields are set only when present (exactOptionalPropertyTypes). */
function applyObservedOutcome(
	session: SessionTrajectory,
	kind: ObservedCheck["kind"],
	outcome: "red" | "green",
	step: number,
	detail: string,
): void {
	if (!session.observed_checks) session.observed_checks = new Map();
	const prev = session.observed_checks.get(kind);
	const entry: ObservedCheck = { kind, status: outcome };
	if (outcome === "red") {
		entry.red_at = step;
		if (prev?.green_at !== undefined) entry.green_at = prev.green_at;
	} else {
		entry.green_at = step;
		if (prev?.red_at !== undefined) entry.red_at = prev.red_at;
	}
	if (detail) entry.detail = detail;
	session.observed_checks.set(kind, entry);
}

/**
 * Observed-check outcome tracking: when the completed tool was a
 * verification command (tsc / build / lint, or a WHOLE-suite test run —
 * `vitest run` / `npm test` with no file argument), record whether it went
 * red or green so the Stop `unresolved-red` nudge can fire on a check that
 * ended the session red. The check-level analogue of {@link trackTestRun}
 * (which owns per-file test runs via the TDD cycle). Interrupted runs (and
 * unmarked commands with no failure signal) record nothing.
 */
export function trackVerificationOutcome(event: HarnessEvent, session: SessionTrajectory): void {
	if (!session) return;
	const cmd = (event.tool_input?.command as string) || "";
	if (!cmd) return;
	const kind = observedCheckKindFor(cmd);
	if (!kind) return;
	const outcome = classifyObservedOutcome(event);
	if (outcome === "neither") return;
	const detail = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
	applyObservedOutcome(session, kind, outcome, session.tool_call_count, detail);
}

/**
 * Deferred-coverage discharge on an observed GREEN coverage-suite run — the
 * relief path the Stop deferred-coverage nudge promises (finding 2026-06: only
 * the commit gate recorded discharges, so "run the suite + coverage" changed
 * nothing). Green-ness uses the same tool_outcome-first classifier as the
 * observed-check tracker; which obligations actually discharge is decided in
 * `coverage-discharge.ts` (the file must be MEASURED by a report at least as
 * fresh as the deferral). Total: a bookkeeping failure never aborts the pipeline.
 */
export function dischargeCoverageOnGreenRun(event: HarnessEvent, cwd: string): void {
	const cmd = (event.tool_input?.command as string) || "";
	if (!cmd || !isCoverageSuiteCommand(cmd)) return;
	if (classifyObservedOutcome(event) !== "green") return;
	dischargeObligationsAfterGreenRun(
		cwd,
		event.session_id,
		event.timestamp || new Date().toISOString(),
	);
}
