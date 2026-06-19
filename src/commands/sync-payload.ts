// interlinked-tdd: exempt
// ===========================================
// interlinked sync — server-bound event payload mapping (extracted leaf cluster)
// ===========================================

import type { JsonObject } from "../lib/json-types.js";
import type { LocalActivityEvent } from "../lib/local-activity.js";

export interface PayloadDefaults {
	workspaceKey: string;
	projectKey: string;
}

/** v2 token + attribution fields (omit-if-absent, exactOptionalPropertyTypes-safe). */
function mapV2Fields(e: LocalActivityEvent, payload: JsonObject): void {
	if (e.duration_ms) payload.duration_ms = e.duration_ms;
	if (e.tokens?.input) payload.tokens_input = e.tokens.input;
	if (e.tokens?.output) payload.tokens_output = e.tokens.output;
	if (e.tokens?.cache_read) payload.tokens_cache_read = e.tokens.cache_read;
	if (e.tokens?.cache_creation) payload.tokens_cache_creation = e.tokens.cache_creation;
	if (e.parent_agent) payload.parent_agent = e.parent_agent;
	if (e.subagent_id) payload.subagent_id = e.subagent_id;
	if (e.files_modified) payload.files_modified = e.files_modified;
}

/** v3 hook + error fields (object errors are JSON-stringified, mirrored to message + detail). */
function mapV3Fields(e: LocalActivityEvent, payload: JsonObject): void {
	if (e.hook) payload.hook_event = e.hook;
	if (e.error)
		payload.error_message = typeof e.error === "string" ? e.error : JSON.stringify(e.error);
	if (e.error)
		payload.error_detail = typeof e.error === "string" ? e.error : JSON.stringify(e.error);
}

/** v4 full-capture payload fields: tool I/O + prompt/assistant message. */
function mapV4CaptureFields(e: LocalActivityEvent, payload: JsonObject): void {
	if (e.tool_input !== undefined)
		payload.tool_input_json =
			typeof e.tool_input === "string" ? e.tool_input : JSON.stringify(e.tool_input);
	if (e.tool_response !== undefined)
		payload.tool_response_json =
			typeof e.tool_response === "string" ? e.tool_response : JSON.stringify(e.tool_response);
	if (e.prompt !== undefined) payload.prompt = e.prompt;
	if (e.last_assistant_message !== undefined)
		payload.last_assistant_message = e.last_assistant_message;
}

/** v4 environment/context fields: cwd, model, source, identifiers. */
function mapV4ContextFields(e: LocalActivityEvent, payload: JsonObject): void {
	if (e.cwd) payload.cwd = e.cwd;
	if (e.model) payload.model = e.model;
	if (e.source) payload.source = e.source;
	if (e.agent_type) payload.agent_type_hook = e.agent_type;
	if (e.tool_use_id) payload.tool_use_id = e.tool_use_id;
	if (e.session) payload.session_id = e.session;
	if (e.is_interrupt !== undefined) payload.is_interrupt = e.is_interrupt;
	if (e.transcript_path) payload.transcript_path = e.transcript_path;
	if (e.agent_transcript_path) payload.agent_transcript_path = e.agent_transcript_path;
}

/** v4 notification + task + governance metadata fields. */
function mapV4MetaFields(e: LocalActivityEvent, payload: JsonObject): void {
	if (e.notification_type) payload.notification_type = e.notification_type;
	if (e.notification_title) payload.notification_title = e.notification_title;
	if (e.task_subject) payload.task_subject = e.task_subject;
	if (e.task_id) payload.task_id_hook = e.task_id;
	if (e.task_description) payload.task_description_hook = e.task_description;
	if (e.trigger) payload.trigger = e.trigger;
	if (e.reason) payload.reason = e.reason;
	if (e.permission_mode) payload.permission_mode = e.permission_mode;
	if (e.teammate_name) payload.teammate_name = e.teammate_name;
	if (e.team_name) payload.team_name = e.team_name;
	if (e.custom_instructions) payload.custom_instructions = e.custom_instructions;
	if (e.stop_hook_active !== undefined) payload.stop_hook_active = e.stop_hook_active;
	if (e.permission_suggestions !== undefined)
		payload.permission_suggestions =
			typeof e.permission_suggestions === "string"
				? e.permission_suggestions
				: JSON.stringify(e.permission_suggestions);
}

/**
 * Build the server-bound batch payload for one local event. Mirrors the hook
 * egress field mapping exactly (required fields + v2/v3/v4). Caller applies
 * egress scrubbing on the returned object.
 */
export function buildEventPayload(e: LocalActivityEvent, defaults: PayloadDefaults): JsonObject {
	const payload: JsonObject = {
		agent_name: e.agent || "unknown",
		workspace_key: e.workspace_key || defaults.workspaceKey,
		project_key: e.project_key || defaults.projectKey,
		event_type: e.type,
		tool_name: e.tool || undefined,
		tool_input_summary: e.summary || undefined,
		occurred_at: e.ts,
	};
	mapV2Fields(e, payload);
	mapV3Fields(e, payload);
	mapV4CaptureFields(e, payload);
	mapV4ContextFields(e, payload);
	mapV4MetaFields(e, payload);
	return payload;
}

/** Build the request headers for a batch POST (Bearer for prod, none for localhost). */
export function buildBatchHeaders(
	token: string | null,
	isLocalDev: boolean,
): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token && !isLocalDev) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/** Build the batch request body, including workspace_uuid routing when present. */
export function buildBatchBody(
	defaults: PayloadDefaults,
	batchPayload: JsonObject[],
	workspaceId: string | undefined,
): JsonObject {
	const body: JsonObject = {
		workspace_key: defaults.workspaceKey,
		project_key: defaults.projectKey,
		events: batchPayload,
	};
	if (workspaceId) {
		body.workspace_uuid = workspaceId;
	}
	return body;
}
