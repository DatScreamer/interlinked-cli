// ===========================================
// interlinked sync — behavioral coverage
// ===========================================
// Deep behavioral tests for `syncCommand`. Every module boundary that touches
// fs / network / state is mocked so each branch runs deterministically with no
// real I/O:
//   - ../lib/local-activity (getLocalStats / getUnsyncedEvents / readSyncState /
//     updateSyncState / appendSyncError) for the cursor + stats + error log
//   - ../lib/config (resolveConfig) for server_url / workspace_id / keys
//   - ../lib/auth (resolveAuthToken) for the Bearer-token gate
//   - ../lib/secrets (loadScrubConfig / scrubEgressPayload / recordScrub) for
//     the egress redaction accounting
//   - global fetch (ok / non-ok 401 / non-ok 5xx-retry / non-ok 4xx-fatal /
//     network throw / AbortError timeout)
// We deliberately do NOT mock ../lib/output or ../lib/formatter so the real
// renderer strings (the bulk of this module) are exercised and asserted.
// console.log / console.error capture the human + json output; process.stderr
// captures the per-batch failure lines; process.exitCode captures error paths.
// Fake timers drive the retry-backoff sleeps without wall-clock waits.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalActivityEvent, UnsyncedEvents } from "../lib/local-activity.js";
import { nonNull } from "../lib/non-null.js";

// ---- ../lib/local-activity mock ---------------------------------------
const mockGetLocalStats = vi.fn<() => { pending_sync: number } & Record<string, unknown>>();
const mockGetUnsyncedEvents = vi.fn<(limit?: number) => UnsyncedEvents>();
const mockReadSyncState = vi.fn<() => {
	synced_through_bytes: number;
	last_sync_at: string;
	last_summary?: Record<string, unknown>;
}>();
const mockUpdateSyncState = vi.fn<(offset: number, summary?: unknown) => void>();
const mockAppendSyncError = vi.fn<(entry: Record<string, unknown>) => void>();

vi.mock("../lib/local-activity.js", () => ({
	getLocalStats: () => mockGetLocalStats(),
	getUnsyncedEvents: (limit?: number) => mockGetUnsyncedEvents(limit),
	readSyncState: () => mockReadSyncState(),
	updateSyncState: (offset: number, summary?: unknown) => mockUpdateSyncState(offset, summary),
	appendSyncError: (entry: Record<string, unknown>) => mockAppendSyncError(entry),
}));

// ---- ../lib/config mock -----------------------------------------------
interface FakeConfig {
	server_url: string;
	workspace_id?: string;
	default_workspace_key?: string;
	default_project?: string;
	sync_mode: string;
}
const mockResolveConfig = vi.fn<() => FakeConfig>();
vi.mock("../lib/config.js", () => ({
	resolveConfig: () => mockResolveConfig(),
}));

// ---- ../lib/auth mock -------------------------------------------------
const mockResolveAuthToken = vi.fn<() => string | null>();
vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: () => mockResolveAuthToken(),
}));

// ---- ../lib/secrets mock ----------------------------------------------
// scrubEgressPayload reports {found,types}; tests that want scrub accounting
// script mockScrubResult to a positive `found`.
let mockScrubResult: { found: number; types: string[] };
const mockLoadScrubConfig = vi.fn<() => Record<string, unknown>>();
const mockScrubEgressPayload = vi.fn<() => { found: number; types: string[] }>();
const mockRecordScrub = vi.fn<(types: string[]) => void>();
vi.mock("../lib/secrets.js", () => ({
	loadScrubConfig: () => mockLoadScrubConfig(),
	scrubEgressPayload: () => mockScrubEgressPayload(),
	recordScrub: (types: string[]) => mockRecordScrub(types),
}));

import { syncCommand } from "./sync.js";

// --- capture helpers ---------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** Strip ANSI color codes so assertions hold regardless of color support. */
function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function stdout(): string {
	return plain((logSpy.mock.calls as unknown[][]).map((a) => String(a[0])).join("\n"));
}
function stderrConsole(): string {
	return plain((errSpy.mock.calls as unknown[][]).map((a) => String(a[0])).join("\n"));
}
function processStderr(): string {
	return plain((stderrSpy.mock.calls as unknown[][]).map((a) => String(a[0])).join(""));
}
/** Parse the single JSON blob console.log emitted in --json mode. */
function jsonOut(): Record<string, unknown> {
	const raw = (logSpy.mock.calls as unknown[][]).map((a) => String(a[0])).join("\n");
	return JSON.parse(raw) as Record<string, unknown>;
}
/** The init object handed to the Nth fetch call. */
function fetchInit(n = 0): RequestInit {
	const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
	return (fetchFn.mock.calls[n] as [string, RequestInit])[1];
}

/** Build a LocalActivityEvent with sensible defaults; override per test. */
function ev(over: Partial<LocalActivityEvent> = {}): LocalActivityEvent {
	return {
		ts: "2026-06-01T10:00:00.000Z",
		agent: "alice",
		type: "tool_use",
		tool: "Read",
		session: "s1",
		...over,
	};
}

/** A fetch Response stub for the ok-with-json path. */
function okRes(body: { accepted?: number; skipped?: number; errors?: number }): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}
/** A fetch Response stub for a non-ok status with a text body. */
function failRes(status: number, text = "boom"): Response {
	return {
		ok: false,
		status,
		json: async () => ({}),
		text: async () => text,
	} as unknown as Response;
}
/** A non-ok Response whose `.text()` rejects (exercises the `.catch(() => "")`). */
function failResTextThrows(status: number): Response {
	return {
		ok: false,
		status,
		json: async () => ({}),
		text: async () => {
			throw new Error("body read failed");
		},
	} as unknown as Response;
}

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	process.exitCode = undefined;

	// Default happy-path scripting (overridden per test as needed).
	mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
	mockGetUnsyncedEvents.mockReturnValue({ events: [ev()], newOffset: 4096 });
	mockReadSyncState.mockReturnValue({ synced_through_bytes: 0, last_sync_at: "" });
	mockResolveConfig.mockReturnValue({
		server_url: "https://api.example.com",
		workspace_id: "ws-123",
		default_workspace_key: "wkey",
		default_project: "proj",
		sync_mode: "realtime",
	});
	mockResolveAuthToken.mockReturnValue("tok-abc");
	mockLoadScrubConfig.mockReturnValue({});
	mockScrubResult = { found: 0, types: [] };
	mockScrubEgressPayload.mockImplementation(() => mockScrubResult);

	const okResponse = okRes({ accepted: 1, skipped: 0, errors: 0 });
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async () => okResponse),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	process.exitCode = undefined;
});

// =======================================================================
// Early-exit branches (no network)
// =======================================================================

describe("syncCommand — up-to-date short-circuits", () => {
	it("pending_sync === 0 prints 'Already up to date' and skips fetch (normal)", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		await syncCommand({});
		expect(stdout()).toContain("Already up to date.");
		expect(stdout()).toContain("No unsynced events.");
		expect(fetch).not.toHaveBeenCalled();
		expect(mockGetUnsyncedEvents).not.toHaveBeenCalled();
	});

	it("pending_sync === 0 emits the JSON up-to-date envelope (json mode)", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		await syncCommand({ json: true });
		expect(jsonOut()).toEqual({ synced: 0, pending: 0, message: "Already up to date" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("empty unsynced batch (pending>0 but 0 events) short-circuits to up-to-date", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 5 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [], newOffset: 100 });
		await syncCommand({});
		expect(stdout()).toContain("Already up to date.");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("empty unsynced batch in JSON mode emits the up-to-date envelope", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 5 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [], newOffset: 100 });
		await syncCommand({ json: true });
		expect(jsonOut()).toEqual({ synced: 0, pending: 0, message: "Already up to date" });
	});

	it("formatUpToDate renders the rich last_summary block when present", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		mockReadSyncState.mockReturnValue({
			synced_through_bytes: 8192,
			last_sync_at: "2026-06-01T12:00:00.000Z",
			last_summary: {
				server_url: "https://api.example.com",
				workspace_id: "ws-123",
				events_total: 7,
				accepted: 6,
				skipped: 1,
				scrubbed: 0,
				batches: 1,
				by_type: { tool_use: 5, session_end: 2 },
				by_agent: { alice: 4, bob: 3 },
				top_tools: [["Read", 3]],
				sessions: 1,
				time_range: {
					earliest: "2026-06-01T10:00:00.000Z",
					latest: "2026-06-01T11:00:00.000Z",
				},
			},
		});
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Last sync:");
		expect(out).toContain("Server:    https://api.example.com");
		expect(out).toContain("Workspace: ws-123");
		// "1 session" singular (sessions === 1)
		expect(out).toContain("7 events (6 new, 1 dedup) across 1 session");
		expect(out).not.toContain("1 sessions");
		expect(out).toContain("Covering:");
		expect(out).toContain("Agents: alice, bob");
		// type summary, underscores spaced
		expect(out).toContain("5 tool use");
		expect(out).toContain("2 session end");
	});

	it("formatUpToDate pluralizes sessions and omits optional rows when absent", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		mockReadSyncState.mockReturnValue({
			synced_through_bytes: 1,
			last_sync_at: "2026-06-01T12:00:00.000Z",
			last_summary: {
				server_url: "https://api.example.com",
				workspace_id: null, // no Workspace row
				events_total: 3,
				accepted: 3,
				skipped: 0,
				scrubbed: 0,
				batches: 1,
				by_type: {}, // no Events row
				by_agent: {}, // no Agents row
				top_tools: [],
				sessions: 2, // plural
				time_range: { earliest: "", latest: "" }, // no Covering row
			},
		});
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("across 2 sessions");
		expect(out).not.toContain("Workspace:");
		expect(out).not.toContain("Covering:");
		expect(out).not.toContain("Agents:");
	});

	it("formatUpToDate omits the summary block when last_summary is absent", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 0, last_sync_at: "" });
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Already up to date.");
		expect(out).not.toContain("Last sync:");
	});
});

// =======================================================================
// Dry-run branch
// =======================================================================

describe("syncCommand — dry-run", () => {
	it("normal dry-run prints batch math and never calls fetch", async () => {
		// 250 events -> ceil(250/100) === 3 batches
		const events = Array.from({ length: 250 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 250 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 9999 });
		await syncCommand({ dryRun: true });
		const out = stdout();
		expect(out).toContain("Sync (dry-run)");
		expect(out).toContain("Pending events");
		expect(out).toContain("250");
		expect(out).toContain("Batches needed");
		expect(out).toContain("3");
		expect(out).toContain("New offset");
		expect(out).toContain("9999 bytes");
		expect(out).toContain("Run 'interlinked sync'");
		expect(fetch).not.toHaveBeenCalled();
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("json dry-run emits dry_run envelope with batches + sync_state", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [ev()], newOffset: 4096 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 42, last_sync_at: "x" });
		await syncCommand({ json: true, dryRun: true });
		const j = jsonOut();
		expect(j.dry_run).toBe(true);
		expect(j.pending_events).toBe(1);
		expect(j.batches).toBe(1);
		expect(j.sync_state).toEqual({ synced_through_bytes: 42, last_sync_at: "x" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("--limit is parsed and forwarded to getUnsyncedEvents", async () => {
		await syncCommand({ dryRun: true, limit: "50" });
		expect(mockGetUnsyncedEvents).toHaveBeenCalledWith(50);
	});

	it("omitting --limit forwards undefined (no cap)", async () => {
		await syncCommand({ dryRun: true });
		expect(mockGetUnsyncedEvents).toHaveBeenCalledWith(undefined);
	});
});

// =======================================================================
// Local-dev guard (workspace_id required)
// =======================================================================

describe("syncCommand — local-dev workspace guard", () => {
	it("localhost server without workspace_id errors out before fetch", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({});
		expect(stderrConsole()).toContain("workspace_id required for local dev sync");
		expect(process.exitCode).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("127.0.0.1 server without workspace_id also trips the guard (json error)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://127.0.0.1:8787",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({ json: true });
		const j = JSON.parse(stderrConsole()) as { error: string };
		expect(j.error).toContain("workspace_id required");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("localhost WITH workspace_id proceeds and omits the Bearer header (dev bypass)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			workspace_id: "ws-local",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "local",
		});
		await syncCommand({});
		expect(fetch).toHaveBeenCalledTimes(1);
		const headers = fetchInit(0).headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("production with no token still sends (no Authorization header)", async () => {
		mockResolveAuthToken.mockReturnValue(null);
		await syncCommand({});
		expect(fetch).toHaveBeenCalledTimes(1);
		const headers = fetchInit(0).headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});
});

// =======================================================================
// Happy-path success: cursor advance, headers, body, summary breakdown
// =======================================================================

describe("syncCommand — successful sync", () => {
	it("sends Bearer auth + workspace_uuid to prod and advances the cursor", async () => {
		await syncCommand({});
		expect(fetch).toHaveBeenCalledTimes(1);
		const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
		const url = (fetchFn.mock.calls[0] as [string, RequestInit])[0];
		const init = fetchInit(0);
		expect(url).toBe("https://api.example.com/api/hooks/activity/batch");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok-abc");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.workspace_key).toBe("wkey");
		expect(body.project_key).toBe("proj");
		expect(body.workspace_uuid).toBe("ws-123");
		expect(Array.isArray(body.events)).toBe(true);
		// cursor advanced to newOffset with a summary object
		expect(mockUpdateSyncState).toHaveBeenCalledTimes(1);
		expect(mockUpdateSyncState).toHaveBeenCalledWith(4096, expect.any(Object));
	});

	it("omits workspace_uuid from the body when no workspace_id is set", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({});
		const body = JSON.parse(fetchInit(0).body as string) as Record<string, unknown>;
		expect(body).not.toHaveProperty("workspace_uuid");
		// workspace_id is null in the summary path
		expect(mockUpdateSyncState).toHaveBeenCalledWith(
			4096,
			expect.objectContaining({ workspace_id: null }),
		);
	});

	it("renders the full Sync Complete breakdown (types/agents/tools/sessions/time)", async () => {
		const events: LocalActivityEvent[] = [
			ev({ type: "tool_use", tool: "Read", agent: "alice", session: "s1", ts: "2026-06-01T10:00:00.000Z" }),
			ev({ type: "tool_use", tool: "Read", agent: "alice", session: "s1", ts: "2026-06-01T10:05:00.000Z" }),
			ev({ type: "tool_use", tool: "Edit", agent: "bob", session: "s2", ts: "2026-06-01T09:00:00.000Z" }),
			ev({ type: "session_end", tool: null, agent: "alice", session: "s1", ts: "2026-06-01T11:00:00.000Z" }),
			// an "unknown" agent must be excluded from the agent breakdown
			ev({ type: "tool_use", tool: "Bash", agent: "unknown", session: "s3", ts: "2026-06-01T10:30:00.000Z" }),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: events.length });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			okRes({ accepted: 5, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Sync Complete");
		expect(out).toContain("Server");
		expect(out).toContain("https://api.example.com");
		expect(out).toContain("Workspace");
		expect(out).toContain("ws-123");
		expect(out).toContain("5 total (5 new, 0 dedup)");
		expect(out).toContain("Batches");
		// Time range present (earliest 09:00 -> latest 11:00)
		expect(out).toContain("Time Range");
		// Event types section, descending; underscores spaced
		expect(out).toContain("Event Types");
		expect(out).toContain("tool use");
		expect(out).toContain("session end");
		// Agents: alice(2 tool_use + 1 session_end = 3), bob(1); "unknown" excluded
		expect(out).toContain("Agents");
		expect(out).toContain("alice");
		expect(out).toContain("bob");
		expect(out).not.toMatch(/\bunknown\b/);
		// Top Tools section
		expect(out).toContain("Top Tools");
		expect(out).toContain("Read");
		expect(out).toContain("Edit");
		expect(out).toContain("Bash");
		// Sessions count (s1,s2,s3 => 3)
		expect(out).toContain("Sessions");
	});

	it("'... +N more' tool overflow line appears past the top-5", async () => {
		// 7 distinct tools, descending counts so top-5 leaves 2 others
		const tools = ["A", "B", "C", "D", "E", "F", "G"];
		const events: LocalActivityEvent[] = [];
		tools.forEach((t, idx) => {
			const count = tools.length - idx; // 7,6,5,4,3,2,1
			for (let i = 0; i < count; i++) {
				events.push(ev({ tool: t, session: `s${t}${i}` }));
			}
		});
		mockGetLocalStats.mockReturnValue({ pending_sync: events.length });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 7000 });
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			okRes({ accepted: events.length, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		expect(stdout()).toContain("... +2 more");
	});

	it("omits Time Range / Sessions sections when events carry neither ts-pair nor sessions", async () => {
		// events with empty ts and no session -> earliest/latest stay "", sessions empty
		mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ ts: "", session: null, tool: null })],
			newOffset: 1,
		});
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Sync Complete");
		expect(out).not.toContain("Time Range");
		// No Top Tools (tool null), no Sessions row
		expect(out).not.toContain("Top Tools");
		expect(out).not.toContain("Sessions");
	});

	it("JSON success envelope carries totals, breakdown, new_offset === newOffset", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			okRes({ accepted: 1, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.server_url).toBe("https://api.example.com");
		expect(j.workspace_id).toBe("ws-123");
		expect(j.accepted).toBe(1);
		expect(j.skipped).toBe(0);
		expect(j.errors).toBe(0);
		expect(j.batches_sent).toBe(1);
		expect(j.retries).toBe(0);
		expect(j.new_offset).toBe(4096);
		const breakdown = j.breakdown as Record<string, unknown>;
		expect(breakdown.sessions).toBe(1);
	});

	it("accumulates accepted/skipped across multiple batches", async () => {
		const events = Array.from({ length: 150 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 150 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 8000 });
		const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchFn
			.mockResolvedValueOnce(okRes({ accepted: 100, skipped: 0, errors: 0 }))
			.mockResolvedValueOnce(okRes({ accepted: 40, skipped: 10, errors: 0 }));
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(j.accepted).toBe(140);
		expect(j.skipped).toBe(10);
		expect(j.batches_sent).toBe(2);
		expect(mockUpdateSyncState).toHaveBeenCalledWith(8000, expect.any(Object));
	});

	it("missing accepted/skipped/errors in response default to 0 (|| branch)", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(okRes({}));
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.accepted).toBe(0);
		expect(j.skipped).toBe(0);
		expect(j.errors).toBe(0);
	});

	it("JSON success with no workspace_id reports workspace_id: null (|| null arm)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			okRes({ accepted: 1, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.workspace_id).toBeNull();
	});
});

// =======================================================================
// Per-event payload mapping: optional-field inclusion
// =======================================================================

describe("syncCommand — payload field mapping", () => {
	function sentEvent(): Record<string, unknown> {
		const body = JSON.parse(fetchInit(0).body as string) as {
			events: Record<string, unknown>[];
		};
		return nonNull(body.events[0]);
	}

	it("maps required fields with || fallbacks (agent/workspace/project)", async () => {
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ agent: "", workspace_key: null, project_key: null, tool: null, summary: null })],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.agent_name).toBe("unknown");
		expect(e.workspace_key).toBe("wkey"); // defaultWorkspaceKey
		expect(e.project_key).toBe("proj"); // defaultProjectKey
		expect(e.event_type).toBe("tool_use");
		expect(e.tool_name).toBeUndefined();
		expect(e.tool_input_summary).toBeUndefined();
	});

	it("includes the full set of v2/v3/v4 optional fields when present", async () => {
		mockGetUnsyncedEvents.mockReturnValue({
			events: [
				ev({
					duration_ms: 12,
					tokens: { input: 5, output: 6, cache_read: 7, cache_creation: 8 },
					parent_agent: "root",
					subagent_id: "sub-1",
					files_modified: ["a.ts"],
					hook: "PostToolUse",
					error: { code: "E" },
					tool_input: { x: 1 },
					tool_response: { y: 2 },
					prompt: "p",
					last_assistant_message: "lam",
					cwd: "/tmp",
					model: "claude",
					source: "cli",
					agent_type: "main",
					tool_use_id: "tu1",
					is_interrupt: false,
					notification_type: "nt",
					notification_title: "ntt",
					task_subject: "ts",
					task_id: "tid",
					task_description: "td",
					trigger: "trg",
					reason: "rsn",
					permission_mode: "pm",
					transcript_path: "/t",
					teammate_name: "tm",
					team_name: "team",
					custom_instructions: "ci",
					stop_hook_active: true,
					permission_suggestions: ["s"],
					agent_transcript_path: "/at",
				}),
			],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.duration_ms).toBe(12);
		expect(e.tokens_input).toBe(5);
		expect(e.tokens_output).toBe(6);
		expect(e.tokens_cache_read).toBe(7);
		expect(e.tokens_cache_creation).toBe(8);
		expect(e.parent_agent).toBe("root");
		expect(e.subagent_id).toBe("sub-1");
		expect(e.files_modified).toEqual(["a.ts"]);
		expect(e.hook_event).toBe("PostToolUse");
		// object error -> JSON.stringify, mirrored to message + detail
		expect(e.error_message).toBe('{"code":"E"}');
		expect(e.error_detail).toBe('{"code":"E"}');
		// object tool_input/response -> JSON.stringify
		expect(e.tool_input_json).toBe('{"x":1}');
		expect(e.tool_response_json).toBe('{"y":2}');
		expect(e.prompt).toBe("p");
		expect(e.last_assistant_message).toBe("lam");
		expect(e.cwd).toBe("/tmp");
		expect(e.model).toBe("claude");
		expect(e.source).toBe("cli");
		expect(e.agent_type_hook).toBe("main");
		expect(e.tool_use_id).toBe("tu1");
		expect(e.is_interrupt).toBe(false); // included because !== undefined
		expect(e.notification_type).toBe("nt");
		expect(e.notification_title).toBe("ntt");
		expect(e.task_subject).toBe("ts");
		expect(e.task_id_hook).toBe("tid");
		expect(e.task_description_hook).toBe("td");
		expect(e.trigger).toBe("trg");
		expect(e.reason).toBe("rsn");
		expect(e.permission_mode).toBe("pm");
		expect(e.transcript_path).toBe("/t");
		expect(e.teammate_name).toBe("tm");
		expect(e.team_name).toBe("team");
		expect(e.custom_instructions).toBe("ci");
		expect(e.stop_hook_active).toBe(true);
		expect(e.permission_suggestions).toBe('["s"]');
		expect(e.agent_transcript_path).toBe("/at");
	});

	it("string error / tool_input / tool_response pass through without JSON.stringify; session maps", async () => {
		mockGetUnsyncedEvents.mockReturnValue({
			events: [
				ev({
					error: "plain error",
					tool_input: "raw-input",
					tool_response: "raw-response",
					permission_suggestions: "already-string",
					session: "sess-9",
				}),
			],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.error_message).toBe("plain error");
		expect(e.error_detail).toBe("plain error");
		expect(e.tool_input_json).toBe("raw-input");
		expect(e.tool_response_json).toBe("raw-response");
		expect(e.permission_suggestions).toBe("already-string");
		expect(e.session_id).toBe("sess-9");
	});

	it("config defaults fall back to 'main' when keys are absent", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			workspace_id: "ws-123",
			sync_mode: "realtime",
		});
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ workspace_key: null, project_key: null })],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.workspace_key).toBe("main");
		expect(e.project_key).toBe("main");
	});
});

// =======================================================================
// Scrubbing accounting
// =======================================================================

describe("syncCommand — egress scrubbing", () => {
	it("counts scrubbed secrets, records types, and surfaces the Scrubbed row", async () => {
		mockScrubResult = { found: 3, types: ["aws_key", "email"] };
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev(), ev({ session: "s2" })],
			newOffset: 1,
		});
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		await syncCommand({});
		// scrub called once per event (2), each reporting found:3 -> total 6
		expect(mockScrubEgressPayload).toHaveBeenCalledTimes(2);
		expect(mockRecordScrub).toHaveBeenCalledWith(["aws_key", "email"]);
		expect(stdout()).toContain("Scrubbed");
		expect(stdout()).toContain("6 events had secrets redacted");
	});

	it("no Scrubbed row when nothing was redacted (found === 0)", async () => {
		mockScrubResult = { found: 0, types: [] };
		await syncCommand({});
		expect(mockRecordScrub).not.toHaveBeenCalled();
		expect(stdout()).not.toContain("Scrubbed");
	});
});

// =======================================================================
// HTTP error branches
// =======================================================================

describe("syncCommand — 401 auth failure", () => {
	it("logs a sync error, prints re-auth guidance, and aborts (normal)", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(failRes(401, "nope"));
		await syncCommand({});
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_auth", status: 401, transient: false }),
		);
		expect(stderrConsole()).toContain("Authentication failed");
		expect(stderrConsole()).toContain("interlinked login");
		expect(process.exitCode).toBe(1);
		// 401 returns before cursor advance
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("401 in JSON mode emits a structured error envelope", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(failRes(401));
		await syncCommand({ json: true });
		const j = JSON.parse(stderrConsole()) as { error: string };
		expect(j.error).toContain("Authentication failed");
	});
});

describe("syncCommand — fatal (non-transient) HTTP error", () => {
	it("400 is logged once, counts batch.length as errors, no cursor advance (json)", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(failRes(400, "bad payload"));
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev(), ev({ session: "s2" })],
			newOffset: 1,
		});
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 77, last_sync_at: "x" });
		await syncCommand({ json: true });
		// transient=false -> single appendSyncError at manual_sync_http
		expect(mockAppendSyncError).toHaveBeenCalledTimes(1);
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_http", status: 400, transient: false }),
		);
		const j = jsonOut();
		expect(j.errors).toBe(2); // batch.length
		expect(j.batches_sent).toBe(0);
		// cursor NOT advanced; new_offset falls back to readSyncState().synced_through_bytes
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
		expect(j.new_offset).toBe(77);
	});

	it("400 in normal mode writes the dim per-batch failure line to process.stderr", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(failRes(400, "bad payload"));
		await syncCommand({});
		expect(processStderr()).toContain("Batch 1 failed (400)");
		expect(processStderr()).toContain("bad payload");
		// errors>0 -> the "Cursor not advanced" advisory shows
		expect(stdout()).toContain("Cursor not advanced due to errors");
		expect(stdout()).toContain("Errors");
	});

	it("falls back to an empty error body when res.text() rejects (.catch arm)", async () => {
		// 400 (non-transient) whose body read throws -> errBody === "" via .catch.
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(failResTextThrows(400));
		await syncCommand({});
		// The failure line still prints, just with an empty body suffix.
		expect(processStderr()).toContain("Batch 1 failed (400):");
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_http", status: 400 }),
		);
	});
});

describe("syncCommand — transient HTTP error then retry", () => {
	it("503 retries with backoff then succeeds; retries counted", async () => {
		vi.useFakeTimers();
		const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchFn
			.mockResolvedValueOnce(failRes(503, "unavailable"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		// transient logged on the failed attempt
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_http", status: 503, transient: true }),
		);
		const j = jsonOut();
		expect(j.accepted).toBe(1);
		expect(j.batches_sent).toBe(1);
		// one transient retry (retriesUsed++ on continue) + attempt>1 success bump
		expect(j.retries as number).toBeGreaterThanOrEqual(1);
		expect(j.errors).toBe(0);
		expect(mockUpdateSyncState).toHaveBeenCalled();
	});

	it("429 exhausts all retries then counts the batch as failed", async () => {
		vi.useFakeTimers();
		(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(failRes(429, "slow down"));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		// 3 attempts each append an error (transient true)
		expect(mockAppendSyncError).toHaveBeenCalledTimes(3);
		const j = jsonOut();
		expect(j.errors).toBe(1); // batch.length === 1
		expect(j.batches_sent).toBe(0);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});
});

describe("syncCommand — network throw / timeout", () => {
	it("retries on a network error then exhausts and counts the batch failed", async () => {
		vi.useFakeTimers();
		(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNRESET"));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_network",
				message: "ECONNRESET",
				transient: true,
			}),
		);
		expect(mockAppendSyncError).toHaveBeenCalledTimes(3);
		const j = jsonOut();
		expect(j.errors).toBe(1);
		expect(j.batches_sent).toBe(0);
	});

	it("AbortError (timeout) logs manual_sync_timeout and writes the timeout stderr line", async () => {
		vi.useFakeTimers();
		const abortErr = new Error("aborted");
		abortErr.name = "AbortError";
		(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(abortErr);
		const p = syncCommand({});
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_timeout", transient: true }),
		);
		expect(processStderr()).toContain("Batch timed out (10s)");
	});

	it("non-Error thrown value is stringified into the sync-error message", async () => {
		vi.useFakeTimers();
		(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue("string-failure");
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_network", message: "string-failure" }),
		);
	});
});

// =======================================================================
// Top-level catch
// =======================================================================

describe("syncCommand — top-level error handling", () => {
	it("an Error thrown by getLocalStats is surfaced via outputError (normal)", async () => {
		mockGetLocalStats.mockImplementation(() => {
			throw new Error("disk gone");
		});
		await syncCommand({});
		expect(stderrConsole()).toContain("Error: disk gone");
		expect(process.exitCode).toBe(1);
	});

	it("a non-Error throw is stringified by the catch (json)", async () => {
		mockGetUnsyncedEvents.mockImplementation(() => {
			throw "boom-string";
		});
		await syncCommand({ json: true });
		const j = JSON.parse(stderrConsole()) as { error: string };
		expect(j.error).toBe("boom-string");
		expect(process.exitCode).toBe(1);
	});
});
