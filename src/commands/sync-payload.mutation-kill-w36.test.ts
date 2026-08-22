import { describe, expect, it } from "vitest";
import { buildBatchBody, buildEventPayload, type PayloadDefaults } from "./sync-payload.js";
import type { LocalActivityEvent } from "../lib/local-activity.js";

// These tests target ConditionalExpression mutants that replace an
// omit-if-absent guard (`if (e.field) ...`) with the literal `true`. Each
// mutant, if it survived, would force the corresponding payload key to be
// assigned (even to `undefined`) regardless of whether the source field was
// present. Every test below builds a MINIMAL event with none of the optional
// fields set, then asserts the resulting payload/body never gained the key
// under test at all — `in` distinguishes "never assigned" from "assigned
// undefined", which is exactly the observable difference between pristine
// and mutant behavior.

const defaults: PayloadDefaults = { workspaceKey: "wk", projectKey: "pk" };

function minimalEvent(): LocalActivityEvent {
	return {
		ts: "2024-01-01T00:00:00.000Z",
		agent: "test-agent",
		type: "tool_call",
	};
}

function hasKey(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

describe("buildEventPayload — mapV2Fields omit-if-absent guards", () => {
	// test-contract: invariant — absent field must never appear in the payload
	it("omits duration_ms when e.duration_ms is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "duration_ms")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits parent_agent when e.parent_agent is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "parent_agent")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits subagent_id when e.subagent_id is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "subagent_id")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits files_modified when e.files_modified is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "files_modified")).toBe(false);
	});
});

describe("buildEventPayload — mapV3Fields omit-if-absent guards", () => {
	// test-contract: invariant — absent field must never appear in the payload
	it("omits hook_event when e.hook is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "hook_event")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits both error_message and error_detail when e.error is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "error_message")).toBe(false);
		expect(hasKey(payload, "error_detail")).toBe(false);
	});
});

describe("buildEventPayload — mapV4CaptureFields !== undefined guards", () => {
	// test-contract: invariant — undefined field must never appear in the payload
	it("omits tool_input_json when e.tool_input is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "tool_input_json")).toBe(false);
	});

	// test-contract: invariant — undefined field must never appear in the payload
	it("omits tool_response_json when e.tool_response is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "tool_response_json")).toBe(false);
	});

	// test-contract: invariant — undefined field must never appear in the payload
	it("omits prompt when e.prompt is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "prompt")).toBe(false);
	});

	// test-contract: invariant — undefined field must never appear in the payload
	it("omits last_assistant_message when e.last_assistant_message is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "last_assistant_message")).toBe(false);
	});
});

describe("buildEventPayload — mapV4ContextFields omit-if-absent guards", () => {
	// test-contract: invariant — absent field must never appear in the payload
	it("omits cwd when e.cwd is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "cwd")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits model when e.model is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "model")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits source when e.source is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "source")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits agent_type_hook when e.agent_type is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "agent_type_hook")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits tool_use_id when e.tool_use_id is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "tool_use_id")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits session_id when e.session is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "session_id")).toBe(false);
	});

	// test-contract: invariant — undefined field must never appear in the payload
	it("omits is_interrupt when e.is_interrupt is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "is_interrupt")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits transcript_path when e.transcript_path is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "transcript_path")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits agent_transcript_path when e.agent_transcript_path is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "agent_transcript_path")).toBe(false);
	});
});

describe("buildEventPayload — mapV4MetaFields omit-if-absent guards", () => {
	// test-contract: invariant — absent field must never appear in the payload
	it("omits notification_type when e.notification_type is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "notification_type")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits notification_title when e.notification_title is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "notification_title")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits task_subject when e.task_subject is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "task_subject")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits task_id_hook when e.task_id is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "task_id_hook")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits task_description_hook when e.task_description is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "task_description_hook")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits trigger when e.trigger is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "trigger")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits reason when e.reason is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "reason")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits permission_mode when e.permission_mode is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "permission_mode")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits teammate_name when e.teammate_name is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "teammate_name")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits team_name when e.team_name is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "team_name")).toBe(false);
	});

	// test-contract: invariant — absent field must never appear in the payload
	it("omits custom_instructions when e.custom_instructions is absent", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "custom_instructions")).toBe(false);
	});

	// test-contract: invariant — undefined field must never appear in the payload
	it("omits stop_hook_active when e.stop_hook_active is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "stop_hook_active")).toBe(false);
	});

	// test-contract: invariant — undefined field must never appear in the payload
	it("omits permission_suggestions when e.permission_suggestions is undefined", () => {
		const payload = buildEventPayload(minimalEvent(), defaults);
		expect(hasKey(payload, "permission_suggestions")).toBe(false);
	});
});

describe("buildBatchBody — omit-if-absent guard", () => {
	// test-contract: invariant — absent workspaceId must never appear in the body
	it("omits workspace_uuid when workspaceId is undefined", () => {
		const body = buildBatchBody(defaults, [], undefined);
		expect(hasKey(body, "workspace_uuid")).toBe(false);
	});
});
