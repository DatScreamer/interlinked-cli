// Behavioral tests for the harness server event loop (`createEventLoop`).
//
// The factory closes over a bag of sibling-module functions and `deps`
// callbacks. We mock every sibling import so each branch (parse failure,
// lazy hydrate, lifecycle early-return, Pre/Post dispatch, non-tool allow,
// latency-append failure, snapshot write/serialize failure, framed error
// rethrow) can be driven deterministically and asserted on real outputs +
// real call effects — no source-text scraping, no real fs / net / clock.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

// ---- mock every sibling module the loop imports ---------------------------

vi.mock("./cloud-forward.js", () => ({
	forwardCloudPreToolUse: vi.fn(),
}));
vi.mock("./latency-log.js", () => ({
	appendLatencyLog: vi.fn(),
}));
vi.mock("./legacy-client.js", () => ({
	toLegacyHarnessEvent: vi.fn(),
}));
vi.mock("./live-snapshot.js", () => ({
	readLiveSnapshot: vi.fn(),
	writeLiveSnapshot: vi.fn(),
}));
vi.mock("./server/latency-record.js", () => ({
	buildLatencyRecord: vi.fn(),
}));
vi.mock("./server/lifecycle-events.js", () => ({
	handleLifecycleEvent: vi.fn(),
}));
vi.mock("./server/post-tool-pipeline.js", () => ({
	runPostToolPipeline: vi.fn(),
}));
vi.mock("./server/pre-tool-pipeline.js", () => ({
	runPreToolPipeline: vi.fn(),
}));
vi.mock("./server/protocol-status.js", () => ({
	recordProtocolEvent: vi.fn(),
	writeProtocolStatus: vi.fn(),
}));

// `isPreToolUse` / `isPostToolUse` are pure — use the real impls so the
// hook_event → branch mapping is exercised end-to-end.


// Pull the mocked references so individual tests can program return values.
import { forwardCloudPreToolUse } from "./cloud-forward.js";
import { appendLatencyLog } from "./latency-log.js";
import { toLegacyHarnessEvent } from "./legacy-client.js";
import { readLiveSnapshot, writeLiveSnapshot } from "./live-snapshot.js";
import { buildLatencyRecord } from "./server/latency-record.js";
import { handleLifecycleEvent } from "./server/lifecycle-events.js";
import { runPostToolPipeline } from "./server/post-tool-pipeline.js";
import { runPreToolPipeline } from "./server/pre-tool-pipeline.js";
import {
	recordProtocolEvent as bumpProtocolEvent,
	writeProtocolStatus as persistProtocolStatus,
} from "./server/protocol-status.js";
import { createEventLoop, type EventLoopDeps } from "./server-event-loop.js";

const mForward = vi.mocked(forwardCloudPreToolUse);
const mAppendLatency = vi.mocked(appendLatencyLog);
const mToLegacy = vi.mocked(toLegacyHarnessEvent);
const mReadSnap = vi.mocked(readLiveSnapshot);
const mWriteSnap = vi.mocked(writeLiveSnapshot);
const mBuildLatency = vi.mocked(buildLatencyRecord);
const mLifecycle = vi.mocked(handleLifecycleEvent);
const mPostPipeline = vi.mocked(runPostToolPipeline);
const mPrePipeline = vi.mocked(runPreToolPipeline);
const mBump = vi.mocked(bumpProtocolEvent);
const mPersist = vi.mocked(persistProtocolStatus);

const ALLOW: HarnessDecision = { decision: "allow" };

// ---- fakes for ctx + deps -------------------------------------------------

interface FakeSession {
	tool_call_count: number;
	files_written: Set<string>;
}

function makeHarness() {
	const log = vi.fn();
	const sessionMap = new Map<string, FakeSession>();

	const sessions = {
		get: vi.fn((id: string) => sessionMap.get(id)),
		hydrate: vi.fn((_snap: JsonObject) => null as FakeSession | null),
		recordEvent: vi.fn((_e: HarnessEvent) => ({ tag: "session" })),
		serialize: vi.fn((_id: string) => ({ snap: true }) as JsonObject | null),
	};

	const ctx = {
		cwd: "/repo",
		interlinkedDir: "/repo/.interlinked",
		log,
		sessions,
	} as unknown as EventLoopDeps["ctx"];

	const protocolStatus = {
		raw_event_count: 0,
		framed_event_count: 0,
		framed_error_count: 0,
		framed_timeout_count: 0,
	} as unknown as EventLoopDeps["protocolStatus"];

	const deps: EventLoopDeps = {
		ctx,
		protocolStatus,
		protocolStatusPath: "/repo/.interlinked/harness-protocol.json",
		resetIdleTimer: vi.fn(),
		syncRuntimeIn: vi.fn(),
		syncRuntimeOut: vi.fn(),
		writeCollectionRecord: vi.fn(),
	};

	return { deps, ctx, sessions, sessionMap, log, protocolStatus };
}

function preEvent(extra: Partial<HarnessEvent> = {}): string {
	return JSON.stringify({
		hook_event: "PreToolUse",
		session_id: "s1",
		tool_name: "Bash",
		tool_input: { command: "ls" },
		...extra,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// Sensible defaults: no lifecycle short-circuit, pipelines allow, cloud
	// passthrough, snapshot writes succeed, latency record is a stub object.
	mLifecycle.mockResolvedValue(null);
	mPrePipeline.mockResolvedValue(ALLOW);
	mPostPipeline.mockResolvedValue(ALLOW);
	mForward.mockImplementation(async (_e, local) => local);
	mWriteSnap.mockReturnValue({ ok: true });
	mReadSnap.mockReturnValue(null);
	mBuildLatency.mockReturnValue({ decision: "allow" } as ReturnType<typeof buildLatencyRecord>);
	mToLegacy.mockImplementation((e) => e as unknown as HarnessEvent);
});

describe("createEventLoop — public surface", () => {
	it("returns the three entry points", () => {
		const loop = createEventLoop(makeHarness().deps);
		expect(typeof loop.evaluateEventLine).toBe("function");
		expect(typeof loop.evaluateUnifiedViaRuntime).toBe("function");
		expect(typeof loop.writeProtocolStatus).toBe("function");
	});

	it("writeProtocolStatus persists the in-memory status to its path", () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);
		loop.writeProtocolStatus();
		expect(mPersist).toHaveBeenCalledWith(h.deps.protocolStatusPath, h.protocolStatus);
	});
});

describe("processEvent — parse + dispatch (via evaluateEventLine)", () => {
	it("blocks on malformed JSON and logs the parse failure", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine("{not json", "raw");

		expect(decision).toEqual({
			decision: "block",
			reason: "Malformed event — cannot evaluate safety.",
		});
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("Event parse failed:"));
		// Even a parse failure still counts as a processed protocol event +
		// writes a latency record.
		expect(mBump).toHaveBeenCalledWith(h.protocolStatus, "raw");
		expect(mAppendLatency).toHaveBeenCalledTimes(1);
		// Malformed payload never reached recordEvent / pipelines.
		expect(h.sessions.recordEvent).not.toHaveBeenCalled();
		expect(mPrePipeline).not.toHaveBeenCalled();
	});

	it("surfaces the non-Error cause via String() in the parse-failure log", async () => {
		const h = makeHarness();
		// Force every JSON.parse to throw a non-Error. evaluateEventLine's
		// up-front session_id parse throws first (swallowed by `void e`), then
		// processEvent's parse throws the same non-Error and exercises the
		// `String(cause)` branch of the parse-failure log.
		const spy = vi.spyOn(JSON, "parse").mockImplementation(() => {
			throw "boom-string";
		});
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(decision.decision).toBe("block");
		expect(h.log).toHaveBeenCalledWith("Event parse failed: boom-string");
		spy.mockRestore();
	});

	it("resets the idle timer and records the event for a valid payload", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.deps.resetIdleTimer).toHaveBeenCalledTimes(1);
		expect(h.sessions.recordEvent).toHaveBeenCalledTimes(1);
		expect(h.deps.syncRuntimeIn).toHaveBeenCalledTimes(1);
		expect(h.deps.syncRuntimeOut).toHaveBeenCalledTimes(1);
	});

	it("PreToolUse: runs pre-pipeline, writes collection record, forwards to cloud", async () => {
		const h = makeHarness();
		const blocked: HarnessDecision = { decision: "block", reason: "cloud" };
		mForward.mockResolvedValueOnce(blocked);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(mPrePipeline).toHaveBeenCalledTimes(1);
		expect(h.deps.writeCollectionRecord).toHaveBeenCalledTimes(1);
		expect(mForward).toHaveBeenCalledWith(expect.objectContaining({ hook_event: "PreToolUse" }), ALLOW);
		expect(decision).toBe(blocked);
		expect(mPostPipeline).not.toHaveBeenCalled();
	});

	it("PostToolUse: runs post-pipeline, writes collection record, returns its decision", async () => {
		const h = makeHarness();
		const warn: HarnessDecision = { decision: "allow", warnings: ["w"] };
		mPostPipeline.mockResolvedValueOnce(warn);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "PostToolUse" }),
			"framed",
		);

		expect(mPostPipeline).toHaveBeenCalledTimes(1);
		expect(h.deps.writeCollectionRecord).toHaveBeenCalledTimes(1);
		expect(decision).toBe(warn);
		expect(mForward).not.toHaveBeenCalled();
	});

	it("PostToolUse: fails OPEN (allow) when the post-pipeline throws", async () => {
		// A thrown PostToolUse check used to propagate into a reason-less block
		// (surfaced to users as a spurious "harness bug"). The action already
		// happened, so blocking is wrong — fail open with a warning instead.
		const h = makeHarness();
		mPostPipeline.mockRejectedValueOnce(new Error("check boom"));
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "PostToolUse" }),
			"framed",
		);

		expect(decision.decision).toBe("allow");
		expect(decision.warnings?.join(" ")).toContain("PostToolUse check errored");
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("PostToolUse pipeline threw"));
	});

	it("non-tool event (no Pre/Post match) returns a bare allow", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(
			preEvent({ hook_event: "Notification", tool_name: undefined, tool_input: undefined }),
			"raw",
		);

		expect(decision).toEqual({ decision: "allow" });
		expect(mPrePipeline).not.toHaveBeenCalled();
		expect(mPostPipeline).not.toHaveBeenCalled();
		expect(h.deps.writeCollectionRecord).not.toHaveBeenCalled();
	});

	it("lifecycle decision short-circuits before Pre/Post dispatch", async () => {
		const h = makeHarness();
		const lc: HarnessDecision = { decision: "block", reason: "lifecycle" };
		mLifecycle.mockResolvedValueOnce(lc);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(decision).toBe(lc);
		expect(mPrePipeline).not.toHaveBeenCalled();
		expect(mPostPipeline).not.toHaveBeenCalled();
		// finally still ran.
		expect(h.deps.syncRuntimeOut).toHaveBeenCalledTimes(1);
	});

	it("runs syncRuntimeOut in finally even when a pipeline throws", async () => {
		const h = makeHarness();
		mPrePipeline.mockRejectedValueOnce(new Error("pipeline blew up"));
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateEventLine(preEvent(), "raw")).rejects.toThrow(
			"pipeline blew up",
		);
		expect(h.deps.syncRuntimeIn).toHaveBeenCalledTimes(1);
		expect(h.deps.syncRuntimeOut).toHaveBeenCalledTimes(1);
	});
});

describe("processEvent — lazy hydrate branch", () => {
	it("hydrates from a live snapshot and logs when restore succeeds", async () => {
		const h = makeHarness();
		mReadSnap.mockReturnValueOnce({ restored: true });
		h.sessions.hydrate.mockReturnValueOnce({
			tool_call_count: 4,
			files_written: new Set(["a.ts", "b.ts"]),
		});
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(mReadSnap).toHaveBeenCalledWith("/repo", "s1");
		expect(h.sessions.hydrate).toHaveBeenCalledWith({ restored: true });
		expect(h.log).toHaveBeenCalledWith(
			expect.stringContaining("Hydrated session s1 from live snapshot (4 tool calls, 2 files written)"),
		);
	});

	it("does not log when a snapshot exists but hydrate returns null", async () => {
		const h = makeHarness();
		mReadSnap.mockReturnValueOnce({ restored: true });
		h.sessions.hydrate.mockReturnValueOnce(null);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.sessions.hydrate).toHaveBeenCalledTimes(1);
		expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("Hydrated session"));
	});

	it("skips hydrate entirely when no snapshot is on disk", async () => {
		const h = makeHarness();
		mReadSnap.mockReturnValueOnce(null);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(mReadSnap).toHaveBeenCalledTimes(1);
		expect(h.sessions.hydrate).not.toHaveBeenCalled();
	});

	it("skips the hydrate lookup when the session is already tracked", async () => {
		const h = makeHarness();
		h.sessionMap.set("s1", { tool_call_count: 0, files_written: new Set() });
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(mReadSnap).not.toHaveBeenCalled();
	});

	it("skips the hydrate lookup when the event has no session_id", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		// session_id "" is falsy → hydrate guard short-circuits.
		await loop.evaluateEventLine(preEvent({ session_id: "" }), "raw");

		expect(mReadSnap).not.toHaveBeenCalled();
	});
});

describe("evaluateEventLine — protocol counter + latency + snapshot durability", () => {
	it("records a framed protocol event and appends the latency record", async () => {
		const h = makeHarness();
		const latency = { decision: "allow", tool_name: "Bash" } as ReturnType<
			typeof buildLatencyRecord
		>;
		mBuildLatency.mockReturnValueOnce(latency);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "framed");

		expect(mBump).toHaveBeenCalledWith(h.protocolStatus, "framed");
		// recordProtocolEvent also persists the status after bumping.
		expect(mPersist).toHaveBeenCalled();
		expect(mBuildLatency).toHaveBeenCalledWith(preEvent(), ALLOW);
		expect(mAppendLatency).toHaveBeenCalledWith("/repo/.interlinked", latency);
	});

	it("swallows a latency-append failure without affecting the decision", async () => {
		const h = makeHarness();
		mAppendLatency.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateEventLine(preEvent(), "raw");

		expect(decision).toEqual(ALLOW);
		// snapshot durability still ran afterward.
		expect(mWriteSnap).toHaveBeenCalledTimes(1);
	});

	it("writes a live snapshot in the finally block when session_id parses", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockReturnValueOnce({ persisted: true });
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.sessions.serialize).toHaveBeenCalledWith("s1");
		expect(mWriteSnap).toHaveBeenCalledWith("/repo", "s1", { persisted: true });
	});

	it("logs (non-fatal) when the snapshot write reports !ok", async () => {
		const h = makeHarness();
		mWriteSnap.mockReturnValueOnce({ ok: false, error: new Error("EACCES") });
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.log).toHaveBeenCalledWith("Live snapshot write failed (non-fatal): EACCES");
	});

	it("does not write a snapshot when serialize returns null", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockReturnValueOnce(null);
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.sessions.serialize).toHaveBeenCalledWith("s1");
		expect(mWriteSnap).not.toHaveBeenCalled();
	});

	it("logs when serialize throws an Error inside the durability finally", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockImplementationOnce(() => {
			throw new Error("serialize boom");
		});
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.log).toHaveBeenCalledWith("Live snapshot write threw: serialize boom");
	});

	it("stringifies a non-Error throw inside the durability finally", async () => {
		const h = makeHarness();
		h.sessions.serialize.mockImplementationOnce(() => {
			throw "plain-string-throw";
		});
		const loop = createEventLoop(h.deps);

		await loop.evaluateEventLine(preEvent(), "raw");

		expect(h.log).toHaveBeenCalledWith("Live snapshot write threw: plain-string-throw");
	});

	it("skips the snapshot write when the line has no string session_id", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		// session_id is numeric here → typeof !== "string" → sessionIdForSnap stays null.
		await loop.evaluateEventLine(
			JSON.stringify({ hook_event: "Notification", session_id: 123 }),
			"raw",
		);

		expect(mWriteSnap).not.toHaveBeenCalled();
		expect(h.sessions.serialize).not.toHaveBeenCalled();
	});

	it("swallows a malformed line during the up-front session_id parse (catch void e)", async () => {
		const h = makeHarness();
		const loop = createEventLoop(h.deps);

		// Malformed line: the up-front parse throws (caught), processEvent then
		// blocks. sessionIdForSnap stays null so no snapshot write is attempted.
		const decision = await loop.evaluateEventLine("####", "raw");

		expect(decision.decision).toBe("block");
		expect(mWriteSnap).not.toHaveBeenCalled();
	});

	it("still writes the snapshot in finally when processEvent throws (session captured up-front)", async () => {
		const h = makeHarness();
		mPrePipeline.mockRejectedValueOnce(new Error("kaboom"));
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateEventLine(preEvent(), "raw")).rejects.toThrow("kaboom");
		// session_id was parsed before the try, so the finally still persists.
		expect(mWriteSnap).toHaveBeenCalledWith("/repo", "s1", { snap: true });
	});
});

describe("evaluateUnifiedViaRuntime", () => {
	it("translates a unified event to legacy and evaluates it as framed", async () => {
		const h = makeHarness();
		const legacy = JSON.parse(preEvent()) as HarnessEvent;
		mToLegacy.mockReturnValueOnce(legacy);
		const loop = createEventLoop(h.deps);

		const decision = await loop.evaluateUnifiedViaRuntime({ any: "unified" } as never);

		expect(mToLegacy).toHaveBeenCalledWith({ any: "unified" });
		expect(decision).toEqual(ALLOW);
		// Routed through the framed protocol counter.
		expect(mBump).toHaveBeenCalledWith(h.protocolStatus, "framed");
	});

	it("on translation failure: bumps framed_error_count, persists, and rethrows", async () => {
		const h = makeHarness();
		const err = new Error("legacy convert failed");
		mToLegacy.mockImplementationOnce(() => {
			throw err;
		});
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateUnifiedViaRuntime({ x: 1 } as never)).rejects.toBe(err);
		expect(h.protocolStatus.framed_error_count).toBe(1);
		expect(mPersist).toHaveBeenCalledWith(h.deps.protocolStatusPath, h.protocolStatus);
		// The error path short-circuits before any event processing.
		expect(h.sessions.recordEvent).not.toHaveBeenCalled();
	});

	it("propagates an error thrown by the inner evaluateEventLine and counts it", async () => {
		const h = makeHarness();
		mToLegacy.mockReturnValueOnce(JSON.parse(preEvent()) as HarnessEvent);
		// Make the inner pipeline throw so evaluateEventLine rejects after
		// translation succeeded — exercises the catch wrapping the await.
		mPrePipeline.mockRejectedValueOnce(new Error("inner reject"));
		const loop = createEventLoop(h.deps);

		await expect(loop.evaluateUnifiedViaRuntime({ x: 1 } as never)).rejects.toThrow(
			"inner reject",
		);
		expect(h.protocolStatus.framed_error_count).toBe(1);
	});
});
