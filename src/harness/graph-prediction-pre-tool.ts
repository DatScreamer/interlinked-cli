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

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	classifyCase,
	type CaseResult,
	type GraphPredictionCase,
	workspaceSupermodelActive,
} from "./graph-prediction-classifier.js";
import {
	appendObservationRow,
	appendPredictionRow,
	appendReconciliationRow,
	findPredictionRow,
	type GraphReconciliationRow,
	type ReconciliationSummary,
} from "./graph-prediction-cache.js";
import {
	parseBarePrediction,
	type ParsedGraphPrediction,
} from "./graph-prediction-parser.js";
import { reconcile, type SeverityResult } from "./graph-prediction-reconcile.js";
import { isFileWrite } from "./evaluator/tool-classifiers.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import { loadGraphForFile, type SupermodelGraph } from "./supermodel-graph.js";
import type { HarnessEvent } from "./types.js";

export type GraphPredictionMode = "shadow" | "soft_gate" | "enforced";

const E_FRESH: GraphPredictionCase = "E-fresh";
const MODE_SHADOW: GraphPredictionMode = "shadow";
const MODE_ENFORCED: GraphPredictionMode = "enforced";
const ACK_REQUIRED = "ack_required" as const;
const SENTINEL_BASE = join(".interlinked", "predictions", "incoming");
const SENTINEL_ACK_BASE = join(".interlinked", "predictions", "ack");

export interface DriveArgs {
	event: HarnessEvent;
	cwd: string;
	mode: GraphPredictionMode;
}

export interface DriveResult {
	decision: "block" | "allow";
	reason?: string;
	additional_context?: string;
	observation?: { file_path: string; case: GraphPredictionCase };
	severity?: SeverityResult;
}

export function driveGraphPrediction(args: DriveArgs): DriveResult | null {
	const { event, cwd, mode } = args;

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
	const reconciled = reconcileEachTarget(cwd, eFreshTargets, predictionsByPath);
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

/** Pretty-print the "you must Read the shard" block reason. One line per
 *  flagged target so the agent can grep `Read <path>` for each. */
function buildShardReadRequiredReason(needsRead: CaseResult[]): string {
	const lines: string[] = [
		"[interlinked:graph-pred] Read the oracle shard before this Edit can proceed.",
		"Enforced mode requires the agent to actually consume the .graph.* file so its mental model updates from the source of truth, not just the diff summary.",
		"",
		"Call the Read tool on each shard listed below, then retry the Edit:",
	];
	for (const c of needsRead) {
		if (c.shardPath) lines.push(`  Read ${c.shardPath}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Sentinel-path submission
// ============================================================================

interface SentinelMatch {
	sessionId: string;
	absPath: string;
}

/** Match `.interlinked/predictions/incoming/<session_id>/<slug>.yaml` (or
 *  `.yml`). Returns the session_id captured from the path so the persisted
 *  cache row can use the same session as the submission. */
function parseSentinelPath(filePath: string, cwd: string): SentinelMatch | null {
	if (!filePath) return null;
	const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const expectedPrefix = resolve(cwd, SENTINEL_BASE);
	if (!abs.startsWith(`${expectedPrefix}/`)) return null;
	const rel = relative(expectedPrefix, abs);
	const m = rel.match(/^([^/]+)\/[^/]+\.ya?ml$/);
	if (!m) return null;
	return { sessionId: m[1], absPath: abs };
}

/** Match `.interlinked/predictions/ack/<session_id>/<slug>.yaml`. Same
 *  shape as parseSentinelPath but for the ack sub-tree. The ack writer
 *  is how the agent breaks out of `enforced`-mode ack_required blocks. */
function parseSentinelAckPath(filePath: string, cwd: string): SentinelMatch | null {
	if (!filePath) return null;
	const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
	const expectedPrefix = resolve(cwd, SENTINEL_ACK_BASE);
	if (!abs.startsWith(`${expectedPrefix}/`)) return null;
	const rel = relative(expectedPrefix, abs);
	const m = rel.match(/^([^/]+)\/[^/]+\.ya?ml$/);
	if (!m) return null;
	return { sessionId: m[1], absPath: abs };
}

interface ParsedAckSubmission {
	file: string;
	acknowledged_triggers: string[];
	parse_error?: string;
}

/** Minimal block-style YAML parser for the ack submission shape:
 *    graph_prediction_ack:
 *      file: <path>
 *      acknowledged_triggers:
 *        - <name>
 *        - <name>
 *  Returns parse_error when the top key is missing or the file field is
 *  absent. Empty `acknowledged_triggers` is allowed (the agent may
 *  acknowledge the reveal without listing triggers explicitly — the act
 *  of writing the ack file is itself the acknowledgement). */
function parseAckSubmission(yaml: string): ParsedAckSubmission {
	if (!yaml.includes("graph_prediction_ack:")) {
		return { file: "", acknowledged_triggers: [], parse_error: "missing `graph_prediction_ack:` top-level key" };
	}
	const lines = yaml.split("\n");
	let inAck = false;
	let inTriggers = false;
	let file = "";
	const triggers: string[] = [];
	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		if (/^\s*#/.test(line)) continue;
		if (/^graph_prediction_ack:\s*$/.test(line)) {
			inAck = true;
			inTriggers = false;
			continue;
		}
		if (!inAck) continue;
		if (/^\S/.test(line)) {
			inAck = false;
			inTriggers = false;
			continue;
		}
		const fileMatch = line.match(/^\s+file:\s*(.+?)\s*$/);
		if (fileMatch) {
			file = fileMatch[1].replace(/^["']|["']$/g, "");
			inTriggers = false;
			continue;
		}
		if (/^\s+acknowledged_triggers:\s*$/.test(line)) {
			inTriggers = true;
			continue;
		}
		if (inTriggers) {
			const itemMatch = line.match(/^\s+-\s+(.+?)\s*$/);
			if (itemMatch) triggers.push(itemMatch[1].replace(/^["']|["']$/g, ""));
			else if (/^\s+\S/.test(line)) inTriggers = false;
		}
	}
	if (!file) {
		return { file: "", acknowledged_triggers: triggers, parse_error: "missing `file:` field" };
	}
	return { file, acknowledged_triggers: triggers };
}

function handleAckSubmission(event: HarnessEvent, cwd: string, sentinel: SentinelMatch): DriveResult {
	const content = typeof event.tool_input?.content === "string" ? event.tool_input.content : "";
	if (!content) {
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred][ack] Sentinel-path ack submission is empty. " +
				"Write the bare YAML (graph_prediction_ack: with `file:` + `acknowledged_triggers:`) as the file content.",
		};
	}
	const parsed = parseAckSubmission(content);
	if (parsed.parse_error) {
		return {
			decision: "block",
			reason: `[interlinked:graph-pred][ack] Ack submission did not parse: ${parsed.parse_error}.`,
		};
	}
	const absTarget = isAbsolute(parsed.file) ? resolve(parsed.file) : resolve(cwd, parsed.file);
	const classification = classifyCase(absTarget, cwd);
	if (classification.case !== E_FRESH) {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred][ack] Ack target ${parsed.file} classifies as Case ${classification.case}, ` +
				"not E-fresh. Only E-fresh files participate in the ack protocol.",
		};
	}
	if (!classification.shardPath || !classification.sourceMtime || !classification.shardMtime) {
		return {
			decision: "block",
			reason: `[interlinked:graph-pred][ack] Could not resolve shard metadata for ${parsed.file}.`,
		};
	}
	// Look up the most recent prediction row that this ack is for, so we
	// can carry forward its prediction content and just stamp the ack
	// fields. Without the prior row the ack would be free-floating.
	const priorRow = findPredictionRow(cwd, {
		session_id: sentinel.sessionId,
		file_path: classification.sourcePath,
		source_mtime: classification.sourceMtime,
		shard_mtime: classification.shardMtime,
	});
	if (!priorRow) {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred][ack] No prior prediction found for ${classification.sourcePath} ` +
				"in this session at the current source/shard mtimes. Submit the prediction first.",
		};
	}

	const ackText = parsed.acknowledged_triggers.length > 0
		? `triggers: ${parsed.acknowledged_triggers.join(", ")}`
		: "acknowledged";
	appendPredictionRow(cwd, {
		...priorRow,
		emitted_at: event.timestamp || new Date().toISOString(),
		ack_required: true,
		ack_text: ackText,
		acknowledged_at: event.timestamp || new Date().toISOString(),
	});
	return {
		decision: "allow",
		additional_context:
			`[interlinked:graph-pred][ack] Acknowledgement for ${classification.sourcePath} accepted` +
			(parsed.acknowledged_triggers.length > 0
				? ` (${parsed.acknowledged_triggers.join(", ")}).`
				: ".") +
			" You can now retry the original Edit.",
	};
}

function handleSentinelSubmission(event: HarnessEvent, cwd: string): DriveResult | null {
	const filePath = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: "";
	const sentinel = parseSentinelPath(filePath, cwd);
	if (!sentinel) return null;

	const content = typeof event.tool_input?.content === "string" ? event.tool_input.content : "";
	if (!content || !content.includes("graph_prediction:")) {
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred] Sentinel-path submission must contain a `graph_prediction:` block. " +
				"Write the bare YAML (no fences needed) as the file content.",
		};
	}

	const parsed = parseBarePrediction(content);
	if (parsed.parse_status === "parse_failed") {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred] Prediction did not parse: ${parsed.parse_error}. ` +
				"Re-write the submission with corrected YAML.",
		};
	}
	if (!parsed.file) {
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred] Prediction is missing the `file:` field — needed so the harness can " +
				"match this submission to the target edit.",
		};
	}

	const absTarget = isAbsolute(parsed.file) ? resolve(parsed.file) : resolve(cwd, parsed.file);
	const classification = classifyCase(absTarget, cwd);
	if (classification.case !== E_FRESH) {
		return {
			decision: "block",
			reason:
				`[interlinked:graph-pred] Prediction target ${parsed.file} classifies as Case ${classification.case}, ` +
				"not E-fresh. Only E-fresh files (source exists + fresh shard colocated) need predictions. " +
				"If you intended to edit a different file, retry the Edit and the harness will tell you which file is in scope.",
		};
	}
	if (!classification.shardPath || !classification.sourceMtime || !classification.shardMtime) {
		return {
			decision: "block",
			reason: `[interlinked:graph-pred] Could not resolve shard metadata for ${parsed.file}.`,
		};
	}

	appendPredictionRow(cwd, {
		session_id: sentinel.sessionId,
		file_path: classification.sourcePath,
		source_mtime: classification.sourceMtime,
		shard_mtime: classification.shardMtime,
		shard_path: classification.shardPath,
		emitted_at: event.timestamp || new Date().toISOString(),
		tool_input_hash: "",
		case: "E-fresh",
		prediction: {
			deps: parsed.deps,
			calls: parsed.calls,
			impact: parsed.impact,
		},
		comparison_status: parsed.parse_status === "format_violation" ? "parse_failed" : "pending",
	});

	const ackParts: string[] = [
		`[interlinked:graph-pred] Prediction for ${classification.sourcePath} accepted.`,
	];
	if (parsed.parse_status === "format_violation") {
		ackParts.push(
			`Format violation noted (${parsed.parse_error ?? "exceeded entry cap"}); the prediction was persisted but the format is non-conforming.`,
		);
	}
	ackParts.push("You can now retry the original Edit; the cache will be consulted.");

	return {
		decision: "allow",
		additional_context: ackParts.join("\n"),
	};
}

// ============================================================================
// Core flow helpers
// ============================================================================

function collectCachedPredictions(
	cwd: string,
	sessionId: string,
	targets: CaseResult[],
): Map<string, ParsedGraphPrediction> {
	const map = new Map<string, ParsedGraphPrediction>();
	for (const t of targets) {
		if (!t.shardPath || !t.sourceMtime || !t.shardMtime) continue;
		const row = findPredictionRow(cwd, {
			session_id: sessionId,
			file_path: t.sourcePath,
			source_mtime: t.sourceMtime,
			shard_mtime: t.shardMtime,
		});
		if (!row) continue;
		// Honor comparison_status persisted at submission time. A row with
		// `parse_failed` came from `handleSentinelSubmission` flagging a
		// format violation (e.g. exceeded the 50-entry cap). Carrying that
		// state forward as `parse_status: "format_violation"` lets the driver
		// re-block with a specific "narrow your prediction" message instead
		// of silently reconciling a non-conforming submission.
		const cachedStatus =
			row.comparison_status === "parse_failed" ? "format_violation" : "ok";
		map.set(t.sourcePath, {
			file: row.file_path,
			deps: row.prediction.deps,
			calls: row.prediction.calls,
			impact: row.prediction.impact,
			parse_status: cachedStatus,
		});
	}
	return map;
}

interface ReconciledTarget {
	classification: CaseResult;
	severity: SeverityResult;
	oracle: SupermodelGraph | null;
}

function reconcileEachTarget(
	cwd: string,
	targets: CaseResult[],
	predictionsByPath: Map<string, ParsedGraphPrediction>,
): ReconciledTarget[] {
	const out: ReconciledTarget[] = [];
	for (const target of targets) {
		const prediction = predictionsByPath.get(target.sourcePath);
		if (!prediction) continue;
		const oracle = loadGraphForFile(target.sourcePath, cwd);
		if (!oracle) continue;
		const severity = reconcile({ prediction, oracle });
		out.push({ classification: target, severity, oracle });
	}
	return out;
}

interface BuildReconciliationArgs {
	sessionId: string;
	classification: CaseResult;
	prediction: ParsedGraphPrediction;
	severity: SeverityResult;
	oracle: SupermodelGraph | null;
	reconciledAt: string;
}

function summarizeOracle(oracle: SupermodelGraph | null): ReconciliationSummary {
	if (!oracle) {
		return {
			risk: "unknown",
			direct: "unknown",
			transitive: "unknown",
			domains_count: 0,
			importers_count: 0,
			callers_count: 0,
		};
	}
	return {
		risk: oracle.impact?.risk ?? "unknown",
		direct: oracle.impact?.direct ?? "unknown",
		transitive: oracle.impact?.transitive ?? "unknown",
		domains_count: oracle.impact?.domains.length ?? 0,
		importers_count: oracle.deps?.importedBy.length ?? 0,
		callers_count: oracle.calls?.callers.length ?? 0,
	};
}

function summarizePrediction(p: ParsedGraphPrediction): ReconciliationSummary {
	const domains = p.impact?.domains;
	const imported_by = p.deps?.imported_by;
	const callers = p.calls?.callers;
	return {
		risk: p.impact?.risk ?? "unknown",
		direct: p.impact?.direct ?? "unknown",
		transitive: p.impact?.transitive ?? "unknown",
		domains_count: Array.isArray(domains) ? domains.length : 0,
		importers_count: Array.isArray(imported_by) ? imported_by.length : 0,
		callers_count: Array.isArray(callers) ? callers.length : 0,
	};
}

function buildReconciliationRow(args: BuildReconciliationArgs): GraphReconciliationRow {
	return {
		session_id: args.sessionId,
		file_path: args.classification.sourcePath,
		source_mtime: args.classification.sourceMtime ?? "",
		shard_mtime: args.classification.shardMtime ?? "",
		reconciled_at: args.reconciledAt,
		severity: args.severity.severity,
		decision: args.severity.decision,
		triggers: args.severity.triggers,
		high_impact_oracle: args.severity.high_impact_oracle,
		per_section_score: args.severity.per_section_score,
		weighted_avg: args.severity.weighted_avg,
		oracle_summary: summarizeOracle(args.oracle),
		prediction_summary: summarizePrediction(args.prediction),
		miss_set: args.severity.miss_set,
	};
}

function slugFor(targetPath: string): string {
	const base = targetPath.split("/").pop() ?? "target";
	// Strip .ext and any extra dots, keep only safe chars
	return base.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_") || "target";
}

function buildChallengeReason(
	missing: CaseResult[],
	all: CaseResult[],
	sessionId: string,
	cwd: string,
): string {
	const sentinelDir = relative(cwd, resolve(cwd, SENTINEL_BASE, sessionId)) || SENTINEL_BASE;
	const lines: string[] = [];
	lines.push("[interlinked:graph-pred] graph_prediction required before this edit can proceed.");
	lines.push("");
	lines.push("Authoritative oracle (Supermodel `.graph.*` shard, fresh) for:");
	for (const m of missing) {
		const slug = slugFor(m.sourcePath);
		lines.push(`  ${m.sourcePath}`);
		lines.push(`    → submit prediction by writing to: ${sentinelDir}/${slug}.yaml`);
	}
	const informational = all.filter((c) => c.case !== E_FRESH);
	if (informational.length > 0) {
		lines.push("");
		lines.push("Other files in this edit are observation-only (no challenge):");
		for (const i of informational) {
			lines.push(`  ${i.sourcePath} (Case ${i.case})`);
		}
	}
	lines.push("");
	lines.push("Use the Write tool. Bare YAML; no fences needed. Format:");
	lines.push("  graph_prediction:");
	lines.push("    file: <absolute or repo-relative path to the edit target>");
	lines.push("    deps:");
	lines.push("      imports: [<paths>] | unknown");
	lines.push("      imported_by: [<paths>] | unknown");
	lines.push("    calls:");
	lines.push("      callers: [<\"fn ← caller\">] | unknown");
	lines.push("      callees: [<\"fn → callee\">] | unknown");
	lines.push("    impact:");
	lines.push("      risk: low | medium | high | unknown");
	lines.push("      domains: [<strings>] | unknown");
	lines.push("      direct: <int> | unknown");
	lines.push("      transitive: <int> | unknown");
	lines.push("      affects: [<paths>] | unknown");
	lines.push("");
	lines.push("After the Write succeeds, retry the original edit. See");
	lines.push("`docs/design/graph-prediction-protocol.md §6` for full format spec.");
	return lines.join("\n");
}

function buildAckReason(flagged: ReconciledTarget[]): string {
	const lines: string[] = [];
	lines.push("[interlinked:graph-pred] Acknowledge before proceeding.");
	for (const f of flagged) {
		const triggers = f.severity.triggers.join(", ");
		lines.push(`  ${f.classification.sourcePath}: ${triggers}`);
	}
	return lines.join("\n");
}

/** Per-target write-to-sentinel-path instruction used by the ack flow.
 *  Returned text is appended after `buildAckReason`'s summary, giving the
 *  agent a concrete path + minimal YAML template per flagged file. */
function buildAckSentinelInstruction(flagged: ReconciledTarget[], sessionId: string): string {
	const lines: string[] = ["", "To acknowledge, Write the bare YAML below to the named sentinel path (one Write per flagged file):"];
	for (const f of flagged) {
		const slug = basename(f.classification.sourcePath).replace(/\.[^./]+$/, "");
		const ackPath = `.interlinked/predictions/ack/${sessionId}/${slug}.yaml`;
		lines.push("");
		lines.push(`  → ${ackPath}`);
		lines.push("    graph_prediction_ack:");
		lines.push(`      file: ${f.classification.sourcePath}`);
		lines.push("      acknowledged_triggers:");
		for (const t of f.severity.triggers) {
			lines.push(`        - ${t}`);
		}
	}
	lines.push("");
	lines.push("After all acks land, retry the original Edit. See `docs/design/graph-prediction-protocol.md §7.6`.");
	return `\n${lines.join("\n")}`;
}

function buildRevealText(reconciled: ReconciledTarget[]): string {
	const lines: string[] = [];
	for (const r of reconciled) {
		lines.push(`[interlinked:graph-pred] Comparison for ${r.classification.sourcePath}:`);
		for (const [section, score] of Object.entries(r.severity.per_section_score)) {
			lines.push(`  ${section}: ${(score as number).toFixed(2)}`);
		}
		if (r.severity.triggers.length > 0) {
			lines.push(`  triggers: ${r.severity.triggers.join(", ")}`);
		}
		lines.push(`  weighted_avg (telemetry): ${r.severity.weighted_avg.toFixed(2)}`);
		lines.push(`  severity: ${r.severity.severity}`);
	}
	return lines.join("\n");
}

// ============================================================================
// Option A — explicit-Read gate (enforced mode)
// ============================================================================
// `enforced` mode requires the agent to actually call `Read` on the oracle
// shard before the retry Edit can land. Two pieces:
//   1. `isReadOfShard` + `recordShardRead` intercept Read tool calls that
//      target a Supermodel shard path, find the matching prediction row for
//      this session, and stamp `shard_read_at` on a new row (last-write-wins).
//   2. `shardReadPending` checks, just before the soft_gate/enforced "allow"
//      branch, whether the current edit target has a prediction row whose
//      `shard_read_at` is set. If not, block with a "read the shard first"
//      reason.
// Soft_gate uses Option B (inline shard bytes); enforced uses Option A (force
// the action + audit trail). See `docs/design/graph-prediction-protocol.md`.

const SHARD_PATH_RE = /\.graph(\.[a-zA-Z0-9]+)?$/i;

function isReadOfShard(event: HarnessEvent): boolean {
	const name = event.tool_name;
	if (name !== "Read" && name !== "ReadFile" && name !== "read_file" && name !== "view") {
		return false;
	}
	const fp = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: typeof event.tool_input?.path === "string"
			? event.tool_input.path
			: "";
	return typeof fp === "string" && SHARD_PATH_RE.test(fp);
}

function recordShardRead(event: HarnessEvent, cwd: string): DriveResult | null {
	const fp = typeof event.tool_input?.file_path === "string"
		? event.tool_input.file_path
		: typeof event.tool_input?.path === "string"
			? event.tool_input.path
			: "";
	if (!fp) return null;
	const shardAbs = isAbsolute(fp) ? resolve(fp) : resolve(cwd, fp);
	// Derive the paired source path: strip `.graph` from the extension stem.
	const m = shardAbs.match(/^(.+?)\.graph(\.[a-zA-Z0-9]+)?$/);
	if (!m) return null;
	const sourceAbs = m[1] + (m[2] ?? "");
	const classification = classifyCase(sourceAbs, cwd);
	if (classification.case !== E_FRESH) return null;
	if (!classification.shardPath || !classification.sourceMtime || !classification.shardMtime) {
		return null;
	}
	const priorRow = findPredictionRow(cwd, {
		session_id: event.session_id,
		file_path: classification.sourcePath,
		source_mtime: classification.sourceMtime,
		shard_mtime: classification.shardMtime,
	});
	if (!priorRow) return null;
	if (priorRow.shard_read_at) return null;
	const now = event.timestamp || new Date().toISOString();
	appendPredictionRow(cwd, { ...priorRow, emitted_at: now, shard_read_at: now });
	return {
		decision: "allow",
		additional_context:
			`[interlinked:graph-pred] Shard read recorded for ${classification.sourcePath}. ` +
			"You can now retry the Edit; the enforced-mode shard-read gate is satisfied.",
	};
}

/** Soft-gate-only "Option B" reveal augmentation: append the oracle shard
 *  bytes after the comparison so the agent updates its mental model from
 *  the source of truth, not just the score summary. A 0.00 on
 *  `deps.imported_by` tells the agent it missed callers; only the shard
 *  tells it who the callers are. Capped at SHARD_BYTES_CAP so a pathological
 *  shard can't blow up the model context.
 *
 *  In `enforced` mode the agent is required to actually call `Read` on the
 *  shard path (Option A), so this inline append is skipped — forcing the
 *  pedagogic action creates an audit trail and avoids redundant context. */
const SHARD_BYTES_CAP = 4096;

function buildShardInlineText(reconciled: ReconciledTarget[]): string {
	const lines: string[] = [];
	for (const r of reconciled) {
		const shardPath = r.classification.shardPath;
		if (!shardPath) continue;
		let body: string;
		try {
			body = readFileSync(shardPath, "utf-8");
		} catch {
			continue;
		}
		const truncated = body.length > SHARD_BYTES_CAP
			? `${body.slice(0, SHARD_BYTES_CAP)}\n... (truncated at ${SHARD_BYTES_CAP} bytes; read the file directly for full contents)`
			: body;
		lines.push("");
		lines.push(`[interlinked:graph-pred] Oracle shard for ${r.classification.sourcePath} (${shardPath}):`);
		lines.push(truncated.trimEnd());
	}
	return lines.join("\n");
}
