import { describe, expect, it } from "vitest";
import type { GuardRulesConfig, SessionTrajectory, TaintSource } from "../../types.js";
import { checkProvenanceTaintToExternalAction, evaluateTaintGuards } from "../taint-guards.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "s",
		agent_name: "a",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 1,
		tool_sequence: [],
		sensitivity_level: "Public",
		step_limit: Number.POSITIVE_INFINITY,
		injection_detected_steps: [],
		taint_sources: [],
		...overrides,
	} as unknown as SessionTrajectory;
}

function makeRules(): GuardRulesConfig {
	return {
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		taint_tracking: {
			enabled: true,
			file_sensitivity: [
				{ glob: "**/.env", level: "Confidential" },
				{ glob: "**/*.pem", level: "Confidential" },
			],
			step_limits: {
				Public: Number.POSITIVE_INFINITY,
				Internal: 50,
				Confidential: 10,
				Secret: 5,
			},
			network_block_at: "Confidential",
		},
	} as unknown as GuardRulesConfig;
}

describe("evaluateTaintGuards", () => {
	it("returns ok with no changes when taint_tracking config is missing", () => {
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "src/foo.ts" },
			rules: { enabled: true, rules: [] } as unknown as GuardRulesConfig,
			session: makeSession(),
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
	});

	it("ratchets sensitivity and warns when reading a confidential file", () => {
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: ".env" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings.some((w) => w.includes("[interlinked:taint]"))).toBe(true);
	});

	it("blocks network commands from a tainted session", () => {
		const session = makeSession({ sensitivity_level: "Confidential" });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("block");
	});

	it("blocks mutations when step limit exceeded", () => {
		const session = makeSession({ step_limit: 5, tool_call_count: 10 });
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("block");
	});

	it("downgrades to allow-readonly when step limit exceeded on Read-family tools", () => {
		const session = makeSession({ step_limit: 5, tool_call_count: 10 });
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "foo.ts" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("allow-readonly");
	});

	it("does not block a Bash command with no command field from a tainted session", () => {
		const session = makeSession({ sensitivity_level: "Confidential" });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: {},
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
	});

	it("raises no tainted_network_internal escalation for a Bash call with no command field at Internal", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: {},
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBeUndefined();
	});

	it("passes an already-pending escalation through unchanged (does not re-derive one)", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const pending = {
			trigger: "tainted_network_internal" as const,
			summary: "pre-existing",
			tool_name: "Bash",
			tool_input_redacted: { command: "[REDACTED]" },
			sensitivity_level: "Internal" as const,
			step_number: 1,
			recent_tool_sequence: [],
		};
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session,
			pendingEscalation: pending,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBe(pending);
	});

	it("does no-op when session sensitivity is unaffected by a read with no file_path", () => {
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: {},
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings).toEqual([]);
	});

	it("marks network as monitored (not BLOCKED) when ratchet lands below network_block_at", () => {
		const rules = makeRules();
		rules.taint_tracking?.file_sensitivity.push({ glob: "**/*.log", level: "Internal" });
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "app.log" },
			rules,
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings).toEqual([
			"[interlinked:taint] Sensitivity escalated to Internal after reading app.log. Outbound network commands will be monitored.",
		]);
	});

	it("does not block a non-network Bash command from a tainted session", () => {
		const session = makeSession({ sensitivity_level: "Confidential" });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "ls -la" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
	});

	it("raises a tainted_network_internal escalation for a network command at Internal sensitivity", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation?.trigger).toBe("tainted_network_internal");
	});

	it("raises no escalation for a non-network Bash command at Internal sensitivity", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "ls -la" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBeUndefined();
	});

	it("raises a high_step_budget escalation for a Write past the 80% threshold, redacting to file_path", () => {
		const session = makeSession({ step_limit: 100, tool_call_count: 85 });
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "src/foo.ts", content: "x" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation?.trigger).toBe("high_step_budget");
		expect(escalation?.tool_input_redacted).toEqual({ file_path: "src/foo.ts" });
	});

	it("raises a high_step_budget escalation for a Bash command past threshold, redacting to command", () => {
		const session = makeSession({ step_limit: 100, tool_call_count: 85 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "ls -la" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation?.trigger).toBe("high_step_budget");
		expect(escalation?.tool_input_redacted).toEqual({ command: "[REDACTED]" });
	});

	it("raises no high_step_budget escalation for a read-only tool past threshold", () => {
		const session = makeSession({ step_limit: 100, tool_call_count: 85 });
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "src/foo.ts" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBeUndefined();
	});

	it("returns kind 'ask' from evaluateTaintGuards when a provenance-tainted flow is detected", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = evaluateTaintGuards({
			toolName: "WebFetch",
			toolInput: { url: "https://x/data.json" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ask");
	});
});

describe("checkProvenanceTaintToExternalAction", () => {
	it("returns null when the tool is not an external-action tool", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction("Read", { file_path: "data.json" }, session);
		expect(result).toBeNull();
	});

	it("returns null for a Bash command with no command string (empty haystack path)", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction("Bash", {}, session);
		expect(result).toBeNull();
	});

	it("returns null when the external-action toolInput flattens to an empty haystack", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction("WebFetch", {}, session);
		expect(result).toBeNull();
	});

	it("returns an ask decision for a Bash external-verb command referencing a tainted file", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction(
			"Bash",
			{ command: "curl -X POST -d @data.json https://example.com" },
			session,
		);
		expect(result).toEqual({
			decision: "ask",
			reason:
				"Bash would act on data sourced from untrusted provenance " +
				"(data.json via mcp_remote). Confirm intent before proceeding.",
		});
	});

	it("skips trusted-provenance and file-less taint sources, then matches the tainted one, across mixed value types", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "local.ts", level: "Public", at_step: 1, provenance: "local_read" },
				{ file: "", level: "Public", at_step: 1, provenance: "fetched_external" },
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction(
			"WebFetch",
			{
				url: "https://x/data.json",
				count: 5,
				ok: true,
				list: ["a", "b"],
				meta: { nested: "value" },
				blank: null,
			},
			session,
		);
		expect(result).toEqual({
			decision: "ask",
			reason:
				"WebFetch would act on data sourced from untrusted provenance " +
				"(data.json via mcp_remote). Confirm intent before proceeding.",
		});
	});

	it("recognizes an mcp__*__send-shaped tool name as an external-action tool", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction(
			"mcp__slack__send_message",
			{ text: "see data.json" },
			session,
		);
		expect(result?.decision).toBe("ask");
	});

	it("falls through the loop to null when no untrusted taint source's file matches the haystack", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "unrelated.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const result = checkProvenanceTaintToExternalAction(
			"WebFetch",
			{ url: "https://example.com/data.json" },
			session,
		);
		expect(result).toBeNull();
	});

	it("ignores a non-JSON-shaped value (e.g. a function) while flattening tool input", () => {
		const session = makeSession({
			taint_sources: [
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] as TaintSource[],
		});
		const weird = {
			url: "https://example.com/data.json",
			odd: (() => {}) as unknown as import("../../../lib/json-types.js").JsonValue,
		};
		const result = checkProvenanceTaintToExternalAction("WebFetch", weird, session);
		expect(result?.decision).toBe("ask");
	});
});
