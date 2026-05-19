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
import type { CheckResultEntry, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { type PerFileCheckCtx, runPerFileChecks } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

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
	const log = ctx.log;
	// --- Phase B.2: skip_paths short-circuit ---
	// Daemon-side mirror of the hook-side `skip-paths` chunk. The hook
	// reads `.interlinked/config.json#skip_paths` and exits early on
	// excluded paths, but on installs that rely on DEFAULT_CONFIG (no
	// shared file written) the hook's list is empty and the event still
	// reaches the daemon. Without this check the daemon then runs the
	// full structural / quality pipeline on `dist/**`, `node_modules/**`,
	// generated files, etc. Consult the merged `rules.skip_paths` here so
	// the configured globs short-circuit regardless of install path.
	const editedFilePathRaw =
		(event.tool_input?.file_path as string) ||
		(event.tool_input?.path as string) ||
		"";
	if (editedFilePathRaw && shouldSkipPath(editedFilePathRaw, rules)) {
		return {
			decision: "allow",
			summary: `skip_paths matched (${editedFilePathRaw}) — post-event pipeline skipped`,
		};
	}

	// --- Dirty layer: track file edits for trigram index freshness ---
	if (ctx.trigramIndex) {
		const editedPath = (event.tool_input?.file_path as string) || "";
		const toolName = event.tool_name || "";
		const isFileWrite = [
			"Write",
			"Edit",
			"Update",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
			"NotebookEdit",
		].includes(toolName);

		if (isFileWrite && editedPath) {
			try {
				const absPath = editedPath.startsWith("/") ? editedPath : join(CWD, editedPath);
				const relPath = relative(CWD, absPath);
				if (existsSync(absPath) && !relPath.startsWith("..")) {
					const content = readFileSync(absPath, "utf-8");
					ctx.trigramIndex.updateFile(relPath, content);
					ctx.fileContentCache.set(relPath, content);
					log(`Trigram index dirty update: ${relPath}`);
				}
			} catch (e) {
				void e;
			}
		}
	}

	// --- Test run tracking: detect test runner commands and record pass/fail ---
	if (session) {
		const cmd = (event.tool_input?.command as string) || "";
		const testRunFile = detectTestRunFile(cmd, CWD);
		if (testRunFile) {
			const passed = event.hook_event !== "PostToolUseFailure";
			session.test_runs.set(testRunFile, {
				status: passed ? "pass" : "fail",
				at_step: session.tool_call_count,
			});
			// Update TDD cycle state from test result
			recordTestRunCycle(session, testRunFile, passed);
		}
	}

	const postDecision = evaluatePostToolUse(event, rules, session, ctx.reservations, ctx.cohort);

	// --- Phase 1 Failure-Recovery Channels (Channels 1, 2, 3, 5, 6) ---
	// Gated on the canonical `tool_outcome === "error"` from the wire-format
	// extension. Both delivery shapes converge here — folded failures
	// (Claude/Codex/Gemini/Copilot deliver tool failures on the regular
	// PostToolUse / AfterTool / postToolUse) and the dedicated
	// PostToolUseFailure (Cursor's postToolUseFailure event) — because
	// the per-provider normalizers in event-normalizers.ts populate
	// tool_outcome consistently. Output flows into postDecision.warnings,
	// which the .mjs surfaces via formatProviderResponse's reason/summary
	// channels per existing wiring.
	if (event.tool_outcome === "error") {
		try {
			const channelsOutput = runFailureChannels({ event, session, cwd: CWD });
			if (channelsOutput && channelsOutput.warnings.length > 0) {
				if (!postDecision.warnings) postDecision.warnings = [];
				postDecision.warnings.push(...channelsOutput.warnings);
			}
		} catch (e) {
			// Fail-open: a channel-orchestrator crash must not abort the
			// PostToolUse hook response. The local quality pipeline above
			// stays authoritative; the recovery channel just becomes
			// silent for this event.
			log(`Failure-recovery channels error: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// --- Content Scanner: scan Read/Grep results, ratchet session sensitivity on PII ---
	// Never blocks (we're already past the read), but raises `session.sensitivity_level`
	// so downstream PreToolUse taint rules (no network after taint, etc.) fire.
	if (ctx.contentScanner && rules.content_scanner?.enabled) {
		const postScanResult = await runPostToolScan({
			event,
			session,
			rules,
			scanner: ctx.contentScanner,
			compiledAllowlist: ctx.compiledAllowlist,
		});
		if (postScanResult.warnings.length > 0) {
			if (!postDecision.warnings) postDecision.warnings = [];
			postDecision.warnings.push(...postScanResult.warnings);
		}
	}

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
	if (session && event.tool_name) {
		const toolName = event.tool_name;

		// Silent-failure lint: tool returned 200/success but body signals error.
		if (!session.silent_failure_warned.has(toolName)) {
			const silentHit = checkSilentFailure(event.tool_response);
			if (silentHit) {
				if (!postDecision.warnings) postDecision.warnings = [];
				postDecision.warnings.push(formatSilentFailureWarning(toolName, silentHit));
				session.silent_failure_warned.add(toolName);
				checksRan.push("silent-failure");
			}
		}

		// Context-bloat warning: tool_response exceeds ~8K-token budget.
		if (!session.bloat_warned.has(toolName)) {
			const bloatHit = checkContextBloat(event.tool_response);
			if (bloatHit) {
				if (!postDecision.warnings) postDecision.warnings = [];
				postDecision.warnings.push(formatBloatWarning(toolName, bloatHit));
				session.bloat_warned.add(toolName);
				checksRan.push("context-bloat");
			}
		}

		// Consecutive-error feedback: 3+ same-tool failures in a row.
		// Counter is maintained in session-state.ts (increment on failure, reset on success).
		const failureCount = session.consecutive_tool_failures.get(toolName) || 0;
		const consecutiveMsg = consecutiveFailureWarning(failureCount, toolName);
		if (consecutiveMsg) {
			if (!postDecision.warnings) postDecision.warnings = [];
			postDecision.warnings.push(consecutiveMsg);
			checksRan.push("consecutive-errors");
		}
	}

	// Run quality checks (synchronous, with timeouts per check)
	const isDirectFileEdit =
		event.tool_name &&
		[
			"Write",
			"Edit",
			"Update",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
			"NotebookEdit",
			// Copilot CLI
			"apply_patch",
			"str_replace",
			"create",
		].includes(event.tool_name);

	// Also detect Bash commands that edit files (sed, awk, tee, etc.)
	// For these, try to extract the target file path from the command.
	let editedFilePath = "";
	// `editedFilePaths` is the full set of files this PostToolUse should
	// fan out across. Codex `apply_patch` payloads can carry multiple
	// `*** Update File:` / `Add File:` / `Delete File:` sections in one
	// call; without iterating, only the first file gets TDD/quality/
	// structural checks and the rest of the patch silently bypasses them.
	let editedFilePaths: string[] = [];
	if (
		!isDirectFileEdit &&
		event.tool_name &&
		["Bash", "Shell", "shell", "run_command"].includes(event.tool_name)
	) {
		const cmd = (event.tool_input?.command as string) || "";
		// Match edited file paths in Bash commands (sed -i, awk >, tee, cat >, etc.)
		// Supports: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyi, .rs, .go, .java,
		//           .c, .cpp, .cc, .cxx, .h, .hpp, .hxx
		const editedFileMatch = cmd.match(
			/\b([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|kt|kts|scala|lua|zig|nim|ex|exs|clj|cljs|ml|mli|hs|lhs|erl|hrl|dart|r|R|jl|v|sv|vhd|vhdl|pro|pl|pm|sh|bash|zsh|fish))\b/,
		);
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
	if (shouldRunChecks) {
		const dataDir = join(CWD, ".interlinked");
		const markerPath = join(dataDir, "quality-check-in-progress");
		const pendingPath = join(dataDir, "pending-quality-warnings.json");

		// Write marker BEFORE running checks so PreToolUse knows to wait.
		try {
			if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
			writeFileSync(markerPath, new Date().toISOString());
		} catch (markerErr) {
			log(
				`Failed to write quality-check marker (non-fatal): ${markerErr instanceof Error ? markerErr.message : String(markerErr)}`,
			);
		}

		// Per-file fan-out: Codex `apply_patch` payloads can carry multiple
		// `*** Update File:` / `Add File:` / `Delete File:` sections in one call.
		// Iterate so quality / structural / TDD / suggestion checks run for every
		// file in the patch, not just the first one. For non-multi events,
		// `editedFilePaths` collapses to a single-element list.
		const pathsToCheck =
			editedFilePaths.length > 0
				? editedFilePaths
				: editedFilePath.length > 0
					? [editedFilePath]
					: [""];
		// Phase mark — everything before this point was tool-response checks
		// (silent-failure, context-bloat) plus paths-to-check setup.
		markPhase("tool_response_checks");
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
		for (const currentEditedPath of pathsToCheck) {
			await runPerFileChecks(ctx, event, session, currentEditedPath, postDecision, acc);
		}
		// Phase mark — covers behavioral-checks + the recurrence log
		// appender. If `recordHarnessCaught` is doing a full re-scan of
		// the recurrences.jsonl file each call, this is where it lands.
		markPhase("recurrence_aggregate");

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
			log(`Quality check file error: ${err}`);
		}
	}

	// Phase mark — covers the final warnings-marker write +
	// any tail bookkeeping outside the inner block.
	markPhase("session_persist");

	// Attach structured check results and timing to the decision
	const elapsedMs = Date.now() - postStartMs;
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

	// Required-tool coverage: warn once per session if required tools are missing
	if (rules.required_tools?.length && session) {
		const engine = getOrCreateEngine(CWD);
		for (const reqId of rules.required_tools) {
			const skipKey = `required-tool-missing::${reqId}`;
			if (session.acknowledged_checks.has(skipKey)) continue;
			if (!engine.isToolAvailable(reqId)) {
				if (!postDecision.warnings) postDecision.warnings = [];
				postDecision.warnings.push(
					`[interlinked:required-tool] Required tool "${reqId}" is not available. Install it or remove from required_tools in guard-rules.json.`,
				);
				session.acknowledged_checks.add(skipKey);
			}
		}
	}

	// Emit a summary line when all checks pass (positive feedback).
	// When there ARE issues, the detailed warnings provide the signal.
	// Uses a separate `summary` field so the hook script can surface it
	// as non-blocking output (stderr/pending) rather than a fake "block".
	const allWarnings = postDecision.warnings || [];
	if (allWarnings.length === 0 && checksRan.length > 0) {
		const ruleCount = rules.rules.length;
		// Deduplicate and abbreviate check names for a compact summary
		const unique = [...new Set(checksRan)];
		const checkSummary = unique
			.map((c) => {
				if (c === "structural") return "structural";
				if (c === "typescript") return "tsc";
				if (c === "biome_lint") return "biome";
				if (c === "secrets_in_source") return "secrets";
				if (c === "affected_tests") return "tests";
				return c.replace(/_/g, "-");
			})
			.join(", ");
		postDecision.summary = `[interlinked] ✓ ${ruleCount} guard rules, ${checkSummary} — all clean (${elapsedMs}ms)`;
	}

	return postDecision;
}
