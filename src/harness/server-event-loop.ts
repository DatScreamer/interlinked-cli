// ===========================================
// Harness server event loop
// ===========================================
// Extracted from server.ts. The per-event evaluation pipeline: parse a raw
// hook payload, hydrate/record session trajectory, dispatch to the
// lifecycle / Pre / Post pipelines, then write the live snapshot + latency
// log. Also owns the protocol-status event counter mutations.
//
// server.ts builds the `ServerRuntime` context and a few module-scoped
// callbacks (idle-timer reset, runtime in/out sync, collection-record
// writer) and hands them to `createEventLoop`, which closes over them and
// returns the two entry points the socket servers call. Keeping these
// module-global dependencies as explicit parameters (rather than closures
// over `server.ts` `let`s) is what lets the loop live in its own file
// without behavior change — startup order and side effects are identical.

import type { JsonObject } from "../lib/json-types.js";
import { appendCheckResults } from "./check-results-sink.js";
import { forwardCloudPreToolUse } from "./cloud-forward.js";
import { appendLatencyLog } from "./latency-log.js";
import { toLegacyHarnessEvent } from "./legacy-client.js";
import { readLiveSnapshot, writeLiveSnapshot } from "./live-snapshot.js";
import { buildLatencyRecord } from "./server/latency-record.js";
import { handleLifecycleEvent } from "./server/lifecycle-events.js";
import { runPostToolPipeline } from "./server/post-tool-pipeline.js";
import { runPreToolPipeline } from "./server/pre-tool-pipeline.js";
import {
	recordProtocolEvent as bumpProtocolEvent,
	type ProtocolStatusFile,
	writeProtocolStatus as persistProtocolStatus,
} from "./server/protocol-status.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import { mergeTrajectoryShadow } from "./server/trajectory-shadow.js";
import { isPostToolUse, isPreToolUse } from "./server-tool-helpers.js";
import { captureTimeline } from "./timeline-capture.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

/** Dependencies the event loop closes over. The `ServerRuntime` carries the
 *  bulk of daemon state; the rest are module-scoped callbacks / objects that
 *  live in `server.ts` (the idle timer, the runtime in/out sync, the
 *  protocol-status object + its path, the collection-record writer). */
export interface EventLoopDeps {
	readonly ctx: ServerRuntime;
	readonly protocolStatus: ProtocolStatusFile;
	readonly protocolStatusPath: string;
	readonly resetIdleTimer: () => void;
	readonly syncRuntimeIn: () => void;
	readonly syncRuntimeOut: () => void;
	readonly writeCollectionRecord: (event: HarnessEvent, decision?: HarnessDecision) => void;
}

/** The two entry points the socket servers invoke, plus the protocol-status
 *  serializer that `server.ts` startup also calls. */
export interface EventLoop {
	evaluateEventLine: (line: string, protocol: "raw" | "framed") => Promise<HarnessDecision>;
	evaluateUnifiedViaRuntime: (event: UnifiedHookEvent) => Promise<HarnessDecision>;
	writeProtocolStatus: () => void;
}

/** Build the per-event evaluation pipeline. Returns the entry points the raw
 *  and framed socket servers call. All daemon state is reached through `deps`
 *  — the function bodies are moved verbatim from the monolithic server.ts. */
export function createEventLoop(deps: EventLoopDeps): EventLoop {
	const {
		ctx,
		protocolStatus,
		protocolStatusPath,
		resetIdleTimer,
		syncRuntimeIn,
		syncRuntimeOut,
		writeCollectionRecord,
	} = deps;
	const { log, sessions } = ctx;
	const CWD = ctx.cwd;
	const INTERLINKED_DIR = ctx.interlinkedDir;

	// Daemon-lifetime telemetry counter. Write-only — incremented on every
	// processed event, never read back (the old module-level `_totalEventsProcessed`).
	let _totalEventsProcessed = 0;

	function writeProtocolStatus(): void {
		persistProtocolStatus(protocolStatusPath, protocolStatus);
	}

	function recordProtocolEvent(protocol: "raw" | "framed"): void {
		bumpProtocolEvent(protocolStatus, protocol);
		writeProtocolStatus();
	}

	async function processEvent(rawData: string): Promise<HarnessDecision> {
		let event: HarnessEvent;
		try {
			event = JSON.parse(rawData.trim());
		} catch (cause) {
			// SECURITY: Malformed events must NOT be allowed through.
			// A broken payload could be a parser-differential attack or a
			// corrupted hook script — either way, we cannot evaluate safety.
			log(`Event parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			return { decision: "block", reason: "Malformed event — cannot evaluate safety." };
		}

		_totalEventsProcessed++;
		resetIdleTimer();

		// Lazy hydrate: if the in-memory tracker has no entry for this session
		// but disk has a `<id>.live.json` from a previous incarnation of this
		// daemon, restore it before recordEvent so the upcoming event lands on
		// continuous trajectory state (acknowledged checks, edit counts, fired
		// reminders, TDD cycles, ...) instead of resetting to a fresh session.
		if (event.session_id && !sessions.get(event.session_id)) {
			const snap = readLiveSnapshot(CWD, event.session_id);
			if (snap) {
				const restored = sessions.hydrate(snap);
				if (restored) {
					log(
						`Hydrated session ${event.session_id} from live snapshot ` +
							`(${restored.tool_call_count} tool calls, ${restored.files_written.size} files written)`,
					);
				}
			}
		}

		// Update session trajectory.
		// Per-event durability: the snapshot write moved out of this function and
		// runs from `evaluateEventLine` AFTER `processEvent` returns, so the
		// snapshot reflects post-event mutations too — PostToolUse handlers
		// updating `tdd_cycles`, `assertion_counts`, or `active_skills` would
		// otherwise be lost on a daemon restart even though `recordEvent` mutated
		// state that *was* captured. See `evaluateEventLine`'s try/finally.
		const session = sessions.recordEvent(event);

		// Live timeline capture: drain the transcript (new records since the
		// cursor) into .interlinked/timeline.jsonl on EVERY event. Runs for Stop /
		// SessionEnd too — that's what captures a turn's final assistant message,
		// which fires no PreToolUse. Best-effort / fail-open (never throws).
		captureTimeline(event, CWD);

		syncRuntimeIn();
		try {
			// Lifecycle events (SessionStart / SessionEnd / Stop / Subagent* /
			// Skill* / UserPromptSubmit): a non-null decision is an early return,
			// null means fall through to the Pre/Post evaluation path.
			const lifecycleDecision = await handleLifecycleEvent(ctx, event, session);
			// Shadow-eval lifecycle events too (Stop carries the obligation-ledger
			// inventory). Metric-only: appends warnings, never alters the decision.
			if (lifecycleDecision) { mergeTrajectoryShadow(event, lifecycleDecision, ctx.rules); return lifecycleDecision; }

			// Evaluate based on hook type
			if (isPreToolUse(event)) {
				const local = await runPreToolPipeline(ctx, event, session);
				mergeTrajectoryShadow(event, local, ctx.rules);
				writeCollectionRecord(event, local);
				return forwardCloudPreToolUse(event, local);
			}

			if (isPostToolUse(event)) {
				try {
					const decision = await runPostToolPipeline(ctx, event, session);
					mergeTrajectoryShadow(event, decision, ctx.rules);
					writeCollectionRecord(event, decision);
					// Fire-and-forget faithful per-call record for the viz BASELINE filmstrip.
					// Runs AFTER the decision is returned to the hook — never blocks the tool loop.
					appendCheckResults(CWD, event, decision);
					return decision;
				} catch (postErr) {
					// PostToolUse runs AFTER the tool — the action already happened, so
					// a thrown observability/quality check must NEVER become a block. A
					// reason-less block here was surfacing to the user as a spurious
					// "harness bug". Fail OPEN (feedback_safety_continuity) and report
					// the skipped check as a non-blocking warning.
					log(
						`PostToolUse pipeline threw (failing open): ${
							postErr instanceof Error ? postErr.message : String(postErr)
						}`,
					);
					return {
						decision: "allow",
						warnings: ["[interlinked] a PostToolUse check errored and was skipped (fail-open)."],
					};
				}
			}

			// Non-tool events (lifecycle, notifications, etc.) — always allow
			return { decision: "allow" };
		} finally {
			syncRuntimeOut();
		}
	}

	async function evaluateEventLine(
		line: string,
		protocol: "raw" | "framed",
	): Promise<HarnessDecision> {
		// Parse session_id once up-front so the durability finally block can run
		// even when `processEvent` throws — the session was already created (or
		// hydrated) by the time recordEvent ran, so a snapshot is safe to write.
		let sessionIdForSnap: string | null = null;
		try {
			const parsed: JsonObject = JSON.parse(line);
			if (typeof parsed.session_id === "string") sessionIdForSnap = parsed.session_id;
		} catch (e) {
			void e;
		}

		try {
			const decision = await processEvent(line);
			recordProtocolEvent(protocol);
			try {
				appendLatencyLog(INTERLINKED_DIR, buildLatencyRecord(line, decision));
			} catch (e) {
				void e;
			}
			return decision;
		} finally {
			// Per-event durability: write the live snapshot AFTER processEvent so
			// the snapshot reflects every post-event state mutation — PostToolUse
			// handlers updating `tdd_cycles`, `assertion_counts`, `active_skills`,
			// etc. The earlier "snapshot right after recordEvent" placement lost
			// those mutations on a daemon restart between events. Best-effort:
			// write failures are logged but never block the decision return.
			if (sessionIdForSnap) {
				try {
					const snap = sessions.serialize(sessionIdForSnap);
					if (snap) {
						const writeResult = writeLiveSnapshot(CWD, sessionIdForSnap, snap);
						if (!writeResult.ok) {
							log(`Live snapshot write failed (non-fatal): ${writeResult.error.message}`);
						}
					}
				} catch (e) {
					log(`Live snapshot write threw: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
	}

	async function evaluateUnifiedViaRuntime(event: UnifiedHookEvent): Promise<HarnessDecision> {
		try {
			const legacyEvent = toLegacyHarnessEvent(event);
			return await evaluateEventLine(JSON.stringify(legacyEvent), "framed");
		} catch (err) {
			protocolStatus.framed_error_count++;
			writeProtocolStatus();
			throw err;
		}
	}

	return { evaluateEventLine, evaluateUnifiedViaRuntime, writeProtocolStatus };
}
