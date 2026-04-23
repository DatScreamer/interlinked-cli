import { describe, expect, it } from "vitest";
import type { GuardRulesConfig, SessionTrajectory } from "../../types.js";
import { evaluateTaintGuards } from "../taint-guards.js";

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
});
