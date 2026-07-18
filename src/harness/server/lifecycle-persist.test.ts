// Behavioral companion for lifecycle-persist.ts. The source-text security
// pins (sanitize + containment) live in lifecycle-events.test.ts and read
// this file; these cases drive the write/reject/cleanup behavior directly.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFreshSession } from "../session-state-mutators.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { cleanupSessionState, persistSessionTrajectory } from "./lifecycle-persist.js";
import type { ServerRuntime } from "./runtime-context.js";

let dir: string;

function makeEvent(sessionId: string): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: sessionId,
		agent_source: "claude",
		agent_name: "tester",
		timestamp: new Date().toISOString(),
		cwd: dir,
	} as HarnessEvent;
}

// SAFETY: persistSessionTrajectory reads only cwd/log/sessions.serialize;
// cleanupSessionState additionally touches the stubbed collaborators below.
function makeCtx(overrides: Partial<Record<string, unknown>> = {}): ServerRuntime {
	return {
		cwd: dir,
		log: vi.fn(),
		sessions: { serialize: () => ({ session_id: "s" }), remove: vi.fn() },
		cohort: { agentLeft: vi.fn() },
		reservations: { releaseAllForAgent: vi.fn() },
		asyncFindings: { clearSession: vi.fn() },
		classifierSessions: new Map(),
		autoCoordStates: new Map(),
		...overrides,
	} as unknown as ServerRuntime;
}

const turnSummary = { turn_patterns: [] } as unknown as ReturnType<
	typeof import("../turn-end.js").buildTurnEndSummary
>;

let session: SessionTrajectory;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lifecycle-persist-"));
	// A real trajectory: persistSessionTrajectory feeds it through
	// computeEffectivenessSummary, which walks several of its Maps/Sets.
	session = createFreshSession(makeEvent("seed"), "seed");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("persistSessionTrajectory", () => {
	it("writes the trajectory json with the turn summary attached", async () => {
		const ctx = makeCtx();
		await persistSessionTrajectory({ ctx, event: makeEvent("good-id"), session, turnSummary });
		const path = join(dir, ".interlinked", "sessions", "good-id.trajectory.json");
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8")).turn_summary).toEqual({ turn_patterns: [] });
	});

	it("refuses a session id that sanitizes to nothing (non-fatal, logged)", async () => {
		const ctx = makeCtx();
		await persistSessionTrajectory({ ctx, event: makeEvent(""), session, turnSummary });
		const logged = vi.mocked(ctx.log).mock.calls.flat().join("\n");
		expect(logged).toMatch(/Failed to save trajectory \(non-fatal\)/);
		expect(logged).toMatch(/no safe characters/);
	});

	it("no-ops when the session cannot be serialized", async () => {
		const ctx = makeCtx({ sessions: { serialize: () => null, remove: vi.fn() } });
		await persistSessionTrajectory({ ctx, event: makeEvent("x"), session, turnSummary });
		expect(existsSync(join(dir, ".interlinked", "sessions"))).toBe(false);
	});
});

describe("cleanupSessionState", () => {
	it("tears down cohort, reservations, session map, and per-session state", () => {
		const ctx = makeCtx();
		ctx.classifierSessions.set("sess-1", {} as never);
		ctx.autoCoordStates.set("sess-1", {} as never);
		cleanupSessionState(ctx, makeEvent("sess-1"), session);
		expect(vi.mocked(ctx.cohort.agentLeft)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(ctx.reservations.releaseAllForAgent)).toHaveBeenCalledWith(
			"tester",
			ctx.cohort,
		);
		expect(vi.mocked(ctx.sessions.remove)).toHaveBeenCalledWith("sess-1");
		expect(vi.mocked(ctx.asyncFindings.clearSession)).toHaveBeenCalledWith("sess-1");
		expect(ctx.classifierSessions.has("sess-1")).toBe(false);
		expect(ctx.autoCoordStates.has("sess-1")).toBe(false);
	});
});
