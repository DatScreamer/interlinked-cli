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
//
// `runPreToolPipeline` is a thin orchestrator: each cohesive phase lives in an
// INTERNAL helper below (no public-surface change). Phases that can replace the
// decision return `HarnessDecision | null` (null = continue); phases that only
// annotate the running decision mutate `preDecision` in place and return void.
// Side-effect ordering is preserved exactly — see the orchestrator at the foot
// of the file.

import { execSync } from "node:child_process";
import { readSharedConfig } from "../../lib/config.js";
import { shouldCoordinate } from "../auto-coordinate.js";
import { injectCoordinationWarnings } from "../auto-coordinate.js";
import { applyAllowlist } from "../content-scanner/allowlist.js";
import { decideFromFindings } from "../content-scanner/policy.js";
import { buildAskReason, writePendingPrompt } from "../content-scanner/redact-preview.js";
import { countPendingReviews } from "../content-scanner/review-files.js";
import type { ScanFinding } from "../content-scanner/types.js";
import { fetchAndScan } from "../content-scanner/web-fetch-proxy.js";
import { evaluatePreToolUse, extractPermissionPattern } from "../evaluator.js";
import { checkGrepAcceleration, findRipgrep } from "../grep-accelerator.js";
import {
	appendShadowLog,
	buildEvidenceEnvelope,
	callClassifier,
	createClassifierSessionState,
	hashEvidence,
} from "../policy-classifier.js";
import { isBashTsc, tryTsgoRewrite } from "../server-tsgo-bash.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	captureDiffAwareBaseline,
	injectStructureContext,
	runProjectWideGitGate,
	runTddCommitGate,
} from "./pre-tool-pipeline-stages.js";
import {
	getAutoCoordState,
	getGraphForFile,
	type ServerRuntime,
	summarizeToolInput,
} from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Phase helpers (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Resolve the file path the tool acts on, supporting both `file_path` (Write /
 * Edit / Read) and `path` (alternate tools), falling back to "".
 */
function resolveEventFilePath(event: HarnessEvent): string {
	return (event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
}

/**
 * Deliver any async-deferred findings enqueued for this session as PreToolUse
 * context. Drain is exactly-once; a no-op until the first async check is wired.
 */
function drainDeferredFindings(ctx: ServerRuntime, event: HarnessEvent, preDecision: HarnessDecision): void {
	const deferredFindings = ctx.asyncFindings.drain(event.session_id);
	if (deferredFindings.length > 0) {
		preDecision.warnings = [
			...(preDecision.warnings ?? []),
			...deferredFindings.map((f) => f.message),
		];
	}
}

/**
 * LLM Policy Classifier escalation (shadow mode). Only runs when the decision
 * is "allow", the evaluator attached an escalation, and the classifier is
 * enabled. Mutates `preDecision.warnings` in shadow mode; never changes the
 * decision (enforce-mode promotion is not wired yet). Fail-open on any error.
 */
async function runClassifierEscalation(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): Promise<void> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const classifierConfig = ctx.rules.policy_classifier;
	if (!(preDecision.decision === "allow" && preDecision._escalation && classifierConfig?.enabled)) {
		return;
	}
	const classifierStart = Date.now();
	try {
		// Get or create per-session classifier state
		let classifierState = ctx.classifierSessions.get(event.session_id);
		if (!classifierState) {
			classifierState = createClassifierSessionState();
			ctx.classifierSessions.set(event.session_id, classifierState);
		}

		const evidence = buildEvidenceEnvelope(event, session, preDecision._escalation);
		const classification = await callClassifier(evidence, classifierConfig, classifierState);

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
		ctx.writeClassifierStatus(`${classifierConfig.provider}:${classifierConfig.model}:error`);
		log(
			`Policy classifier error (fail-open): ${classifierErr instanceof Error ? classifierErr.message : String(classifierErr)}`,
		);
	}
}

/**
 * Content Scanner WebFetch proxy (3-way human review). PostToolUse `block`
 * cannot substitute the agent's view of `tool_response`, so for WebFetch we
 * intercept at PreToolUse: harness performs the fetch, scans the body, and
 * either passes it through, stashes a review file, or honours a prior decision.
 * Returns a replacement `HarnessDecision` (always a `block`-and-answer envelope)
 * or `null` to fall through to the regular flow. See `web-fetch-proxy.ts`.
 */
async function runWebFetchProxy(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;
	const isWebFetchTool = event.tool_name === "WebFetch" || event.tool_name === "web_fetch";
	if (
		!(
			preDecision.decision === "allow" &&
			isWebFetchTool &&
			ctx.contentScanner &&
			rules.content_scanner?.enabled &&
			rules.content_scanner.scan_points.external_egress
		)
	) {
		return null;
	}
	const url = (event.tool_input?.url as string) || "";
	const promptField = (event.tool_input?.prompt as string) || "";
	if (!url) return null;
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
			(proxyResult.kind === "review_pending" ? ` (${proxyResult.findingCount} finding(s))` : ""),
	);
	if (proxyResult.kind === "passthrough") {
		return { decision: "block", reason: proxyResult.body, warnings: preDecision.warnings };
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
		return { decision: "block", reason: proxyResult.body, warnings: preDecision.warnings };
	}
	// proxyResult.kind === "fail_open" — fall through to the regular
	// flow so existing rules still apply. The agent's WebFetch will
	// run normally; PII in the response is then handled by the
	// post-scan path's taint ratchet.
	log(`Content scanner: WebFetch proxy fail_open — ${proxyResult.detail}`);
	return null;
}

/**
 * Build the "ask" outcome for a flagged scan request: group survivors by
 * source, stash the unmasked pending-prompt file, and write the agent-safe
 * reason + (optional) raw-PII system message onto `preDecision`.
 */
function buildScanAskOutcome(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
	scanReq: NonNullable<HarnessDecision["_contentScan"]>,
	keptFindings: ScanFinding[],
	verdict: { reason?: string },
): void {
	const CWD = ctx.cwd;
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

/**
 * Content Scanner: run ML PII detection on the scan request (if present).
 * Runs when the evaluator attached a _contentScan bundle AND the scanner is
 * enabled. Iterates per-part, aggregates findings, applies the allowlist, and
 * promotes the decision to "ask" when the policy says so. Fail-open on any
 * per-part error (network, spawn, timeout).
 */
async function runContentScanRequest(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<void> {
	const log = ctx.log;
	const rules = ctx.rules;
	if (
		!(
			preDecision.decision === "allow" &&
			preDecision._contentScan &&
			ctx.contentScanner &&
			rules.content_scanner?.enabled
		)
	) {
		return;
	}
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
		log(`Content scanner: allowlist suppressed ${allowlistResult.suppressed.length} finding(s)`);
	}
	const verdict = decideFromFindings(keptFindings, rules.content_scanner);
	log(
		`Content scanner: ${event.tool_name} (${scanReq.hook}) — ${scanReq.parts.length} part(s), ${findings.length} finding(s) (${keptFindings.length} after allowlist), decision=${verdict.decision}`,
	);
	if (verdict.decision === "ask") {
		buildScanAskOutcome(ctx, event, preDecision, scanReq, keptFindings, verdict);
	}
}

/**
 * Auto-coordination: periodic read-only check-in with the MCP server. Mutates
 * `preDecision` (coordination warnings) and the per-session coord state on a
 * successful check-in; increments misses (and may disable) otherwise. Catch
 * path increments misses. No-op unless allow + a server bridge + the cadence.
 */
async function runAutoCoordination(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): Promise<void> {
	const log = ctx.log;
	const eventToolName = event.tool_name || "";
	if (
		!(
			preDecision.decision === "allow" &&
			session &&
			ctx.serverBridge &&
			shouldCoordinate(
				session,
				getAutoCoordState(ctx, event.session_id),
				ctx.autoCoordConfig,
				eventToolName,
			)
		)
	) {
		return;
	}
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

/**
 * Inject any pending findings from background async analysis as tagged
 * warnings on `preDecision`. No-op when there is no file path or no findings.
 */
function injectAsyncAnalysisFindings(
	ctx: ServerRuntime,
	filePath: string,
	preDecision: HarnessDecision,
): void {
	if (!filePath) return;
	const asyncFindings = ctx.asyncAnalysis.consume(filePath);
	if (asyncFindings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const f of asyncFindings) {
			warnings.push(`[interlinked:async] ${f.name}: ${f.message}`);
		}
		preDecision.warnings = warnings;
		ctx.log(`Injected ${asyncFindings.length} async finding(s) for ${filePath}`);
	}
}

/**
 * Cross-session learned rules: observe allowed patterns and warn when a
 * pattern crosses the recurrence threshold. Mutates `preDecision.warnings`.
 */
function observeLearnedRules(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): void {
	if (!(preDecision.decision === "allow" && event.tool_name)) return;
	const pat = extractPermissionPattern(event.tool_name, event.tool_input || {});
	if (pat && !ctx.learnedRules.has(pat)) {
		const learned = ctx.learnedRules.observe(pat, event.session_id);
		if (learned) {
			const warnings = preDecision.warnings || [];
			warnings.push(
				`[interlinked:learned] Pattern "${pat}" observed ${learned.observation_count} times across sessions — saved as learned rule.`,
			);
			preDecision.warnings = warnings;
			ctx.log(`Learned rule: ${pat}`);
		}
	}
}

/**
 * Report blocks to the server for team visibility. No-op unless a server
 * bridge is present and the decision is a block.
 */
function reportGuardBlock(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
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
}

/** Search-tool classification + grep-substitution gating (no side effects). */
interface SearchToolFlags {
	isSearchTool: boolean;
	ugrepAwareSearch: boolean;
	grepSubstitutionEnabled: boolean;
}

/**
 * Classify the event as a search tool and resolve whether grep substitution is
 * enabled. The index-status warning uses the classic rg/grep scope
 * (`isSearchTool`); substitution additionally recognizes native-build ugrep/ug,
 * but that path is gated on `grepSubstitutionEnabled` (off by default) — so with
 * substitution disabled, ugrep recognition has NO behavioral effect anywhere.
 */
function classifySearchTool(event: HarnessEvent, rules: ServerRuntime["rules"]): SearchToolFlags {
	const isSearchTool =
		event.tool_name === "Grep" ||
		(event.tool_name === "Bash" &&
			/\b(rg|ripgrep|grep|egrep)\s/.test((event.tool_input?.command as string) || ""));
	const ugrepAwareSearch =
		isSearchTool ||
		(event.tool_name === "Bash" &&
			/\b(ugrep|ug|fgrep)\s/.test((event.tool_input?.command as string) || ""));
	const grepSubstitutionEnabled =
		process.env.INTERLINKED_GREP_ACCELERATOR === "1" ||
		(process.env.INTERLINKED_GREP_ACCELERATOR !== "0" &&
			rules.grep_acceleration?.substitution_enabled === true);
	return { isSearchTool, ugrepAwareSearch, grepSubstitutionEnabled };
}

/**
 * Never-worse-than-native completeness gate: the index provably reflects
 * current disk only when HEAD == baseCommit, the working tree is clean, and
 * there is no in-memory dirty layer. Fail-safe to false on any git error.
 */
function isGrepIndexFresh(ctx: ServerRuntime, searchIndex: NonNullable<ServerRuntime["trigramIndex"]>): boolean {
	const CWD = ctx.cwd;
	try {
		const head = execSync("git rev-parse HEAD", {
			cwd: CWD,
			encoding: "utf-8",
			timeout: 2000,
		}).trim();
		if (head && head === searchIndex.baseCommit && !searchIndex.isDirty) {
			const porcelain = execSync("git status --porcelain", {
				cwd: CWD,
				encoding: "utf-8",
				timeout: 5000,
			}).trim();
			return porcelain.length === 0;
		}
	} catch (e) {
		void e; // any git failure → treat as not-fresh → decline to native
	}
	return false;
}

/**
 * Grep acceleration: intercept search tools via the trigram index. The
 * substitution path (block-and-answer) is DISABLED by default; when enabled it
 * returns a replacement decision (merging guard warnings) or `null` to continue.
 * See the long-form note in the orchestrator history for why it is off.
 */
function runGrepAcceleration(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
	flags: SearchToolFlags,
): HarnessDecision | null {
	const searchIndex = ctx.trigramIndex;
	if (
		!(
			preDecision.decision === "allow" &&
			searchIndex &&
			flags.ugrepAwareSearch &&
			flags.grepSubstitutionEnabled
		)
	) {
		return null;
	}
	// `indexFresh` is computed ONLY when substitution is enabled (off by
	// default), so the git cost is paid only by opt-in users — and amortized
	// against the large repos the size gate requires.
	const indexFresh = isGrepIndexFresh(ctx, searchIndex);
	const grepDecision = checkGrepAcceleration(event, searchIndex, { indexFresh }, ctx.fileContentCache);
	if (grepDecision) {
		ctx.log(`Grep accelerated: ${event.tool_name} → ${grepDecision.decision}`);
		// Merge any warnings from the guard evaluation
		if (preDecision.warnings?.length) {
			grepDecision.warnings = [
				...(preDecision.warnings || []),
				...(grepDecision.warnings || []),
			];
		}
		return grepDecision;
	}
	return null;
}

/**
 * For search tools that weren't accelerated, add index status as a warning.
 * Once-per-session dedup: this fired on every search call before, training
 * agents to ignore it. The status doesn't change mid-session (trigramIndex is
 * loaded once at startup), so re-emitting buys nothing.
 */
function emitIndexStatusWarning(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
	flags: SearchToolFlags,
): void {
	const CWD = ctx.cwd;
	const indexWarnKey = event.session_id || "anonymous";
	if (
		!(flags.isSearchTool && preDecision.decision === "allow" && !ctx.indexWarningSent.has(indexWarnKey))
	) {
		return;
	}
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

/**
 * tsgo acceleration: rewrite `tsc` → `tsgo` when available. Returns the
 * rewritten decision, or `null` after annotating a warning when tsgo is absent.
 */
function runTsgoAcceleration(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): HarnessDecision | null {
	if (preDecision.decision === "allow" && isBashTsc(event)) {
		const tsgoResult = tryTsgoRewrite(event, ctx.cwd, ctx.log);
		if (tsgoResult) return tsgoResult;
		// tsgo not available — let tsc through but note it in warnings
		const warnings = preDecision.warnings || [];
		warnings.push(
			"[interlinked:tsc] Using tsc (tsgo not available — install @typescript/native-preview for ~10x faster type checking)",
		);
		preDecision.warnings = warnings;
	}
	return null;
}

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
	// Resolve graph for the file being edited (supports cross-repo edits)
	const filePath = resolveEventFilePath(event);
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
	// check enqueued for this session as PreToolUse context.
	drainDeferredFindings(ctx, event, preDecision);

	// --- LLM Policy Classifier: escalation check (shadow mode) ---
	await runClassifierEscalation(ctx, event, session, preDecision);

	// --- Content Scanner: WebFetch proxy (3-way human review) ---
	const webFetchDecision = await runWebFetchProxy(ctx, event, preDecision);
	if (webFetchDecision) return webFetchDecision;

	// --- Content Scanner: run ML PII detection on the scan request (if present) ---
	await runContentScanRequest(ctx, event, preDecision);

	// Clean up _escalation and _contentScan from the decision before returning to hook script
	// (internal fields, not part of the hook protocol)
	delete preDecision._escalation;
	delete preDecision._contentScan;

	// --- Auto-coordination: periodic read-only check-in with MCP server ---
	await runAutoCoordination(ctx, event, session, preDecision);

	// Inject any pending findings from background async analysis
	injectAsyncAnalysisFindings(ctx, filePath, preDecision);

	// Cross-session learned rules: observe allowed patterns
	observeLearnedRules(ctx, event, preDecision);

	// Report blocks/warns to server for team visibility
	reportGuardBlock(ctx, event, session, preDecision);

	// --- TDD commit gate: check for unresolved test failures before git commit ---
	runTddCommitGate(ctx, event, session, preDecision);

	// --- Project-wide typecheck gate (commit + push) + push-only test tier ---
	runProjectWideGitGate(ctx, event, session, preDecision);

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
	// The trigram index itself stays loaded, but with substitution off its
	// only live consumer is PostToolUse sibling expansion (sibling-expansion.ts);
	// it is also read for the freshness warning below. Impact analysis, the
	// project graph, and structural checks build their own dependency graphs
	// and do NOT use it.
	// Re-enable: set INTERLINKED_GREP_ACCELERATOR=1 OR set
	// guard-rules.json `grep_acceleration.substitution_enabled: true`.
	const searchFlags = classifySearchTool(event, rules);
	const grepDecision = runGrepAcceleration(ctx, event, preDecision, searchFlags);
	if (grepDecision) return grepDecision;

	// For search tools that weren't accelerated, add index status as a warning.
	emitIndexStatusWarning(ctx, event, preDecision, searchFlags);

	// --- tsgo acceleration: rewrite tsc → tsgo when available ---
	const tsgoDecision = runTsgoAcceleration(ctx, event, preDecision);
	if (tsgoDecision) return tsgoDecision;

	// --- Diff-aware: capture pre-edit baseline for file write tools ---
	captureDiffAwareBaseline(ctx, event, filePath);

	// --- Structure context injection (non-blocking) ---
	injectStructureContext(ctx, event, session, preDecision, filePath);

	return preDecision;
}
