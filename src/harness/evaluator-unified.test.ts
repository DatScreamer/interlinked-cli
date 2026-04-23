import { describe, expect, it, vi } from "vitest";
import {
	budgetFor,
	DEFAULT_BUDGETS,
	extractToolClassFromEvent,
	filterCheckResultsByToolClass,
	flattenFindings,
	toHarnessEvent,
	type UnifiedEvaluatorTelemetry,
} from "./evaluator-unified.js";
import type { HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

function makeEvent(over: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "evt-eval-1",
		session_id: "s",
		ts: "2026-04-23T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
			tool_input_redacted: {},
		},
		context: { cwd: "/repo" },
		raw: {},
		...over,
	};
}

describe("budgetFor", () => {
	it("returns the per-class budget", () => {
		expect(budgetFor("read")).toBe(DEFAULT_BUDGETS.read_budget_ms);
		expect(budgetFor("modify")).toBe(DEFAULT_BUDGETS.modify_budget_ms);
		expect(budgetFor("side-effect")).toBe(DEFAULT_BUDGETS.side_effect_budget_ms);
		expect(budgetFor("long-running")).toBe(DEFAULT_BUDGETS.long_running_budget_ms);
		expect(budgetFor("unknown")).toBe(DEFAULT_BUDGETS.unknown_budget_ms);
	});

	it("respects user-provided budgets", () => {
		const user = {
			read_budget_ms: 50,
			modify_budget_ms: 100,
			side_effect_budget_ms: 200,
			long_running_budget_ms: 500,
			unknown_budget_ms: 75,
		};
		expect(budgetFor("read", user)).toBe(50);
		expect(budgetFor("modify", user)).toBe(100);
	});
});

describe("extractToolClassFromEvent", () => {
	it("reads tool_class from tool_call actions", () => {
		expect(extractToolClassFromEvent(makeEvent())).toBe("modify");
	});
	it("reads tool_class from shell_command", () => {
		const e = makeEvent({
			action: { kind: "shell_command", command: "ls", tool_class: "read" },
		});
		expect(extractToolClassFromEvent(e)).toBe("read");
	});
	it("returns unknown for lifecycle actions", () => {
		const e = makeEvent({
			action: { kind: "session_lifecycle", event: "start" },
		});
		expect(extractToolClassFromEvent(e)).toBe("unknown");
	});
});

describe("toHarnessEvent — tool_call", () => {
	const event = makeEvent();
	const harness = toHarnessEvent(event);
	it("restores Claude-style capitalization", () => {
		expect(harness.tool_name).toBe("Edit");
	});
	it("preserves session_id and cwd", () => {
		expect(harness.session_id).toBe("s");
		expect(harness.cwd).toBe("/repo");
	});
	it("maps agent_source to claude for claude-code runner", () => {
		expect(harness.agent_source).toBe("claude");
	});
	it("preserves tool_input", () => {
		expect(harness.tool_input?.file_path).toBe("/repo/a.ts");
	});
});

describe("toHarnessEvent — copilot runner", () => {
	const event = makeEvent({
		runner: "copilot-cli",
		action: {
			kind: "tool_call",
			tool_name: "edit_file",
			tool_class: "modify",
			tool_input: { path: "/a" },
			tool_input_redacted: {},
		},
	});
	const harness = toHarnessEvent(event);
	it("maps agent_source to copilot", () => {
		expect(harness.agent_source).toBe("copilot");
	});
	it("leaves lowercase tool_name intact", () => {
		expect(harness.tool_name).toBe("edit_file");
	});
});

describe("toHarnessEvent — shell_command", () => {
	const event = makeEvent({
		action: { kind: "shell_command", command: "rm -rf /x", tool_class: "side-effect" },
	});
	const harness = toHarnessEvent(event);
	it("uses Bash tool_name", () => {
		expect(harness.tool_name).toBe("Bash");
	});
	it("puts the command in tool_input", () => {
		expect(harness.tool_input?.command).toBe("rm -rf /x");
	});
});

describe("toHarnessEvent — file_operation", () => {
	it("write → Write with content", () => {
		const event = makeEvent({
			action: {
				kind: "file_operation",
				operation: "write",
				path: "/a",
				content: "hello",
				tool_class: "modify",
			},
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBe("Write");
		expect(harness.tool_input?.content).toBe("hello");
	});
	it("delete → Bash with rm command", () => {
		const event = makeEvent({
			action: {
				kind: "file_operation",
				operation: "delete",
				path: "/a",
				tool_class: "side-effect",
			},
		});
		const harness = toHarnessEvent(event);
		expect(harness.tool_name).toBe("Bash");
		expect(harness.tool_input?.command).toBe("rm /a");
	});
});

describe("filterCheckResultsByToolClass", () => {
	it("passes through a decision without check_results", () => {
		const d: HarnessDecision = { decision: "allow" };
		const { decision, count } = filterCheckResultsByToolClass(d, "read");
		expect(decision).toBe(d);
		expect(count).toBe(0);
	});
});

describe("flattenFindings", () => {
	it("concatenates check_results and findings", () => {
		const d: HarnessDecision = {
			decision: "allow",
			check_results: [
				{
					source: "quality",
					name: "a",
					severity: "info",
					message: "x",
					determinism: "heuristic",
				},
			],
			findings: [
				{
					source: "structural",
					name: "b",
					severity: "warning",
					message: "y",
					determinism: "heuristic",
				},
			],
		};
		expect(flattenFindings(d).length).toBe(2);
	});
	it("returns check_results alone when findings missing", () => {
		const d: HarnessDecision = {
			decision: "allow",
			check_results: [
				{
					source: "quality",
					name: "a",
					severity: "info",
					message: "x",
					determinism: "heuristic",
				},
			],
		};
		expect(flattenFindings(d).length).toBe(1);
	});
});

describe("telemetry callback contract", () => {
	it("accepts the three telemetry kinds", () => {
		const events: UnifiedEvaluatorTelemetry[] = [
			{
				kind: "budget_exceeded",
				event_id: "e1",
				tool_class: "modify",
				budget_ms: 800,
				elapsed_ms: 900,
			},
			{ kind: "check_filtered", event_id: "e1", tool_class: "modify", filtered_count: 3 },
			{
				kind: "evaluated",
				event_id: "e1",
				tool_class: "modify",
				elapsed_ms: 42,
				decision: "allow",
			},
		];
		const sink = vi.fn();
		for (const e of events) sink(e);
		expect(sink).toHaveBeenCalledTimes(3);
	});
});
