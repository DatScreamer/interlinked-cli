// ===========================================
// Graph-prediction PreToolUse driver
// ===========================================
// Three modes (per `docs/design/graph-prediction-protocol.md`):
//
//   shadow    — never blocks; logs case observations only. Used to fill
//               cache and gather telemetry without disrupting users.
//
//   soft_gate — blocks once on first encounter of an E-fresh file with no
//               cached prediction (Fire 1: challenge). Reveals diff and
//               allows on retry (Fire 2), regardless of severity.
//
//   enforced  — soft_gate + ack-required (Fire 3) for high-severity
//               misses or full-abstention against high-impact oracle.
//
// Cases A/B/C/D/E-stale are observation-only in every mode — only Case
// E-fresh activates the predict/reveal/reconcile loop.
//
// Prediction submission goes through a sentinel path under
// `.interlinked/predictions/incoming/<session_id>/<slug>.yaml`. Agent
// writes the YAML there via the Write tool; this driver intercepts on
// PreToolUse, parses synchronously, persists to graph-predictions.jsonl,
// and returns specific parse errors. The agent's Edit retry then hits
// the disk cache deterministically. Replaces an earlier transcript-
// parsing fallback that was fragile in practice (fences could be stripped
// in display layers, transcript timing lagged the retry).
//
// The driver returns null when the event is out of scope (non-write
// tool, no Supermodel-active workspace) so callers can fall through to
// the rest of pre-tool.ts unchanged.

import {
	classifyCase,
	type GraphPredictionCase,
	workspaceSupermodelActive,
} from "./graph-prediction-classifier.js";
import {
	appendReconciliationRow,
	findPredictionRow,
} from "./graph-prediction-cache.js";
import type { SeverityResult } from "./graph-prediction-reconcile.js";
import { isFileWrite } from "./evaluator/tool-classifiers.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import { appendObservationRow } from "./graph-prediction-cache.js";
import type { ProjectGraph } from "./project-graph.js";
import type { HarnessEvent } from "./types.js";

// Sentinel handlers
import {
	parseSentinelAckPath,
	handleAckSubmission,
	handleSentinelSubmission,
} from "./graph-prediction-sentinels.js";

// Flow helpers
import {
	collectCachedPredictions,
	reconcileEachTarget,
	buildReconciliationRow,
	buildChallengeReason,
	buildAckReason,
	buildAckSentinelInstruction,
	buildRevealText,
	buildShardReadRequiredReason,
	buildShardInlineText,
	isReadOfShard,
	recordShardRead,
	type ReconciledTarget,
} from "./graph-prediction-flow.js";

export type GraphPredictionMode = "shadow" | "soft_gate" | "enforced";

const E_FRESH: GraphPredictionCase = "E-fresh";
const MODE_SHADOW: GraphPredictionMode = "shadow";
const MODE_ENFORCED: GraphPredictionMode = "enforced";
const ACK_REQUIRED = "ack_required" as const;

export interface DriveArgs {
	event: HarnessEvent;
	cwd: string;
	mode: GraphPredictionMode;
	/** The harness's in-memory ProjectGraph, threaded from the PreToolUse
	 *  evaluator. Lets the reconciler fall back to the internal dependency
	 *  oracle when no fresh Supermodel shard exists. Optional: when absent,
	 *  only shard-backed (Case E-fresh) targets get an oracle. */
	graph?: ProjectGraph | undefined;
}

export interface DriveResult {
	decision: "block" | "allow";
	reason?: string | undefined;
	additional_context?: string | undefined;
	observation?: { file_path: string; case: GraphPredictionCase } | undefined;
	severity?: SeverityResult | undefined;
}

export function driveGraphPrediction(args: DriveArgs): DriveResult | null {
	const { event, cwd, mode, graph } = args;

	// Enforced-mode "Option A" shard-read tracking. The Read tool itself is
	// NOT a file write — handle it before the isFileWrite() gate so reads
	// of `.graph.*` files for which there's a pending prediction get
	// recorded as satisfying the read requirement.
	if (isReadOfShard(event)) {
		const recorded = recordShardRead(event, cwd);
		if (recorded) return recorded;
		// Read of a non-protocol shard or unmatched session — pass through.
		return null;
	}

	if (!isFileWrite(event.tool_name)) return null;

	// Sentinel-path branches: the agent submits structured artifacts by
	// writing to fixed paths under `.interlinked/predictions/`. Two shapes:
	//   - `incoming/<session>/<slug>.yaml`  → graph_prediction submission
	//   - `ack/<session>/<slug>.yaml`       → graph_prediction_ack submission
	// Ack path is checked first so an ack submission doesn't get rejected
	// by the prediction parser for missing a `graph_prediction:` key.
	const ackFilePath = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: "";
	const ackSentinel = parseSentinelAckPath(ackFilePath, cwd);
	if (ackSentinel) return handleAckSubmission(event, cwd, ackSentinel);

	const submission = handleSentinelSubmission(event, cwd);
	if (submission) return submission;

	if (!workspaceSupermodelActive(cwd)) return null;

	const editedPaths = extractAllEditedFilePaths(event);
	if (editedPaths.length === 0) return null;

	const classifications = editedPaths.map((p) =>
		classifyCase(p, cwd, {
			toolInputContent:
				typeof event.tool_input?.content === "string" ? event.tool_input.content : undefined,
		}),
	);

	// Always emit observation rows — telemetry for non-E-fresh + E-fresh.
	for (const c of classifications) {
		appendObservationRow(cwd, {
			session_id: event.session_id,
			file_path: c.sourcePath,
			case: c.case,
			tool_input_hash: "",
			emitted_at: event.timestamp,
		});
	}

	const eFreshTargets = classifications.filter((c) => c.case === E_FRESH);

	// Shadow mode: log observation, allow.
	if (mode === MODE_SHADOW) {
		return {
			decision: "allow",
			observation:
				classifications.length > 0
					? { file_path: classifications[0].sourcePath, case: classifications[0].case }
					: undefined,
		};
	}

	// soft_gate / enforced: only E-fresh activates the protocol.
	if (eFreshTargets.length === 0) {
		return {
			decision: "allow",
			observation:
				classifications.length > 0
					? { file_path: classifications[0].sourcePath, case: classifications[0].case }
					: undefined,
		};
	}

	const predictionsByPath = collectCachedPredictions(cwd, event.session_id, eFreshTargets);
	const missingTargets = eFreshTargets.filter((c) => !predictionsByPath.has(c.sourcePath));
	if (missingTargets.length > 0) {
		return {
			decision: "block",
			reason: buildChallengeReason(missingTargets, classifications, event.session_id, cwd),
			observation: { file_path: missingTargets[0].sourcePath, case: E_FRESH },
		};
	}

	// Re-block when a cached prediction violated format constraints at submit
	// time (e.g. exceeded the 50-entry cap). Silently reconciling a
	// non-conforming submission would teach the agent that hitting the cap is
	// fine — it isn't. Ask for a narrower top-K or explicit `unknown`.
	const formatViolationTargets = eFreshTargets.filter((c) => {
		const p = predictionsByPath.get(c.sourcePath);
		return p?.parse_status === "format_violation";
	});
	if (formatViolationTargets.length > 0) {
		const first = formatViolationTargets[0];
		const slug = basename(first.sourcePath).replace(/\.[^./]+$/, "");
		const reason = [
			`[interlinked:graph-pred] Cached prediction for ${first.sourcePath} violated the format contract (per-section entry cap is 50).`,
			"Narrow your prediction to the entries that matter most, or use `unknown` for any list you can't bound.",
			`Re-submit by writing to .interlinked/predictions/incoming/${event.session_id}/${slug}.yaml`,
		].join("\n");
		return {
			decision: "block",
			reason,
			observation: { file_path: first.sourcePath, case: E_FRESH },
		};
	}

	// All E-fresh files have predictions — reconcile each.
	const reconciled = reconcileEachTarget(cwd, eFreshTargets, predictionsByPath, graph);
	const reconciledAt = event.timestamp || new Date().toISOString();
	for (const r of reconciled) {
		const prediction = predictionsByPath.get(r.classification.sourcePath);
		if (!prediction) continue;
		appendReconciliationRow(
			cwd,
			buildReconciliationRow({
				sessionId: event.session_id,
				classification: r.classification,
				prediction,
				severity: r.severity,
				oracle: r.oracle,
				reconciledAt,
			}),
		);
	}
	const flagged = reconciled.filter((r) => r.severity.decision === ACK_REQUIRED);

	if (mode === MODE_ENFORCED && flagged.length > 0) {
		// Drop targets the agent has already acknowledged via sentinel-path
		// ack submission. Without this, `enforced` mode would loop forever:
		// the cached prediction stays the same, reconciliation stays the
		// same, and the ack_required severity keeps re-firing on retry.
		const flaggedNotAcked = flagged.filter((r) => {
			if (!r.classification.sourceMtime || !r.classification.shardMtime) return true;
			const row = findPredictionRow(cwd, {
				session_id: event.session_id,
				file_path: r.classification.sourcePath,
				source_mtime: r.classification.sourceMtime,
				shard_mtime: r.classification.shardMtime,
			});
			return !row?.acknowledged_at;
		});
		if (flaggedNotAcked.length > 0) {
			return {
				decision: "block",
				reason: buildAckReason(flaggedNotAcked) + buildAckSentinelInstruction(flaggedNotAcked, event.session_id),
				additional_context: buildRevealText(reconciled),
				observation: { file_path: flaggedNotAcked[0].classification.sourcePath, case: E_FRESH },
			};
		}
	}

	// Enforced-mode "Option A" shard-read gate. After reconciliation has
	// produced the comparison, the agent must call Read on each E-fresh
	// target's oracle shard before the retry Edit can land. The first
	// reveal carries the diff; the agent then reads the shard; the gate
	// clears (via `shard_read_at` on the row); the next retry proceeds.
	if (mode === MODE_ENFORCED) {
		const needsRead = eFreshTargets.filter((c) => {
			if (!c.sourceMtime || !c.shardMtime) return false;
			const row = findPredictionRow(cwd, {
				session_id: event.session_id,
				file_path: c.sourcePath,
				source_mtime: c.sourceMtime,
				shard_mtime: c.shardMtime,
			});
			return !row?.shard_read_at;
		});
		if (needsRead.length > 0) {
			return {
				decision: "block",
				reason: buildShardReadRequiredReason(needsRead),
				additional_context: buildRevealText(reconciled),
				observation: { file_path: needsRead[0].sourcePath, case: E_FRESH },
			};
		}
	}

	// Build the reveal text. In soft_gate mode, append the oracle shard bytes
	// inline (Option B) so the agent updates its mental model from the
	// source of truth without an extra tool call. In enforced mode the
	// shard contents are surfaced via the explicit-Read gate (Option A)
	// above, so the inline append is skipped to avoid redundant context.
	const reveal = mode === MODE_ENFORCED
		? buildRevealText(reconciled)
		: buildRevealText(reconciled) + buildShardInlineText(reconciled);

	return {
		decision: "allow",
		additional_context: reveal,
		observation: { file_path: eFreshTargets[0].sourcePath, case: E_FRESH },
	};
}

// ── Re-exports for consumers that imported from this module ──────────────────
// These keep the public API surface identical after the extraction.
export type { ReconciledTarget };

// basename is used locally above — bring it in
import { basename } from "node:path";
