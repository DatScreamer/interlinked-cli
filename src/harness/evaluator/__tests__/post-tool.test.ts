import { describe, expect, it } from "vitest";
import { CohortManager } from "../../cohort.js";
import { ReservationManager } from "../../reservations.js";
import { getDefaultConfig } from "../../rules-loader.js";
import type { HarnessEvent } from "../../types.js";
import { evaluatePostToolUse } from "../post-tool.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

describe("evaluatePostToolUse smoke", () => {
	it("always returns allow", () => {
		const result = evaluatePostToolUse(
			makeEvent(),
			getDefaultConfig(),
			undefined,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("emits a tool-miss warning for rg-not-installed output", () => {
		const result = evaluatePostToolUse(
			makeEvent({
				tool_input: { command: "rg foo" },
				tool_response: "bash: command not found: rg",
			}),
			getDefaultConfig(),
			undefined,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		expect(result.warnings?.some((w) => w.includes("[interlinked:tool-miss]"))).toBe(true);
	});
});
