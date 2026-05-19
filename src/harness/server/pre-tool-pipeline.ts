// ===========================================
// PreToolUse evaluation pipeline
// ===========================================
// The `if (isPreToolUse(event))` block extracted verbatim from
// `processEvent` in server.ts. Runs the guard evaluator, then layers on the
// policy classifier, content-scanner WebFetch proxy + scan-request handling,
// auto-coordination, learned rules, the TDD / project-wide commit gates,
// grep + tsgo acceleration, and the diff-aware pre-edit baseline capture.
//
// Behavior-preserving move: bare module-level state (`rules`, `trigramIndex`,
// …) becomes `ctx.rules`, `ctx.trigramIndex`, …; `getGraphForFile(x)` /
// `getAutoCoordState(x)` take `ctx` as the first argument.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readSharedConfig } from "../../lib/config.js";
import { shouldCoordinate } from "../auto-coordinate.js";
import { injectCoordinationWarnings } from "../auto-coordinate.js";
import {
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTppLeapfrog,
} from "../behavioral-checks.js";
import {
	checkAssertionStrengthWeakening,
	checkClockMockAdded,
	checkConventionalCommitCoherence,
	checkDisabledTestDelta,
	checkDoneWithoutVerify,
	checkReintroducesRemovedCode,
	checkTestBlockCountRegression,
	parseCommitMessageFromBash,
} from "../behavioral-diff-checks.js";
import { snapshotCrap } from "../checks/crap-baseline.js";
import { snapshotDryShingles } from "../checks/dry-baseline.js";
import { collectSiblingFunctions } from "../checks/dry-check.js";
import { applyAllowlist } from "../content-scanner/allowlist.js";
import { decideFromFindings } from "../content-scanner/policy.js";
import { buildAskReason, writePendingPrompt } from "../content-scanner/redact-preview.js";
import { countPendingReviews } from "../content-scanner/review-files.js";
import type { ScanFinding } from "../content-scanner/types.js";
import { fetchAndScan } from "../content-scanner/web-fetch-proxy.js";
import { coverageForFile, loadCoverageFinal } from "../coverage-final-reader.js";
import { capturePrimitiveViolations as captureDiscoveredPrimitiveViolations } from "../discovered-primitives.js";
import { evaluatePreToolUse, extractPermissionPattern } from "../evaluator.js";
import { checkFunctionComplexity, checkMissingReturnTypes } from "../generic-checks.js";
import { checkGrepAcceleration, findRipgrep } from "../grep-accelerator.js";
import {
	appendShadowLog,
	buildEvidenceEnvelope,
	callClassifier,
	createClassifierSessionState,
	hashEvidence,
} from "../policy-classifier.js";
import { checkProjectTestsClean, checkProjectTypecheckClean } from "../project-typecheck-gate.js";
import {
	collectSoftwareVersionReferences,
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
	findProjectRoot,
} from "../quality-checks.js";
import { isBashTsc, tryTsgoRewrite } from "../server-tsgo-bash.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import type { HarnessDecision, HarnessEvent, PreEditBaseline, SessionTrajectory } from "../types.js";
import {
	getAutoCoordState,
	getGraphForFile,
	type ServerRuntime,
	summarizeToolInput,
} from "./runtime-context.js";

/**
 * Run the full PreToolUse pipeline for a tool-use event. Returns the final
 * `HarnessDecision` (allow / block / ask).
 */
export async function runPreToolPipeline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { rules } = ctx;
	const CWD = ctx.cwd;
	const log = ctx.log;
	// Resolve graph for the file being edited (supports cross-repo edits)
	const filePath =
		(event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
	const activeGraph = getGraphForFile(ctx, filePath || CWD);

	// `sharedConfig` carries Phase D.2 trajectory feature flags
	// (`harness.trajectory.tool_loop`, etc.). Without passing it through,
	// `isFeatureEnabled` falls back to the defaults map (every flag false)
	// and the trajectory detector silently no-ops even after the user
	// explicitly enables it in `.interlinked/config.json`. Reading per
	// event is cheap (small JSON, fs cache) and matches what the hook
	// script does for mode resolution.
	const preDecision = evaluatePreToolUse(
		event,
		rules,
		session,
		ctx.reservations,
		ctx.cohort,
		activeGraph,
		ctx.sessions,
		ctx.routeMap,
		ctx.errorHistory,
		readSharedConfig(CWD),
	);

	// Async-deferred findings — deliver anything an off-critical-path
	// check enqueued for this session as PreToolUse context. Drain is
	// exactly-once and drops stale entries; it is a no-op until the
	// first async check is wired (async-finding-queue.ts).
	const deferredFindings = ctx.asyncFindings.drain(event.session_id);
	if (deferredFindings.length > 0) {
		preDecision.warnings = [
			...(preDecision.warnings ?? []),
			...deferredFindings.map((f) => f.message),
		];
	}

	// --- LLM Policy Classifier: escalation check (shadow mode) ---
	// Only runs when: decision is "allow", escalation criteria matched, classifier enabled.
	const classifierConfig = rules.policy_classifier;
	if (
		preDecision.decision === "allow" &&
		preDecision._escalation &&
		classifierConfig?.enabled
	) {
		const classifierStart = Date.now();
		try {
			// Get or create per-session classifier state
			let classifierState = ctx.classifierSessions.get(event.session_id);
			if (!classifierState) {
				classifierState = createClassifierSessionState();
				ctx.classifierSessions.set(event.session_id, classifierState);
			}

			const evidence = buildEvidenceEnvelope(event, session, preDecision._escalation);
			const classification = await callClassifier(
				evidence,
				classifierConfig,
				classifierState,
			);

			const latencyMs = Date.now() - classifierStart;
			const wouldHaveChanged =
				classification.label === "deny" &&
				classification.confidence >= (classifierConfig.confidence_threshold || 0.8);

			// Shadow log
			appendShadowLog(
				{
					ts: new Date().toISOString(),
					session_id: event.session_id,
					agent_name: event.agent_name || session.agent_name,
					trigger: preDecision._escalation.trigger,
					tool_name: event.tool_name || "",
					action_class: evidence.action_class,
					local_decision: "allow",
					classification,
					would_have_changed: wouldHaveChanged,
					latency_ms: latencyMs,
					evidence_hash: hashEvidence(evidence),
				},
				CWD,
			);

			// Shadow mode: inject warning but never change decision
			if (classifierConfig.mode === "shadow") {
				const warnings = preDecision.warnings || [];
				warnings.push(
					`[interlinked:policy] Shadow: ${classification.label} (${classification.confidence.toFixed(2)}) — ${classification.reasoning}`,
				);
				preDecision.warnings = warnings;
			}
			// Enforce mode will promote the shadow-only classifier result into
			// a blocking decision once that path is wired up.

			ctx.writeClassifierStatus(
				`${classifierConfig.provider}:${classifierConfig.model}:ok:${latencyMs}ms`,
			);
			log(
				`Policy classifier: ${classification.label} (${classification.confidence.toFixed(2)}) for ${preDecision._escalation.trigger} — ${latencyMs}ms`,
			);
		} catch (classifierErr) {
			// Fail-open: classifier errors never block the tool call
			ctx.writeClassifierStatus(
				`${classifierConfig.provider}:${classifierConfig.model}:error`,
			);
			log(
				`Policy classifier error (fail-open): ${classifierErr instanceof Error ? classifierErr.message : String(classifierErr)}`,
			);
		}
	}

	// --- Content Scanner: WebFetch proxy (3-way human review) ---
	// PostToolUse `block` cannot substitute the agent's view of `tool_response`,
	// so for WebFetch we intercept at PreToolUse: harness performs the fetch
	// itself, scans the body, and either passes it through (no findings),
	// stashes a review file (findings present), or honours a prior user
	// decision (allow / redact / block) via block-and-answer. See
	// `web-fetch-proxy.ts` for the flow.
	const isWebFetchTool =
		event.tool_name === "WebFetch" || event.tool_name === "web_fetch";
	if (
		preDecision.decision === "allow" &&
		isWebFetchTool &&
		ctx.contentScanner &&
		rules.content_scanner?.enabled &&
		rules.content_scanner.scan_points.external_egress
	) {
		const url = (event.tool_input?.url as string) || "";
		const promptField = (event.tool_input?.prompt as string) || "";
		if (url) {
			const proxyResult = await fetchAndScan({
				cwd: CWD,
				url,
				prompt: promptField,
				scanner: ctx.contentScanner,
				compiledAllowlist: ctx.compiledAllowlist,
				config: rules.content_scanner,
				toolName: event.tool_name ?? "WebFetch",
			});
			log(
				`Content scanner: WebFetch proxy → ${proxyResult.kind}` +
					(proxyResult.kind === "review_pending"
						? ` (${proxyResult.findingCount} finding(s))`
						: ""),
			);
			if (proxyResult.kind === "passthrough") {
				return {
					decision: "block",
					reason: proxyResult.body,
					warnings: preDecision.warnings,
				};
			}
			if (proxyResult.kind === "review_pending") {
				ctx.writeReviewPendingMarker(countPendingReviews(CWD));
				return {
					decision: "block",
					reason:
						"Privacy filter flagged this WebFetch response. The body is " +
						`stashed locally for review (${proxyResult.findingCount} finding(s)).\n` +
						"Run `interlinked scanner review` in another terminal to choose " +
						"Allow / Redact / Block, then re-invoke the same WebFetch.",
					warnings: preDecision.warnings,
				};
			}
			if (proxyResult.kind === "decision_resolved") {
				ctx.writeReviewPendingMarker(countPendingReviews(CWD));
				return {
					decision: "block",
					reason: proxyResult.body,
					warnings: preDecision.warnings,
				};
			}
			// proxyResult.kind === "fail_open" — fall through to the regular
			// flow so existing rules still apply. The agent's WebFetch will
			// run normally; PII in the response is then handled by the
			// post-scan path's taint ratchet.
			log(`Content scanner: WebFetch proxy fail_open — ${proxyResult.detail}`);
		}
	}

	// --- Content Scanner: run ML PII detection on the scan request (if present) ---
	// Runs when the evaluator attached a _contentScan bundle AND the scanner is
	// enabled. Iterates per-part (Write.content, Bash.command, etc.), aggregates
	// findings, and blocks the tool call if any survive the min_score floor.
	// Fail-open on any error (network, spawn, timeout).
	if (
		preDecision.decision === "allow" &&
		preDecision._contentScan &&
		ctx.contentScanner &&
		rules.content_scanner?.enabled
	) {
		const scanReq = preDecision._contentScan;
		const maxBytes = rules.content_scanner.max_scan_bytes || 100_000;
		const timeoutMs = rules.content_scanner.local?.scan_timeout_ms || 1500;
		const findings: ScanFinding[] = [];
		for (const part of scanReq.parts) {
			try {
				const partFindings = await ctx.contentScanner.scan({
					text: part.text.slice(0, maxBytes),
					source: part.source,
					signal: AbortSignal.timeout(timeoutMs),
				});
				findings.push(...partFindings);
			} catch (scanErr) {
				log(
					`Content scanner scan failed (fail-open): ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
				);
			}
		}
		// Allowlist pass — drop known false positives (noreply@*, snake_case
		// identifiers misread as private_person, RFC test domains, etc.)
		// before the policy decides. Suppressed entries don't reach the
		// permission UI, the systemMessage, or the pending-prompt file.
		const allowlistResult = applyAllowlist(findings, ctx.compiledAllowlist);
		const keptFindings = allowlistResult.kept;
		if (allowlistResult.suppressed.length > 0) {
			log(
				`Content scanner: allowlist suppressed ${allowlistResult.suppressed.length} finding(s)`,
			);
		}
		const verdict = decideFromFindings(keptFindings, rules.content_scanner);
		log(
			`Content scanner: ${event.tool_name} (${scanReq.hook}) — ${scanReq.parts.length} part(s), ${findings.length} finding(s) (${keptFindings.length} after allowlist), decision=${verdict.decision}`,
		);
		if (verdict.decision === "ask") {
			// Hand off to Claude Code's built-in confirmation UI via the "ask"
			// decision. Reason has three parts:
			//   (1) category summary from decideFromFindings  — agent-safe
			//   (2) per-source preview with PII → <CATEGORY>   — agent-safe
			//   (3) pointer to a LOCAL-ONLY file with the full unmasked content
			//       — user opens from another terminal; never sent to Anthropic.
			// Group only the SURVIVORS for the pending-prompt + ask-reason —
			// allowlist-suppressed findings are FPs the operator already
			// declared safe, so we mustn't echo them back through the UI.
			const findingsBySource = new Map<string, ScanFinding[]>();
			for (const f of keptFindings) {
				const bucket = findingsBySource.get(f.source) ?? [];
				bucket.push(f);
				findingsBySource.set(f.source, bucket);
			}
			const pendingPromptPath = writePendingPrompt({
				cwd: CWD,
				request: scanReq,
				findingsBySource,
				toolName: event.tool_name ?? "unknown",
			});
			preDecision.decision = "ask";
			const askOutputs = buildAskReason({
				policySummary: verdict.reason ?? "privacy-filter detected sensitive content.",
				request: scanReq,
				findingsBySource,
				pendingPromptPath,
			});
			preDecision.reason = askOutputs.reason;
			// Raw flagged values are surfaced here only — Claude Code's
			// `systemMessage` is shown to the user but NOT included in the
			// model's context window (hooks reference). This is the sole
			// agent-safe channel for raw PII.
			if (askOutputs.systemMessage) preDecision.system_message = askOutputs.systemMessage;
		}
	}

	// Clean up _escalation and _contentScan from the decision before returning to hook script
	// (internal fields, not part of the hook protocol)
	delete preDecision._escalation;
	delete preDecision._contentScan;

	// --- Auto-coordination: periodic read-only check-in with MCP server ---
	const eventToolName = event.tool_name || "";
	if (
		preDecision.decision === "allow" &&
		session &&
		ctx.serverBridge &&
		shouldCoordinate(
			session,
			getAutoCoordState(ctx, event.session_id),
			ctx.autoCoordConfig,
			eventToolName,
		)
	) {
		const coordState = getAutoCoordState(ctx, event.session_id);
		try {
			const coordResponse = await ctx.serverBridge.fetchCoordinationState(
				event.agent_name || session.agent_name,
				session,
				ctx.autoCoordConfig.timeout_ms,
			);
			if (coordResponse) {
				injectCoordinationWarnings(preDecision, coordResponse);
				session.last_coordination_at = session.tool_call_count;
				session.last_coordination_ts = Date.now();
				coordState.consecutiveMisses = 0;
				coordState.totalCheckins++;
				log(
					`Auto-coordination: ${coordResponse.unread.total} unread, ${coordResponse.task_changes.length} task changes`,
				);
			} else {
				coordState.consecutiveMisses++;
				if (coordState.consecutiveMisses >= ctx.autoCoordConfig.max_misses_before_disable) {
					coordState.disabled = true;
					log("Auto-coordination: disabled after consecutive misses");
				}
			}
		} catch {
			coordState.consecutiveMisses++;
		}
	}

	// Inject any pending findings from background async analysis
	if (filePath) {
		const asyncFindings = ctx.asyncAnalysis.consume(filePath);
		if (asyncFindings.length > 0) {
			const warnings = preDecision.warnings || [];
			for (const f of asyncFindings) {
				warnings.push(`[interlinked:async] ${f.name}: ${f.message}`);
			}
			preDecision.warnings = warnings;
			log(`Injected ${asyncFindings.length} async finding(s) for ${filePath}`);
		}
	}

	// Cross-session learned rules: observe allowed patterns
	if (preDecision.decision === "allow" && event.tool_name) {
		const pat = extractPermissionPattern(event.tool_name, event.tool_input || {});
		if (pat && !ctx.learnedRules.has(pat)) {
			const learned = ctx.learnedRules.observe(pat, event.session_id);
			if (learned) {
				const warnings = preDecision.warnings || [];
				warnings.push(
					`[interlinked:learned] Pattern "${pat}" observed ${learned.observation_count} times across sessions — saved as learned rule.`,
				);
				preDecision.warnings = warnings;
				log(`Learned rule: ${pat}`);
			}
		}
	}

	// Report blocks/warns to server for team visibility
	if (ctx.serverBridge && preDecision.decision === "block") {
		ctx.serverBridge.reportGuardEvent({
			agent_name: event.agent_name || session.agent_name,
			event_type: "guard_block",
			tool_name: event.tool_name,
			tool_input_summary: summarizeToolInput(event),
			decision: "block",
			reason: preDecision.reason || "Blocked by guard rule",
			occurred_at: event.timestamp,
		});
	}

	// --- TDD commit gate: check for unresolved test failures before git commit ---
	if (
		preDecision.decision === "allow" &&
		session &&
		event.tool_name === "Bash" &&
		/\bgit\s+commit\b/.test((event.tool_input?.command as string) || "")
	) {
		const testFirstMode = rules.structural_checks?.test_first_mode || "warn";
		const commitMessage = parseCommitMessageFromBash(
			(event.tool_input?.command as string) || "",
		);
		const gateResults = [
			...(session.tdd_cycles.size > 0 ? checkTddCommitGate(session, testFirstMode) : []),
			...checkProdDeltaWithoutTestDelta(session),
			...checkProdTestLocRatio(session),
			...checkTppLeapfrog(session),
			// Batch 3: diff-aware commit gates.
			...checkDisabledTestDelta(session),
			...checkTestBlockCountRegression(session),
			...checkAssertionStrengthWeakening(session),
			...checkClockMockAdded(session),
			...checkConventionalCommitCoherence(session, commitMessage),
			// Batch 4: trajectory commit gates.
			...checkReintroducesRemovedCode(session),
			...checkDoneWithoutVerify(session),
		];
		if (gateResults.length > 0) {
			const warnings = preDecision.warnings || [];
			for (const r of gateResults) {
				warnings.push(`[interlinked:${r.name}] ${r.message}`);
			}
			preDecision.warnings = warnings;

			if (
				testFirstMode === "enforce" &&
				gateResults.some((r) => r.severity === "error")
			) {
				preDecision.decision = "block";
				preDecision.reason =
					"BLOCKED: Tests must pass before committing. " +
					gateResults
						.filter((r) => r.severity === "error")
						.map((r) => r.message)
						.join(" ");
			}
		}
	}

	// --- Project-wide typecheck gate (commit + push) ---
	// Diff-UNaware. Asserts the WHOLE project typechecks before
	// allowing `git commit` or `git push`. Catches the failure
	// mode where an agent edits file A, doesn't touch file B, and
	// CI fails because B was already broken. Per-edit checks are
	// diff-aware and won't surface that. This gate must.
	// Bypass via INTERLINKED_SKIP_PROJECT_TYPECHECK=1 (audited).
	if (preDecision.decision === "allow" && event.tool_name === "Bash") {
		const cmdStr = (event.tool_input?.command as string) || "";
		const isCommit = /\bgit\s+commit\b/.test(cmdStr);
		const isPush = /\bgit\s+push\b/.test(cmdStr);
		if (isCommit || isPush) {
			const tcResults = checkProjectTypecheckClean(CWD);
			const tcWarnings = tcResults.filter((r) => r.severity === "warning");
			const tcErrors = tcResults.filter((r) => r.severity === "error");
			if (tcWarnings.length > 0) {
				const warnings = preDecision.warnings || [];
				for (const w of tcWarnings) {
					warnings.push(`[interlinked:${w.name}] ${w.message}`);
				}
				preDecision.warnings = warnings;
			}
			if (tcErrors.length > 0) {
				preDecision.decision = "block";
				const action = isCommit ? "commit" : "push";
				const errLines = tcErrors
					.slice(0, 10)
					.map((e) => `  - ${e.message}`)
					.join("\n");
				const tail =
					tcErrors.length > 10 ? `\n  ... and ${tcErrors.length - 10} more` : "";
				preDecision.reason =
					`BLOCKED: Project typecheck failed (${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}) — CI will fail on this ${action}. ` +
					"Pre-existing errors in untouched files DO count: every commit must build clean. Fix these first:\n" +
					errLines +
					tail +
					"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
					"INTERLINKED_SKIP_PROJECT_TYPECHECK=1 git ...";
				if (ctx.serverBridge) {
					ctx.serverBridge.reportGuardEvent({
						agent_name: event.agent_name || session?.agent_name || "",
						event_type: "guard_block",
						tool_name: event.tool_name,
						tool_input_summary: summarizeToolInput(event),
						decision: "block",
						reason: `project_typecheck_clean: ${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}`,
						occurred_at: event.timestamp,
					});
				}
			}

			// Push-only second tier: full test suite. Typecheck-clean
			// is necessary but not sufficient — the codex-flag commit
			// + 139-repo audit wave were both tsc-clean but had stale
			// test assertions that turned CI red. Tests are slow
			// (~40s on this repo), so we only run them on PUSH, not
			// on every commit. Bypass: INTERLINKED_SKIP_PROJECT_TESTS=1.
			if (preDecision.decision === "allow" && isPush) {
				const testResults = checkProjectTestsClean(CWD);
				const testWarnings = testResults.filter((r) => r.severity === "warning");
				const testErrors = testResults.filter((r) => r.severity === "error");
				if (testWarnings.length > 0) {
					const warnings = preDecision.warnings || [];
					for (const w of testWarnings) {
						warnings.push(`[interlinked:${w.name}] ${w.message}`);
					}
					preDecision.warnings = warnings;
				}
				if (testErrors.length > 0) {
					preDecision.decision = "block";
					const failLines = testErrors
						.slice(0, 10)
						.map((e) => `  - ${e.message}`)
						.join("\n");
					const tail =
						testErrors.length > 10
							? `\n  ... and ${testErrors.length - 10} more`
							: "";
					preDecision.reason =
						`BLOCKED: Project tests failed (${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}) — CI will fail on this push. ` +
						"Pre-existing test failures DO count: every push must build clean. Failing tests:\n" +
						failLines +
						tail +
						"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
						"INTERLINKED_SKIP_PROJECT_TESTS=1 git push ...";
					if (ctx.serverBridge) {
						ctx.serverBridge.reportGuardEvent({
							agent_name: event.agent_name || session?.agent_name || "",
							event_type: "guard_block",
							tool_name: event.tool_name,
							tool_input_summary: summarizeToolInput(event),
							decision: "block",
							reason: `project_tests_clean: ${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}`,
							occurred_at: event.timestamp,
						});
					}
				}
			}
		}
	}

	// --- Grep acceleration: intercept search tools via trigram index ---
	// Substitution path (block-and-answer) is DISABLED by default. Reason:
	//   - Bypasses the content scanner — substituted output reaches the
	//     model via permissionDecisionReason, an envelope the OPF scanner
	//     and checks/pii.ts weren't designed to inspect.
	//   - Index can be stale: incrementalUpdate uses `git diff baseCommit
	//     ..HEAD`, refresh fires on SessionStart only, external file edits
	//     are invisible until next session.
	//   - Partially-formed hookSpecificOutput envelopes have hit Claude
	//     Code's "(root): Invalid input" validator failure (fail-closed
	//     on a safety boundary, contradicts feedback_safety_continuity).
	// The trigram index itself stays loaded and is still consumed by
	// impact analysis, project graph, and structural checks.
	// Re-enable: set INTERLINKED_GREP_ACCELERATOR=1 OR set
	// guard-rules.json `grep_acceleration.substitution_enabled: true`.
	const isSearchTool =
		event.tool_name === "Grep" ||
		(event.tool_name === "Bash" &&
			/\b(rg|ripgrep|grep|egrep)\s/.test((event.tool_input?.command as string) || ""));

	const grepSubstitutionEnabled =
		process.env.INTERLINKED_GREP_ACCELERATOR === "1" ||
		(process.env.INTERLINKED_GREP_ACCELERATOR !== "0" &&
			rules.grep_acceleration?.substitution_enabled === true);

	if (
		preDecision.decision === "allow" &&
		ctx.trigramIndex &&
		isSearchTool &&
		grepSubstitutionEnabled
	) {
		const grepDecision = checkGrepAcceleration(event, ctx.trigramIndex, {}, ctx.fileContentCache);
		if (grepDecision) {
			log(`Grep accelerated: ${event.tool_name} → ${grepDecision.decision}`);
			// Merge any warnings from the guard evaluation
			if (preDecision.warnings?.length) {
				grepDecision.warnings = [
					...(preDecision.warnings || []),
					...(grepDecision.warnings || []),
				];
			}
			return grepDecision;
		}
	}

	// For search tools that weren't accelerated, add index status as a warning.
	// Once-per-session dedup: this fired on every search call before, training
	// agents to ignore it. The status doesn't change mid-session (trigramIndex
	// is loaded once at startup), so re-emitting buys nothing.
	const indexWarnKey = event.session_id || "anonymous";
	if (
		isSearchTool &&
		preDecision.decision === "allow" &&
		!ctx.indexWarningSent.has(indexWarnKey)
	) {
		const warnings = preDecision.warnings || [];
		let emitted = false;
		if (!ctx.trigramIndex) {
			warnings.push(
				"[interlinked:index] No search index. Run `interlinked index build` to enable grep acceleration.",
			);
			emitted = true;
		} else if (!findRipgrep()) {
			warnings.push(
				"[interlinked:index] Index loaded but ripgrep not installed — grep acceleration disabled. Install: brew install ripgrep",
			);
			emitted = true;
		} else {
			// Index + rg both available. Check freshness by comparing base commit to HEAD.
			try {
				const head = execSync("git rev-parse HEAD", {
					cwd: CWD,
					encoding: "utf-8",
					timeout: 2000,
				}).trim();
				if (head && ctx.trigramIndex.baseCommit && head !== ctx.trigramIndex.baseCommit) {
					const behindCount = execSync(
						`git rev-list --count ${ctx.trigramIndex.baseCommit.slice(0, 8)}..HEAD`,
						{ cwd: CWD, encoding: "utf-8", timeout: 2000 },
					).trim();
					warnings.push(
						`[interlinked:index] Search index is ${behindCount} commit(s) behind HEAD. Run \`interlinked index build\` to refresh.`,
					);
					emitted = true;
				}
			} catch (e) {
				void e;
			}
		}
		// Mark sent regardless of whether we emitted — clean state need not re-check.
		ctx.indexWarningSent.add(indexWarnKey);
		if (emitted) {
			preDecision.warnings = warnings;
		}
	}

	// --- tsgo acceleration: rewrite tsc → tsgo when available ---
	if (preDecision.decision === "allow" && isBashTsc(event)) {
		const tsgoResult = tryTsgoRewrite(event, CWD, log);
		if (tsgoResult) return tsgoResult;
		// tsgo not available — let tsc through but note it in warnings
		const warnings = preDecision.warnings || [];
		warnings.push(
			"[interlinked:tsc] Using tsc (tsgo not available — install @typescript/native-preview for ~10x faster type checking)",
		);
		preDecision.warnings = warnings;
	}

	// --- Diff-aware: capture pre-edit baseline for file write tools ---
	if (rules.diff_aware?.enabled !== false && filePath) {
		const toolName = event.tool_name || "";
		const isFileWrite = [
			"Write",
			"Edit",
			"Update",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
		].includes(toolName);

		const baselineFilePath = isAbsolute(filePath) ? filePath : resolve(CWD, filePath);
		if (isFileWrite && existsSync(baselineFilePath)) {
			try {
				const preContent = readFileSync(baselineFilePath, "utf-8");
				const missingRT = checkMissingReturnTypes(preContent, baselineFilePath);
				const complexFns = checkFunctionComplexity(preContent, baselineFilePath);
				// CRAP baseline — fail-open when coverage data is absent.
				let crapScores: Map<string, Map<string, number>> | undefined;
				try {
					const coveragePath = resolve(CWD, "coverage", "coverage-final.json");
					const covCache = loadCoverageFinal(coveragePath, CWD);
					if (covCache) {
						const relPath = relative(CWD, baselineFilePath).replace(/\\/g, "/");
						const perFile = coverageForFile(covCache, relPath);
						const mtimeMs = statSync(baselineFilePath).mtimeMs;
						crapScores = snapshotCrap({
							preContent,
							filePath: relPath,
							coverage: perFile,
							fileMtime: mtimeMs,
							threshold: 30,
						});
					}
				} catch (crapErr) {
					void crapErr; /* CRAP snapshot must never break the baseline capture */
				}
				let dryCloneBaseline: PreEditBaseline["dryCloneBaseline"] | undefined;
				try {
					dryCloneBaseline = snapshotDryShingles({
						preContent,
						filePath: baselineFilePath,
						candidates: collectSiblingFunctions(baselineFilePath),
					});
				} catch (dryErr) {
					void dryErr; /* clone snapshot must never break the baseline capture */
				}
				ctx.preEditBaselines.set(baselineFilePath, {
					missingReturnTypes: new Set(missingRT.map((m) => m.text)),
					complexFunctions: new Set(complexFns.map((m) => m.text)),
					crapScores,
					dryCloneBaseline,
					capturedAt: Date.now(),
					suppressionCount: countSuppressionDirectives(preContent),
					asAnyCastCount: countAsAnyCasts(preContent),
					nonNullAssertionCount: countNonNullAssertions(preContent),
					todoMarkerCount: countTodoMarkers(preContent),
					consoleStatementCount: countConsoleStatements(preContent),
					publicApiSurfaceCount: countPublicApiSurface(preContent),
					typeDensity: countTypeDensity(preContent),
					softwareVersions: collectSoftwareVersionReferences(
						preContent,
						baselineFilePath,
					),
					discoveredPrimitiveViolations: captureDiscoveredPrimitiveViolations(
						CWD,
						preContent,
					),
				});
			} catch (e) {
				void e;
			}
		}
	}

	// --- Structure context injection (non-blocking) ---
	if (
		filePath &&
		[
			"Write",
			"Edit",
			"Update",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
		].includes(event.tool_name || "")
	) {
		try {
			const structRepoRoot = findProjectRoot(filePath, CWD) || CWD;
			const { config } = loadStructureConfig(structRepoRoot);
			if (config && session) {
				// Check for unresolved structure follow-ups in session
				const unresolvedStructure: string[] = [];
				for (const [key, completion] of session.pending_completions) {
					if (!key.startsWith("struct:")) continue;
					const remaining = completion.affected_files.filter(
						(f) => !completion.resolved_files.has(f),
					);
					if (remaining.length > 0) {
						unresolvedStructure.push(
							`${completion.description}: ${remaining.join(", ")}`,
						);
					}
				}
				if (unresolvedStructure.length > 0) {
					const warnings = preDecision.warnings || [];
					warnings.push(
						`[interlinked:structure] Unresolved companion follow-ups from previous edits:\n${unresolvedStructure.map((u) => `  - ${u}`).join("\n")}`,
					);
					preDecision.warnings = warnings;
				}
			}
		} catch (e) {
			void e;
		}
	}

	return preDecision;
}
