import { describe, expect, it } from "vitest";
import { CohortManager } from "../../cohort.js";
import { ReservationManager } from "../../reservations.js";
import { getDefaultConfig } from "../../rules-loader.js";
import type { HarnessEvent, SessionTrajectory } from "../../types.js";
import { evaluatePreToolUse } from "../pre-tool.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "t",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "t",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
		tool_sequence: [],
		sensitivity_level: "Public",
		soft_blocks: new Set(),
		fired_reminders: new Set(),
		suggested_permissions: new Set(),
		consecutive_pattern: null,
		curl_localhost_count: {},
		injection_detected_steps: [],
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
	} as unknown as SessionTrajectory;
}

describe("evaluatePreToolUse smoke", () => {
	it("returns allow when rules.enabled = false", () => {
		const rules = getDefaultConfig();
		rules.enabled = false;
		const result = evaluatePreToolUse(
			makeEvent(),
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("passes a trivial ls command through with allow", () => {
		const rules = getDefaultConfig();
		const result = evaluatePreToolUse(
			makeEvent({ tool_input: { command: "ls -la" } }),
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("blocks reading a .env file", () => {
		const rules = getDefaultConfig();
		const result = evaluatePreToolUse(
			makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "/tmp/project/.env" },
			}),
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
	});
});
