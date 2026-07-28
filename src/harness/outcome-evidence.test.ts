import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liftOutcomeEvidence } from "./outcome-evidence.js";
import type { HarnessEvent } from "./types.js";

/**
 * The shared daemon-side lift of object tool_response evidence onto the flat
 * outcome fields. The wedge this pins (observed live 2026-07-28): the compiled
 * hook forwards the runner's OBJECT tool_response untouched, so a passing bare
 * `vitest run` reached the daemon with no flat evidence, classified "neither",
 * and was silently dropped — while failures recorded via the PostToolUseFailure
 * event name. Reds accumulated, greens could not clear them.
 */
function post(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-07-28T00:00:00.000Z",
		tool_name: "Bash",
		tool_input: { command: "npx vitest run a.test.ts" },
		...over,
	};
}

describe("liftOutcomeEvidence — positive (must lift)", () => {
	it("P1: lifts object-response stdout so trackers can read a runner summary", () => {
		const e = post({ tool_response: { stdout: "Tests  7 passed (7)" } });
		liftOutcomeEvidence(e);
		expect(e.stdout).toBe("Tests  7 passed (7)");
	});

	it("P2: derives tool_outcome success from a marker-free PostToolUse object response", () => {
		const e = post({ tool_response: { stdout: "ok" } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBe("success");
	});

	it("P3: derives tool_outcome error from the PostToolUseFailure event name", () => {
		const e = post({ hook_event: "PostToolUseFailure", tool_response: { stdout: "" } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBe("error");
	});

	it("P4: lifts stderr and a numeric exitCode", () => {
		const e = post({ tool_response: { stderr: "warn", exitCode: 0 } });
		liftOutcomeEvidence(e);
		expect(e.stderr).toBe("warn");
		expect(e.exit_code).toBe(0);
	});

	it("P5: keeps only the tail of an oversized stdout (runner summaries print last)", () => {
		const big = `${"x".repeat(20_000)}\nTests  7 passed (7)`;
		const e = post({ tool_response: { stdout: big } });
		liftOutcomeEvidence(e);
		expect(e.stdout?.length).toBeLessThanOrEqual(8_192);
		expect(e.stdout?.endsWith("Tests  7 passed (7)")).toBe(true);
	});
});

describe("liftOutcomeEvidence — negative (must not misclassify or clobber)", () => {
	it("N1: idempotent — an event with tool_outcome already set is left untouched", () => {
		const e = post({ tool_outcome: "error", tool_response: { stdout: "ok" } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBe("error");
		expect(e.stdout).toBeUndefined();
	});

	it("N2: a pre-tool event gains nothing", () => {
		const e = post({ hook_event: "PreToolUse", tool_response: { stdout: "ok" } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBeUndefined();
		expect(e.stdout).toBeUndefined();
	});

	it("N3: is_error true means error, never success", () => {
		const e = post({ tool_response: { stdout: "ok", is_error: true } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBe("error");
	});

	it("N4: a nonzero exit code means error even on a plain PostToolUse", () => {
		const e = post({ tool_response: { stdout: "", exitCode: 1 } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBe("error");
	});

	it("N5: interrupted true means interrupted, never success", () => {
		const e = post({ tool_response: { stdout: "partial", interrupted: true } });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBe("interrupted");
	});

	it("N6: a string tool_response is left alone entirely", () => {
		const e = post({ tool_response: "plain text" });
		liftOutcomeEvidence(e);
		expect(e.tool_outcome).toBeUndefined();
		expect(e.stdout).toBeUndefined();
	});

	it("N7: hand-set stdout is never clobbered by the response object", () => {
		const e = post({ stdout: "original", tool_response: { stdout: "other" } });
		liftOutcomeEvidence(e);
		expect(e.stdout).toBe("original");
	});
});

describe("liftOutcomeEvidence — wiring pin", () => {
	it("processEvent lifts evidence BEFORE recording the event on the session", () => {
		// Both socket protocols funnel through processEvent; if the lift call
		// moves below recordEvent (or disappears), trackErrorOutcome and the
		// TDD-cycle trackers read un-lifted fields and the green-drop wedge
		// returns. Source-pin the ordering.
		const src = readFileSync(join(__dirname, "server-event-loop.ts"), "utf8");
		const liftAt = src.indexOf("liftOutcomeEvidence(event)");
		const recordAt = src.indexOf("sessions.recordEvent(event)");
		expect(liftAt).toBeGreaterThan(-1);
		expect(recordAt).toBeGreaterThan(-1);
		expect(liftAt).toBeLessThan(recordAt);
	});
});
