import { describe, expect, it } from "vitest";
import type { HookEvent } from "../types.js";
import { evaluate } from "./evaluate.js";

function preToolUseBash(command: string): HookEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-05-28T00:00:00Z",
	};
}

describe("evaluate", () => {
	it("allows non-PreToolUse events without inspection", () => {
		const event: HookEvent = {
			hook_event: "PostToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command: "cf dns records delete --id abc" },
			timestamp: "2026-05-28T00:00:00Z",
		};
		const verdict = evaluate(event);
		expect(verdict.decision).toBe("allow");
		expect(verdict.warnings).toBeUndefined();
	});

	it("allows bash commands with no matching rule", () => {
		const verdict = evaluate(preToolUseBash("ls -la"));
		expect(verdict.decision).toBe("allow");
		expect(verdict.warnings).toBeUndefined();
	});

	it("warns on `cf dns records delete`", () => {
		const verdict = evaluate(preToolUseBash("cf dns records delete --id abc"));
		expect(verdict.decision).toBe("allow");
		expect(verdict.rule_id).toBe("cloud-builtin-cf-dns-record-delete");
		expect(verdict.warnings).toBeDefined();
		expect(verdict.warnings?.[0]).toContain("DNS");
	});

	it("warns on `cf dns record delete` (singular)", () => {
		const verdict = evaluate(preToolUseBash("cf dns record delete --id abc"));
		expect(verdict.decision).toBe("allow");
		expect(verdict.rule_id).toBe("cloud-builtin-cf-dns-record-delete");
	});

	it("does not warn on `cf dns records list`", () => {
		const verdict = evaluate(preToolUseBash("cf dns records list"));
		expect(verdict.decision).toBe("allow");
		expect(verdict.warnings).toBeUndefined();
	});

	it("does not match non-Bash tool calls with matching content", () => {
		const event: HookEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: { file_path: "x.txt", new_string: "cf dns records delete" },
			timestamp: "2026-05-28T00:00:00Z",
		};
		const verdict = evaluate(event);
		expect(verdict.decision).toBe("allow");
		expect(verdict.warnings).toBeUndefined();
	});
});
