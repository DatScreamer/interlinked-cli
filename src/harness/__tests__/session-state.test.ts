import { describe, expect, it } from "vitest";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";

/** Minimal PreToolUse event — enough for recordEvent to mint a trajectory.
 *  The timestamp is a fixed literal: this suite asserts on signal merges,
 *  not on time, so a deterministic value keeps the tests flake-free. */
function evt(sessionId: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: sessionId,
		agent_source: "claude",
		timestamp: "2026-05-17T00:00:00.000Z",
	};
}

describe("SessionTracker.rollUpVerificationSignals", () => {
	it("merges the child's verification_observed into the parent (set union)", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.verification_observed = new Set(["test", "lint"]);
		parent.verification_observed = new Set(["typecheck"]);

		expect(t.rollUpVerificationSignals("child", "parent")).toBe(true);
		expect([...(t.get("parent")?.verification_observed ?? [])].sort()).toEqual([
			"lint",
			"test",
			"typecheck",
		]);
	});

	it("gap-fills test_runs without clobbering the parent's own entry", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.test_runs.set("a.test.ts", { status: "pass", at_step: 1 });
		child.test_runs.set("shared.test.ts", { status: "fail", at_step: 2 });
		// The parent already has its own (newer, authoritative) result for the
		// shared file — the roll-up must not overwrite it.
		parent.test_runs.set("shared.test.ts", { status: "pass", at_step: 9 });

		t.rollUpVerificationSignals("child", "parent");
		const runs = t.get("parent")?.test_runs;
		expect(runs?.get("a.test.ts")?.status).toBe("pass");
		expect(runs?.get("shared.test.ts")?.status).toBe("pass");
	});

	it("merges stubs_introduced from the child", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		t.recordEvent(evt("parent"));
		child.stubs_introduced = [{ file: "x.ts", kind: "TODO", snippet: "// TODO" }];

		t.rollUpVerificationSignals("child", "parent");
		expect(t.get("parent")?.stubs_introduced).toHaveLength(1);
	});

	it("returns false when from and to are the same session", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("solo"));
		expect(t.rollUpVerificationSignals("solo", "solo")).toBe(false);
	});

	it("returns false when either session is missing", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("only"));
		expect(t.rollUpVerificationSignals("only", "ghost")).toBe(false);
		expect(t.rollUpVerificationSignals("ghost", "only")).toBe(false);
	});
});
