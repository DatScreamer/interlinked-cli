// ===========================================
// agent-io capture surfaces
// ===========================================
// Three seams, each fail-open and best-effort (feedback_safety_continuity):
//
//   PreToolUse on a spawn tool  → the INPUT, at the only moment it exists on
//                                 the wire. This is the capture point that was
//                                 missing entirely: `SubagentStart` carries no
//                                 prompt and no transcript path (0 of 209
//                                 measured), so until now the instruction
//                                 survived only as a side effect of a
//                                 stop-time transcript drain that finds
//                                 nothing 65.8% of the time.
//   SubagentStart               → the identity row, and the spawn-call bridge.
//   SubagentStop                → the OUTPUT: final message, structured
//                                 return, and a HEAD-read recovery of the
//                                 prompt.
//
// Every path honors `dry_run` by returning before `recordAgentIo` — a
// `harness test --write` probe leaves no row, no blob, and no directory.

import type { AgentTranscriptMetrics } from "../../lib/collection/types.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { HarnessEvent } from "../types.js";
import { claimPendingSpawn, rememberPendingSpawn } from "./pending-spawn.js";
import { type AgentIoRowInput, recordAgentIo } from "./store.js";
import {
	firstUserMessage,
	lastStructuredReturn,
	readTranscriptHead,
	readTranscriptTail,
} from "./transcript.js";
import {
	type AgentIoTokens,
	isEncryptedByRunner,
	runnerForSource,
	SPAWN_TOOL_NAMES,
} from "./types.js";

/** Tail budget for the structured-return walk — the same window the
 *  final-message resolution uses, so the two see the same end of the file. */
const STRUCTURED_RETURN_TAIL_BYTES = 256 * 1024;

/** Base fields shared by every row written for one event. */
type RowBase = Pick<AgentIoRowInput, "ts" | "seq" | "session" | "runner" | "cwd">;

/** A non-empty string field of a tool_input, else null. */
function inputString(input: JsonObject | undefined, key: string): string | null {
	const value = input?.[key];
	return typeof value === "string" && value.trim() ? value : null;
}

/** The first non-empty value among several tool_input keys. Runners name the
 *  same thing differently (`prompt` / `message` / `task`), and a spawn tool
 *  that adds a fourth name must degrade to "no prompt found", never to a
 *  crash on the hook path. */
function firstInputString(input: JsonObject | undefined, keys: string[]): string | null {
	for (const key of keys) {
		const value = inputString(input, key);
		if (value !== null) return value;
	}
	return null;
}

/** Codex carries `model` / `reasoning_effort` alongside the task name and the
 *  record has no field for either, so the label row's content holds the whole
 *  triple as JSON when they are present and the bare name when they are not.
 *  `agent_label` always stays the plain name, so the queryable column is clean
 *  either way. (JSON-in-`content` is already this store's convention — it is
 *  how a `structured_result` row holds a return value.) */
export function taskLabelContent(input: JsonObject | undefined, taskName: string): string {
	const model = inputString(input, "model");
	const effort = inputString(input, "reasoning_effort");
	if (!model && !effort) return taskName;
	return JSON.stringify({ task_name: taskName, model, reasoning_effort: effort });
}

function rowBase(event: HarnessEvent, cwd: string): RowBase {
	return {
		ts: event.timestamp,
		seq: event.seq ?? null,
		session: event.session_id || null,
		runner: runnerForSource(event.agent_source),
		cwd,
	};
}

/**
 * The prompt row for a spawn call: the text when the runner sent one, a typed
 * placeholder when it is encrypted or absent.
 *
 * The placeholder IS the point. An unreachable input has to be a fact in the
 * store rather than a missing row — otherwise a runner that encrypts its spawn
 * message (Codex) is indistinguishable from a runner nobody wired up, and the
 * observability gap is invisible to every later reader.
 */
export function spawnPromptRow(
	base: RowBase,
	input: JsonObject | undefined,
	label: string | null,
	toolUseId: string | null,
): AgentIoRowInput {
	const raw = firstInputString(input, ["prompt", "message", "task", "instructions"]);
	const common = {
		...base,
		direction: "input" as const,
		role: "user" as const,
		kind: "spawn_prompt" as const,
		source: "spawn_tool" as const,
		agent_label: label,
		agent_label_source: "spawn_tool" as const,
		spawn_tool_use_id: toolUseId,
	};
	if (raw !== null && !isEncryptedByRunner(raw)) {
		return { ...common, raw, content_status: "captured" };
	}
	if (raw !== null) {
		return {
			...common,
			raw: null,
			content_status: "encrypted_by_runner",
			input_capturable: false,
			uncapturable_reason:
				"runner encrypts the sub-agent message (Fernet token) before it reaches the hook boundary",
		};
	}
	return {
		...common,
		raw: null,
		content_status: "unavailable",
		input_capturable: false,
		uncapturable_reason: "spawn call carried no prompt/message field",
	};
}

/**
 * PreToolUse seam. Writes the sub-agent's INPUT for any spawn verb — Claude
 * `Agent`/`Task`, Codex `collaborationspawn_agent`/`followup_task` — and
 * remembers the call so the `SubagentStart` that follows can bind an agent id
 * to it. Returns rows appended (0 for every non-spawn tool call).
 */
export function captureAgentIoSpawn(
	event: HarnessEvent,
	fallbackCwd: string,
	log?: (msg: string) => void,
): number {
	try {
		if (event.hook_event !== "PreToolUse") return 0;
		const tool = event.tool_name;
		if (!tool || !SPAWN_TOOL_NAMES.has(tool)) return 0;
		if (event.dry_run === true) return 0;
		const cwd = event.cwd ?? fallbackCwd;
		const input = event.tool_input;
		const base = rowBase(event, cwd);
		const label = firstInputString(input, ["subagent_type", "task_name", "agent_type"]);
		const toolUseId = event.tool_use_id ?? null;
		const rows: AgentIoRowInput[] = [];
		const taskName = firstInputString(input, ["task_name", "description"]);
		if (taskName !== null) {
			rows.push({
				...base,
				direction: "input",
				role: "user",
				kind: "task_label",
				source: "spawn_tool",
				agent_label: label,
				agent_label_source: "spawn_tool",
				spawn_tool_use_id: toolUseId,
				raw: taskLabelContent(input, taskName),
				content_status: "captured",
			});
		}
		rows.push(spawnPromptRow(base, input, label, toolUseId));
		rememberPendingSpawn({
			session: event.session_id || null,
			subagentType: label,
			toolUseId,
			ts: event.timestamp,
		});
		const written = recordAgentIo(rows, { cwd });
		if (written > 0) log?.(`Agent I/O: ${written} input row(s) from ${tool}`);
		return written;
	} catch (err) {
		void err; // capture is best-effort — never break the pipeline
		return 0;
	}
}

/** Token totals + tool-call join keys off the transcript metrics, when they
 *  were read. Null stays null — "not measured" is not "did nothing". */
function outputMetrics(metrics: AgentTranscriptMetrics | null | undefined): {
	tokens: AgentIoTokens | null;
	tool_use_ids: string[] | null;
} {
	if (!metrics) return { tokens: null, tool_use_ids: null };
	return { tokens: metrics.tokens, tool_use_ids: metrics.tool_use_ids };
}

/** What the caller already resolved for this event, so capture costs no second
 *  payload parse and no second metrics read. */
export interface AgentIoStopExtras {
	finalMessage?: { text: string; source: "payload" | "transcript" } | null;
	metrics?: AgentTranscriptMetrics | null;
	agentLabel?: string | null;
	agentLabelSource?: "payload" | "start_event" | null;
}

/** Up to three output rows for one stop: the final prose, the structured
 *  return the prose walk cannot see, and a HEAD-read recovery of the prompt. */
function stopRows(event: HarnessEvent, base: RowBase, extras: AgentIoStopExtras): AgentIoRowInput[] {
	const rows: AgentIoRowInput[] = [];
	const identity = {
		...base,
		agent_id: event.subagent_id ?? null,
		agent_label: extras.agentLabel ?? null,
		agent_label_source: extras.agentLabelSource ?? null,
	};
	const metrics = outputMetrics(extras.metrics);
	if (extras.finalMessage) {
		rows.push({
			...identity,
			...metrics,
			direction: "output",
			role: "assistant",
			kind: "final_message",
			source: extras.finalMessage.source,
			raw: extras.finalMessage.text,
			content_status: "captured",
		});
	}
	const transcriptPath = event.agent_transcript_path;
	if (!transcriptPath) return rows;
	const tail = readTranscriptTail(transcriptPath, STRUCTURED_RETURN_TAIL_BYTES);
	const structured = tail !== null ? lastStructuredReturn(tail) : null;
	if (structured) {
		rows.push({
			...identity,
			...metrics,
			direction: "output",
			role: "assistant",
			kind: "structured_result",
			source: "structured_output",
			raw: structured.json,
			content_status: "captured",
		});
	}
	const head = readTranscriptHead(transcriptPath);
	const prompt = head !== null ? firstUserMessage(head) : null;
	if (prompt !== null) {
		rows.push({
			...identity,
			direction: "input",
			role: "user",
			kind: "spawn_prompt",
			source: "transcript",
			raw: prompt,
			content_status: "captured",
		});
	}
	return rows;
}

/** The identity row for a start event. It carries no content because the
 *  payload has none — recording that as a typed `unavailable` row is what
 *  keeps the gap visible until a runner starts sending a prompt, at which
 *  point the payload-key census reports the new field. */
function startRow(event: HarnessEvent, base: RowBase, label: string | null): AgentIoRowInput {
	const claimed = claimPendingSpawn(event.session_id || null, label);
	return {
		...base,
		agent_id: event.subagent_id ?? null,
		spawn_tool_use_id: claimed?.toolUseId ?? null,
		agent_label: label,
		agent_label_source: label ? "payload" : null,
		direction: "input",
		role: "user",
		kind: "spawn_prompt",
		source: "payload",
		raw: null,
		content_status: "unavailable",
		input_capturable: false,
		uncapturable_reason:
			"SubagentStart carries no prompt; the spawn call and the transcript head are the capture points",
	};
}

/**
 * SubagentStart / SubagentStop seam. Called from the agent-event capture path,
 * which has already resolved the final message, the label and the metrics.
 * Returns rows appended.
 */
export function captureAgentIoLifecycle(
	event: HarnessEvent,
	fallbackCwd: string,
	extras: AgentIoStopExtras = {},
	log?: (msg: string) => void,
): number {
	try {
		if (event.dry_run === true) return 0;
		const cwd = event.cwd ?? fallbackCwd;
		const base = rowBase(event, cwd);
		if (event.hook_event === "SubagentStart") {
			const written = recordAgentIo([startRow(event, base, extras.agentLabel ?? null)], { cwd });
			if (written > 0) log?.(`Agent I/O: identity row for ${event.subagent_id ?? "unknown"}`);
			return written;
		}
		if (event.hook_event !== "SubagentStop") return 0;
		const rows = stopRows(event, base, extras);
		const written = recordAgentIo(rows, { cwd });
		if (written > 0) {
			const kinds = rows.map((row) => row.kind).join(", ");
			log?.(`Agent I/O: ${written} row(s) for ${event.subagent_id ?? "unknown"} (${kinds})`);
		}
		return written;
	} catch (err) {
		void err; // capture is best-effort — never break the pipeline
		return 0;
	}
}
