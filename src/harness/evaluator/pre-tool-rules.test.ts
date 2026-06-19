// Covers the `bash-code-file-write-bypass` block in evaluateDestructiveRules.
// `pre-tool-rules.ts` is a low-coverage module whose remediation message
// previously pointed agents at the now-removed MultiEdit tool; this test pins
// the message to the real primitive (`interlinked write --batch`) and is
// filename-corresponding so the per-edit overlay selects it (finding 2026-06:
// the block was full-suite-covered via supply-chain-defense.test.ts but the
// scoped overlay under-selected, so editing the message tripped the
// uncovered-added-line gate).

import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../rules-loader.js";
import type { HarnessEvent } from "../types.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";

function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "pre-tool-rules-test",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-15T00:00:00Z",
	} as HarnessEvent;
}

describe("evaluateDestructiveRules — bash-code-file-write-bypass", () => {
	it("blocks a shell redirect to a code file and recommends the real atomic primitive", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("bash-code-file-write-bypass");
		// The remediation must name the available primitive, NOT the removed
		// MultiEdit tool (finding 2026-06; MultiEdit is gone from Claude Code).
		expect(decision?.reason).toContain("interlinked write --batch");
	});

	it("does not block a redirect to a non-code file", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > notes.txt"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.rule_id).not.toBe("bash-code-file-write-bypass");
	});
});
