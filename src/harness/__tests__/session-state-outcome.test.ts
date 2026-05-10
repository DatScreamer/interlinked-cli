// ===========================================
// session-state — outcome-aware error counters
// ===========================================
// Pin the design's outcome-gating: error_count and consecutive_tool_failures
// must move on `tool_outcome === "error"` (folded failure on Claude/Codex/
// Gemini/Copilot regular Post*), NOT on `hook_event === "PostToolUseFailure"`
// (which only fires for Cursor's dedicated event today). The previous gate
// was inverted for folded failures — error_count never bumped, and
// consecutive_tool_failures was *cleared* by the very events that should
// have incremented it.

import { describe, expect, it } from "vitest";

import { SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";

const baseEvent = (overrides: Partial<HarnessEvent>): HarnessEvent => ({
	hook_event: "PostToolUse",
	session_id: "outcome-session",
	agent_name: "alice",
	agent_source: "claude",
	tool_name: "Edit",
	tool_input: {},
	timestamp: "2026-05-09T10:00:00Z",
	...overrides,
});

describe("SessionTracker — outcome-aware error counters", () => {
	it("increments error_count on folded PostToolUse with tool_outcome:error", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(
			baseEvent({ tool_outcome: "error", error_message: "TS2307: Cannot find module" }),
		);
		const session = tracker.get("outcome-session");
		expect(session?.error_count).toBe(1);
	});

	it("increments consecutive_tool_failures on folded failure", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseEvent({ tool_outcome: "error" }));
		tracker.recordEvent(baseEvent({ tool_outcome: "error" }));
		tracker.recordEvent(baseEvent({ tool_outcome: "error" }));
		const session = tracker.get("outcome-session");
		expect(session?.consecutive_tool_failures.get("Edit")).toBe(3);
		expect(session?.error_count).toBe(3);
	});

	it("resets consecutive_tool_failures on tool_outcome:success", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseEvent({ tool_outcome: "error" }));
		tracker.recordEvent(baseEvent({ tool_outcome: "error" }));
		expect(tracker.get("outcome-session")?.consecutive_tool_failures.get("Edit")).toBe(2);
		tracker.recordEvent(baseEvent({ tool_outcome: "success" }));
		expect(tracker.get("outcome-session")?.consecutive_tool_failures.get("Edit")).toBeUndefined();
	});

	it("does not increment when tool_outcome is unset (legacy event)", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseEvent({}));
		expect(tracker.get("outcome-session")?.error_count).toBe(0);
	});

	it("preserves Cursor postToolUseFailure path via tool_outcome:error", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(
			baseEvent({
				hook_event: "PostToolUseFailure",
				agent_source: "cursor",
				tool_outcome: "error",
				error_message: "Cursor diagnostic",
			}),
		);
		const session = tracker.get("outcome-session");
		expect(session?.error_count).toBe(1);
		expect(session?.consecutive_tool_failures.get("Edit")).toBe(1);
	});

	it("treats interrupted as not-success: counter stays put", () => {
		const tracker = new SessionTracker();
		tracker.recordEvent(baseEvent({ tool_outcome: "error" }));
		// `interrupted` is its own outcome — neither bumps error_count nor resets
		tracker.recordEvent(baseEvent({ tool_outcome: "interrupted" }));
		const session = tracker.get("outcome-session");
		expect(session?.error_count).toBe(1);
		expect(session?.consecutive_tool_failures.get("Edit")).toBe(1);
	});
});
