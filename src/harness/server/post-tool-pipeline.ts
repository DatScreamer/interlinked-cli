// ===========================================
// PostToolUse evaluation pipeline
// ===========================================
// The `if (isPostToolUse(event))` block extracted verbatim from
// `processEvent` in server.ts. Runs after a tool call completes: the guard
// post-evaluator, failure-recovery channels, content-scanner post-scan,
// tool-response checks, then the per-file structural / quality / suggestion /
// structure / behavioral pipeline (fanned out via `runPerFileChecks` in
// `post-tool-file-checks.ts`), and finally the per-tool latency breakdown +
// required-tool coverage + all-clean summary.
//
// Behavior-preserving move: bare module-level state (`rules`, `trigramIndex`,
// …) becomes `ctx.rules`, `ctx.trigramIndex`, ….

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getOrCreateEngine } from "../check-engine/index.js";
import { runPostToolScan } from "../content-scanner/post-scan.js";
import {
	dischargeObligationsAfterGreenRun,
	isCoverageSuiteCommand,
} from "../coverage-discharge.js";
import { evaluatePostToolUse } from "../evaluator.js";
import { runFailureChannels } from "../failure-channels.js";
import type { ToolBreakdownEntry } from "../quality-checks.js";
import { detectTestRunFile, recordTestRunCycle } from "../server-tdd-cycle.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { shouldSkipPath } from "../skip-paths.js";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
	formatBloatWarning,
	formatSilentFailureWarning,
} from "../tool-result-checks.js";
import type {
	CheckResultEntry,
	HarnessDecision,
	HarnessEvent,
	ObservedCheck,
	SessionTrajectory,
} from "../types.js";
import { classifyVerificationCommand } from "../verification-stop-checks.js";
import { type PerFileCheckCtx, runPerFileChecks } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Tool names that write a file to disk (direct dirty-layer + index update). */
const FILE_WRITE_TOOLS = [
	"Write",
	"Edit",
	"Update",
	"WriteFile",
	"EditFile",
	"write_file",
	"edit_file",
	"NotebookEdit",
];

/** Tool names treated as a direct single-file edit by the quality pipeline.
 *  Superset of {@link FILE_WRITE_TOOLS} plus the Copilot-CLI patch verbs. */
const DIRECT_FILE_EDIT_TOOLS = [
	...FILE_WRITE_TOOLS,
	// Copilot CLI
	"apply_patch",
	"str_replace",
	"create",
];

/** Tool names whose payload is a shell command that may edit files. */
const SHELL_TOOLS = ["Bash", "Shell", "shell", "run_command"];

/** Match an edited source-file path inside a Bash command (sed -i, awk >, tee,
 *  cat >, …) across the languages the pipeline knows how to check. */
const BASH_EDITED_FILE_RE =
	/\b([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|kt|kts|scala|lua|zig|nim|ex|exs|clj|cljs|ml|mli|hs|lhs|erl|hrl|dart|r|R|jl|v|sv|vhd|vhdl|pro|pl|pm|sh|bash|zsh|fish))\b/;

/** Append messages to `decision.warnings`, lazily creating the array. Mirrors
 *  the `if (!decision.warnings) decision.warnings = []` idiom that was repeated
 *  at every push site, keeping each phase helper a single branch lighter. */
function pushWarnings(decision: HarnessDecision, ...msgs: string[]): void {
	if (msgs.length === 0) return;
	if (!decision.warnings) decision.warnings = [];
	decision.warnings.push(...msgs);
}

/**
 * Daemon-side mirror of the hook's `skip-paths` chunk: when the edited path
 * matches a configured `skip_paths` glob, short-circuit the whole post-event
 * pipeline. Returns the early `allow` decision, or `null` to continue.
 */
function skipPathsShortCircuit(
	event: HarnessEvent,
	rules: ServerRuntime["rules"],
): HarnessDecision | null {
	const editedFilePathRaw =
		(event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
	if (editedFilePathRaw && shouldSkipPath(editedFilePathRaw, rules)) {
		return {
			decision: "allow",
			summary: `skip_paths matched (${editedFilePathRaw}) — post-event pipeline skipped`,
		};
	}
	return null;
}

/**
 * Dirty layer: keep the trigram index + content cache fresh for a file the
 * agent just wrote, so its own edits are immediately searchable. No-op when
 * the index isn't built, the tool isn't a write, or the path is out-of-tree.
 */
function updateTrigramDirtyLayer(ctx: ServerRuntime, event: HarnessEvent): void {
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
 */
function trackTestRun(event: HarnessEvent, session: SessionTrajectory, cwd: string): void {
	if (!session) return;
	const cmd = (event.tool_input?.command as string) || "";
	const testRunFile = detectTestRunFile(cmd, cwd);
	if (!testRunFile) return;
	const passed = event.hook_event !== "PostToolUseFailure";
	session.test_runs.set(testRunFile, {
		status: passed ? "pass" : "fail",
		at_step: session.tool_call_count,
	});
	recordTestRunCycle(session, testRunFile, passed);
}

/** Narrow a Bash command to a non-test verification-check kind
 *  (typecheck / build / lint), or null. Reuses the shared
 *  `classifyVerificationCommand` classifier and intentionally drops
 *  `test` (covered by the TDD cycle), `dev-server` / `browser` (not
 *  pass/fail signals), and `verify-suite` (its own aggregate axis, not
 *  one of the three red/green check kinds). */
function observedCheckKindFor(cmd: string): ObservedCheck["kind"] | null {
	const signal = classifyVerificationCommand(cmd);
	if (signal === "typecheck" || signal === "build" || signal === "lint") return signal;
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
function classifyObservedOutcome(event: HarnessEvent): "red" | "green" | "neither" {
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
 * Observed-check outcome tracking: when the completed tool was a non-test
 * verification command (tsc / build / lint), record whether it went red or
 * green so the Stop `unresolved-red` nudge can fire on a check that ended the
 * session red. The non-test analogue of {@link trackTestRun}. Interrupted
 * runs (and unmarked commands with no failure signal) record nothing.
 */
function trackVerificationOutcome(event: HarnessEvent, session: SessionTrajectory): void {
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
function dischargeCoverageOnGreenRun(event: HarnessEvent, cwd: string): void {
	const cmd = (event.tool_input?.command as string) || "";
	if (!cmd || !isCoverageSuiteCommand(cmd)) return;
	if (classifyObservedOutcome(event) !== "green") return;
	dischargeObligationsAfterGreenRun(
		cwd,
		event.session_id,
		event.timestamp || new Date().toISOString(),
	);
}

/**
 * Phase 1 Failure-Recovery Channels (1, 2, 3, 5, 6). Gated on the canonical
 * `tool_outcome === "error"`. Fails open: a channel-orchestrator crash must
 * not abort the PostToolUse response — it just goes silent for this event.
 */
function appendFailureChannelWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
): void {
	if (event.tool_outcome !== "error") return;
	try {
		const channelsOutput = runFailureChannels({ event, session, cwd: ctx.cwd });
		if (channelsOutput && channelsOutput.warnings.length > 0) {
			pushWarnings(postDecision, ...channelsOutput.warnings);
		}
	} catch (e) {
		ctx.log(`Failure-recovery channels error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Content Scanner: scan Read/Grep results and ratchet `session.sensitivity_level`
 * on PII. Never blocks (we're already past the read) but raises sensitivity so
 * downstream PreToolUse taint rules fire. No-op when the scanner is disabled.
 */
async function appendContentScanWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
): Promise<void> {
	if (!ctx.contentScanner || !ctx.rules.content_scanner?.enabled) return;
	const postScanResult = await runPostToolScan({
		event,
		session,
		rules: ctx.rules,
		scanner: ctx.contentScanner,
		compiledAllowlist: ctx.compiledAllowlist,
	});
	if (postScanResult.warnings.length > 0) {
		pushWarnings(postDecision, ...postScanResult.warnings);
	}
}

/**
 * Tool-response checks (run for ALL PostToolUse events, not just file edits):
 * silent-failure lint, context-bloat warning, and consecutive-error feedback.
 * Each is recorded once per tool on the session. Appends to `checksRan`.
 */
function appendToolResponseChecks(
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
	checksRan: string[],
): void {
	if (!session || !event.tool_name) return;
	const toolName = event.tool_name;

	// Silent-failure lint: tool returned 200/success but body signals error.
	if (!session.silent_failure_warned.has(toolName)) {
		const silentHit = checkSilentFailure(event.tool_response);
		if (silentHit) {
			pushWarnings(postDecision, formatSilentFailureWarning(toolName, silentHit));
			session.silent_failure_warned.add(toolName);
			checksRan.push("silent-failure");
		}
	}

	// Context-bloat warning: tool_response exceeds ~8K-token budget.
	if (!session.bloat_warned.has(toolName)) {
		const bloatHit = checkContextBloat(event.tool_response);
		if (bloatHit) {
			pushWarnings(postDecision, formatBloatWarning(toolName, bloatHit));
			session.bloat_warned.add(toolName);
			checksRan.push("context-bloat");
		}
	}

	// Consecutive-error feedback: 3+ same-tool failures in a row. Counter is
	// maintained in session-state.ts (increment on failure, reset on success).
	const failureCount = session.consecutive_tool_failures.get(toolName) || 0;
	const consecutiveMsg = consecutiveFailureWarning(failureCount, toolName);
	if (consecutiveMsg) {
		pushWarnings(postDecision, consecutiveMsg);
		checksRan.push("consecutive-errors");
	}
}

/** The set of files a PostToolUse should fan its quality pipeline across,
 *  plus whether the triggering tool was a direct file edit and whether any
 *  checks should run at all. */
interface EditedPathResolution {
	/** First/primary edited file (back-compat single-path value). */
	readonly editedFilePath: string;
	/** Full fan-out set — Codex `apply_patch` can carry multiple file sections. */
	readonly editedFilePaths: string[];
	readonly isDirectFileEdit: boolean;
	readonly shouldRunChecks: boolean;
}

/**
 * Resolve which file(s) this PostToolUse edited. Direct edits use the tool's
 * declared paths (Codex `apply_patch` may carry several); Bash/shell commands
 * are scanned for an edited source path so sed/awk/tee edits still get checked.
 */
function resolveEditedPaths(event: HarnessEvent): EditedPathResolution {
	const isDirectFileEdit = Boolean(
		event.tool_name && DIRECT_FILE_EDIT_TOOLS.includes(event.tool_name),
	);

	let editedFilePath = "";
	let editedFilePaths: string[] = [];
	if (!isDirectFileEdit && event.tool_name && SHELL_TOOLS.includes(event.tool_name)) {
		const cmd = (event.tool_input?.command as string) || "";
		const editedFileMatch = cmd.match(BASH_EDITED_FILE_RE);
		if (editedFileMatch) {
			editedFilePath = editedFileMatch[1];
			editedFilePaths = [editedFilePath];
		}
	} else if (isDirectFileEdit) {
		editedFilePaths = extractAllEditedFilePaths(event);
		editedFilePath = editedFilePaths[0] || "";
	}

	const shouldRunChecks =
		isDirectFileEdit || editedFilePath.length > 0 || editedFilePaths.length > 0;
	return { editedFilePath, editedFilePaths, isDirectFileEdit, shouldRunChecks };
}

/**
 * Run the per-file quality / structural / TDD / suggestion pipeline for every
 * edited file, bracketed by the on-disk in-progress marker that PreToolUse
 * polls. Codex `apply_patch` can carry multiple file sections, so the fan-out
 * iterates; a single-file event collapses to one iteration. All accumulated
 * warnings are persisted to `pending-quality-warnings.json` and the marker is
 * removed (even on a write failure) so PreToolUse never blocks forever.
 */
async function runFileChecksWithMarker(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
	editedFilePath: string,
	editedFilePaths: string[],
	acc: PerFileCheckCtx,
): Promise<void> {
	const dataDir = join(ctx.cwd, ".interlinked");
	const markerPath = join(dataDir, "quality-check-in-progress");
	const pendingPath = join(dataDir, "pending-quality-warnings.json");

	// Write marker BEFORE running checks so PreToolUse knows to wait.
	try {
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
		writeFileSync(markerPath, new Date().toISOString());
	} catch (markerErr) {
		ctx.log(
			`Failed to write quality-check marker (non-fatal): ${markerErr instanceof Error ? markerErr.message : String(markerErr)}`,
		);
	}

	// Per-file fan-out: for non-multi events `editedFilePaths` collapses to a
	// single-element list; the empty-string fallback keeps a check pass running
	// even when no concrete path was resolved (direct-edit with no paths).
	const pathsToCheck =
		editedFilePaths.length > 0
			? editedFilePaths
			: editedFilePath.length > 0
				? [editedFilePath]
				: [""];
	// Phase mark — everything before this point was tool-response checks
	// (silent-failure, context-bloat) plus paths-to-check setup.
	acc.markPhase("tool_response_checks");
	for (const currentEditedPath of pathsToCheck) {
		await runPerFileChecks(ctx, event, session, currentEditedPath, postDecision, acc);
	}
	// Phase mark — covers behavioral-checks + the recurrence log appender.
	acc.markPhase("recurrence_aggregate");

	// Write all accumulated warnings and remove marker.
	try {
		const allWarnings = postDecision.warnings || [];
		if (allWarnings.length > 0) {
			writeFileSync(pendingPath, JSON.stringify(allWarnings));
		}
		// Remove marker — signals PreToolUse that checks are done.
		unlinkSync(markerPath);
	} catch (err) {
		try {
			unlinkSync(markerPath);
		} catch (e) {
			void e;
		}
		ctx.log(`Quality check file error: ${err}`);
	}
}

/** Attach the structured check results, run-list, per-tool latency breakdown,
 *  and per-phase wall-clock breakdown accumulated during the per-file fan-out.
 *  Each field is omitted (not set to empty) when nothing accumulated. */
function attachTailResults(
	postDecision: HarnessDecision,
	allCheckResults: CheckResultEntry[],
	checksRan: string[],
	postToolMetrics: ToolBreakdownEntry[],
	phaseBreakdown: Record<string, number>,
	elapsedMs: number,
): void {
	if (allCheckResults.length > 0) {
		postDecision.check_results = allCheckResults;
	}
	if (checksRan.length > 0) {
		postDecision.checks_ran = [...new Set(checksRan)];
		postDecision.checks_timing_ms = elapsedMs;
	}
	if (postToolMetrics.length > 0) {
		postDecision.tool_breakdown = postToolMetrics;
	}
	postDecision.phase_breakdown = phaseBreakdown;
}

/** Required-tool coverage: warn once per session for each configured required
 *  tool that isn't available, recording the acknowledgement so it fires once. */
function appendRequiredToolWarnings(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
): void {
	if (!ctx.rules.required_tools?.length || !session) return;
	const engine = getOrCreateEngine(ctx.cwd);
	for (const reqId of ctx.rules.required_tools) {
		const skipKey = `required-tool-missing::${reqId}`;
		if (session.acknowledged_checks.has(skipKey)) continue;
		if (!engine.isToolAvailable(reqId)) {
			pushWarnings(
				postDecision,
				`[interlinked:required-tool] Required tool "${reqId}" is not available. Install it or remove from required_tools in guard-rules.json.`,
			);
			session.acknowledged_checks.add(skipKey);
		}
	}
}

/** Abbreviate a check-family id for the compact all-clean summary line. */
function abbreviateCheckName(c: string): string {
	if (c === "structural") return "structural";
	if (c === "typescript") return "tsc";
	if (c === "biome_lint") return "biome";
	if (c === "secrets_in_source") return "secrets";
	if (c === "affected_tests") return "tests";
	return c.replace(/_/g, "-");
}

/**
 * Emit a positive summary line when all checks passed (no warnings) and at
 * least one check actually ran. Uses the separate `summary` field so the hook
 * surfaces it as non-blocking output rather than a fake "block".
 */
function emitAllCleanSummary(
	postDecision: HarnessDecision,
	rules: ServerRuntime["rules"],
	checksRan: string[],
	elapsedMs: number,
): void {
	const allWarnings = postDecision.warnings || [];
	if (allWarnings.length !== 0 || checksRan.length === 0) return;
	const ruleCount = rules.rules.length;
	const checkSummary = [...new Set(checksRan)].map(abbreviateCheckName).join(", ");
	postDecision.summary = `[interlinked] ✓ ${ruleCount} guard rules, ${checkSummary} — all clean (${elapsedMs}ms)`;
}

/**
 * Run the full PostToolUse pipeline for a completed tool-use event. Returns
 * the final `HarnessDecision` (allow / block, plus warnings / summary /
 * check_results / timing).
 */
export async function runPostToolPipeline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { rules } = ctx;
	const CWD = ctx.cwd;
	// --- Phase B.2: skip_paths short-circuit ---
	// The hook reads `.interlinked/config.json#skip_paths` and exits early on
	// excluded paths, but on installs that rely on DEFAULT_CONFIG (no shared
	// file written) the hook's list is empty and the event still reaches the
	// daemon. Consult the merged `rules.skip_paths` here so the configured
	// globs short-circuit regardless of install path.
	const skip = skipPathsShortCircuit(event, rules);
	if (skip) return skip;

	// --- Dirty layer: track file edits for trigram index freshness ---
	updateTrigramDirtyLayer(ctx, event);

	// --- Test run tracking: detect test runner commands and record pass/fail ---
	trackTestRun(event, session, CWD);

	// --- Observed-check outcome tracking: tsc/build/lint red/green for the
	// Stop unresolved-red nudge (non-test analogue of trackTestRun). ---
	trackVerificationOutcome(event, session);

	// --- Deferred-coverage discharge: a coverage-suite run observed GREEN
	// discharges the session's open obligations its fresh report measured —
	// the relief path the Stop nudge promises (finding 2026-06: only the
	// commit gate ever recorded discharges, so following the nudge's "run the
	// suite + coverage" instruction changed nothing). ---
	dischargeCoverageOnGreenRun(event, CWD);

	const postDecision = evaluatePostToolUse(event, rules, session, ctx.reservations, ctx.cohort);

	// --- Phase 1 Failure-Recovery Channels (Channels 1, 2, 3, 5, 6) ---
	// Both delivery shapes converge in the helper — folded failures
	// (Claude/Codex/Gemini/Copilot deliver tool failures on the regular
	// PostToolUse / AfterTool / postToolUse) and the dedicated
	// PostToolUseFailure (Cursor's postToolUseFailure event) — because the
	// per-provider normalizers populate `tool_outcome` consistently. Output
	// flows into postDecision.warnings, surfaced by the .mjs per existing wiring.
	appendFailureChannelWarnings(ctx, event, session, postDecision);

	// --- Content Scanner: scan Read/Grep results, ratchet session sensitivity on PII ---
	await appendContentScanWarnings(ctx, event, session, postDecision);

	const postStartMs = Date.now();
	const checksRan: string[] = [];
	const allCheckResults: CheckResultEntry[] = [];
	// Phase A.7: per-subprocess-tool breakdown — quality-checks pushes one
	// entry per `engine.runChecksAsync` invocation (one per tool). The
	// daemon forwards this into latency.jsonl so the latency CLI can show
	// per-tool p50/p99.
	const postToolMetrics: ToolBreakdownEntry[] = [];

	// Per-phase wall-clock breakdown. Lets us see which phase of the
	// PostToolUse handler is responsible for the residual ms not
	// attributed to a subprocess tool. `markPhase(name)` records the
	// delta from the previous mark; the closing `closePhase()` captures
	// anything between the last mark and end-of-handler.
	const phaseBreakdown: Record<string, number> = {};
	let phaseCursor = postStartMs;
	const markPhase = (name: string): void => {
		const now = Date.now();
		phaseBreakdown[name] = (phaseBreakdown[name] ?? 0) + (now - phaseCursor);
		phaseCursor = now;
	};

	// --- Tool-response checks (run for ALL PostToolUse events, not just file edits) ---
	// These inspect tool_response payloads, so they apply equally to MCP tools,
	// Bash JSON output, and any other tool that returns structured data.
	// (Phase mark for diagnostic instrumentation — captures time spent in
	// the bookkeeping between handler entry and tool-response checks.)
	markPhase("pre_tool_response");
	appendToolResponseChecks(event, session, postDecision, checksRan);

	// Run quality checks (synchronous, with timeouts per check). Resolve which
	// file(s) this event edited (direct edit declared paths, or a path scanned
	// out of a Bash command) and whether any checks should run at all.
	const { editedFilePath, editedFilePaths, shouldRunChecks } = resolveEditedPaths(event);
	if (shouldRunChecks) {
		// The accumulator carries every cross-iteration / cross-phase value:
		// the once-per-event project-wide-sweep guard, the recurrence cursor,
		// the structured-result and checks-ran lists, the tool-latency
		// breakdown, and the `markPhase` recorder. `runPerFileChecks` mutates
		// it (and `postDecision`) in place per file.
		const acc: PerFileCheckCtx = {
			postStartMs,
			allCheckResults,
			checksRan,
			postToolMetrics,
			markPhase,
			projectWideSweepFired: false,
			recurrenceCursor: 0,
		};
		await runFileChecksWithMarker(
			ctx,
			event,
			session,
			postDecision,
			editedFilePath,
			editedFilePaths,
			acc,
		);
	}

	// Phase mark — covers the final warnings-marker write +
	// any tail bookkeeping outside the inner block.
	markPhase("session_persist");

	// Attach structured check results and timing to the decision.
	const elapsedMs = Date.now() - postStartMs;
	attachTailResults(postDecision, allCheckResults, checksRan, postToolMetrics, phaseBreakdown, elapsedMs);

	// Required-tool coverage: warn once per session if required tools are missing.
	appendRequiredToolWarnings(ctx, session, postDecision);

	// Emit a positive summary line when all checks pass (the detailed warnings
	// carry the signal otherwise).
	emitAllCleanSummary(postDecision, rules, checksRan, elapsedMs);

	return postDecision;
}
