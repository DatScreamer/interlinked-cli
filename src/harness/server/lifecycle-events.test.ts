import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";
import { handleLifecycleEvent, resolveParentSessionId } from "./lifecycle-events.js";
import type { ServerRuntime } from "./runtime-context.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-lc-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "SessionStart",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

/** A ServerRuntime stub carrying only what handleLifecycleEvent reads for
 *  the arms exercised here. */
function makeCtx(over: Partial<ServerRuntime> = {}): ServerRuntime {
	const base = {
		cwd: tmp,
		interlinkedDir: join(tmp, ".interlinked"),
		rules: { rules: [], content_scanner: undefined },
		cohort: new CohortManager(),
		sessions: new SessionTracker(),
		trigramIndex: null,
		contentScanner: undefined,
		classifierSessions: new Map(),
		autoCoordStates: new Map(),
		asyncFindings: { clearSession: () => {} },
		asyncAnalysis: { drain: async () => {} },
		reservations: { releaseAllForAgent: () => {} },
		filePriorityMap: new Map(),
		log: () => {},
		logAlways: () => {},
	};
	return { ...base, ...over } as unknown as ServerRuntime;
}

describe("resolveParentSessionId", () => {
	it("returns undefined when no parent linkage is present", () => {
		const cohort = new CohortManager();
		const sessions = new SessionTracker();
		expect(
			resolveParentSessionId(ev({ hook_event: "SubagentStop" }), cohort, sessions),
		).toBeUndefined();
	});

	it("resolves the parent session_id directly when the linkage is a session id", () => {
		const cohort = new CohortManager();
		const sessions = new SessionTracker();
		sessions.recordEvent(ev({ session_id: "parent-sess" }));
		const out = resolveParentSessionId(
			ev({
				hook_event: "SubagentStop",
				tool_input: { parent_agent: "parent-sess" },
			}),
			cohort,
			sessions,
		);
		expect(out).toBe("parent-sess");
	});

	it("maps a parent agent name back to its session id via the cohort", () => {
		const cohort = new CohortManager();
		const sessions = new SessionTracker();
		cohort.agentJoined(ev({ session_id: "p-sess", agent_name: "parent-agent" }));
		sessions.recordEvent(ev({ session_id: "p-sess", agent_name: "parent-agent" }));
		const out = resolveParentSessionId(
			ev({ hook_event: "SubagentStop", parent_agent: "parent-agent" }),
			cohort,
			sessions,
		);
		expect(out).toBe("p-sess");
	});
});

describe("handleLifecycleEvent", () => {
	it("returns null (fall-through) for SubagentStart", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SubagentStart" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SubagentStart" }),
			session,
		);
		expect(out).toBeNull();
	});

	it("returns null (fall-through) for an unrecognized non-tool event", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "Notification" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "Notification" }),
			session,
		);
		expect(out).toBeNull();
	});

	it("SkillList returns an allow decision with JSON additional_context", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SkillList" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SkillList" }),
			session,
		);
		expect(out?.decision).toBe("allow");
		expect(() => JSON.parse(out?.additional_context ?? "")).not.toThrow();
	});

	it("SkillEnter without a name returns an allow decision carrying a warning", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SkillEnter" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SkillEnter", tool_input: {} }),
			session,
		);
		expect(out?.decision).toBe("allow");
		expect(out?.warnings?.[0]).toMatch(/missing tool_input\.name/);
	});

	it("SessionEnd returns an allow decision and removes the session", async () => {
		const ctx = makeCtx();
		const session = ctx.sessions.recordEvent(ev({ hook_event: "SessionEnd" }));
		const out = await handleLifecycleEvent(
			ctx,
			ev({ hook_event: "SessionEnd" }),
			session,
		);
		expect(out?.decision).toBe("allow");
		expect(ctx.sessions.get("s")).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Trajectory-write path-traversal regression.
//
// The SessionEnd / Stop arm of handleLifecycleEvent writes the session
// trajectory to .interlinked/sessions/<id>.trajectory.json. event.session_id
// arrives over the Unix socket as arbitrary JSON-parsed data; passing it
// straight through path.join would let "../../../.config/target" escape the
// sessions dir (path.join collapses ../ rather than rejecting it).
//
// The fix — moved here verbatim with the SessionEnd handler from server.ts:
//   1. sanitizeSessionId (whitelist charset + length cap) before path build.
//   2. Defense-in-depth: resolve() the target and require it under
//      resolve(sessDir) + sep (or equal to it) before writing.
//
// These source-level assertions pin both halves in place. (The behavioral
// guarantees of sanitizeSessionId itself live in
// __tests__/server-trajectory-write.test.ts.)
const LIFECYCLE_TS = resolve(fileURLToPath(new URL(".", import.meta.url)), "lifecycle-events.ts");

describe("lifecycle trajectory write - path traversal regression", () => {
	const source = readFileSync(LIFECYCLE_TS, "utf-8");

	it("imports sanitizeSessionId from session-paths", () => {
		expect(source).toMatch(
			/import\s*\{[^}]*\bsanitizeSessionId\b[^}]*\}\s*from\s*["']\.\.\/session-paths\.js["']/,
		);
	});

	it("applies sanitizeSessionId before building the trajectory path", () => {
		expect(source).toContain("sanitizeSessionId(event.session_id)");
		expect(source).toContain("`${safeId}.trajectory.json`");
	});

	it("does NOT concatenate raw event.session_id into the trajectory filename", () => {
		expect(source).not.toContain("${event.session_id}.trajectory.json");
	});

	it("performs a resolve-and-containment check before writing", () => {
		expect(source).toMatch(/resolve\s*\(\s*sessDir\s*\)/);
		expect(source).toMatch(/resolve\s*\(\s*targetPath\s*\)/);
		expect(source).toContain("resolvedDir + sep");
	});

	it("throws (triggering tryFn error path) when sanitization produces an empty id", () => {
		expect(source).toContain('throw new Error("invalid session_id: no safe characters")');
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Stop-event pattern rescan wiring regression.
//
// `buildPatternRescanWarnings` from stop-rescan.ts must be called from
// `buildStopWarnings` so every Stop runs the deterministic pattern rescan
// over `session.files_written`. The function itself has dedicated unit
// coverage in stop-rescan.test.ts; this assertion pins the WIRING so a
// future refactor that drops the call from the Stop path fails loudly.

describe("Stop-event pattern rescan wiring", () => {
	const source = readFileSync(LIFECYCLE_TS, "utf-8");

	it("imports buildPatternRescanWarnings from stop-rescan", () => {
		expect(source).toMatch(
			/import\s*\{[^}]*\bbuildPatternRescanWarnings\b[^}]*\}\s*from\s*["']\.\.\/stop-rescan\.js["']/,
		);
	});

	it("invokes buildPatternRescanWarnings inside buildStopWarnings", () => {
		// The wiring sits between the verification-stop-checks block and the
		// function's return — flexible match so refactors that keep the call
		// but move surrounding code still pass.
		expect(source).toMatch(/buildPatternRescanWarnings\s*\(\s*session\s*,/);
	});
});
