// ===========================================
// interlinked skill — behavioral tests
// ===========================================
// Covers skillEnter / skillLeave / skillList command handlers plus the private
// socket-send path (via createConnection mock) and the ttl/format helpers
// exercised through the public surface. Module boundaries (node:fs, node:net,
// ./harness.js) are mocked; console.log/console.error are spied; process.exitCode
// is asserted. Deterministic: no Date.now/Math.random in fixtures, fake timers
// drive the socket-timeout branch.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- module-boundary mocks --------------------------------------------------

const existsSyncMock = vi.fn<(p: string) => boolean>();
vi.mock("node:fs", () => ({
	existsSync: (p: string) => existsSyncMock(p),
}));

const createConnectionMock = vi.fn();
vi.mock("node:net", () => ({
	createConnection: (...args: unknown[]) => createConnectionMock(...args),
}));

vi.mock("./harness.js", () => ({
	getSocketPath: () => "/tmp/fake-harness.sock",
}));

import {
	skillEnterCommand,
	skillLeaveCommand,
	skillListCommand,
} from "./skill.js";

// ---- fake socket helper -----------------------------------------------------

// A controllable stand-in for the net.Socket returned by createConnection.
// Tests push it through connect/data/error to drive each branch of
// sendSkillEvent deterministically. `written` records the payload framing.
class FakeSocket extends EventEmitter {
	written: string[] = [];
	destroyed = false;
	write(chunk: string): boolean {
		this.written.push(chunk);
		return true;
	}
	destroy(): void {
		this.destroyed = true;
	}
}

const stripAnsi = (s: string): string =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for stable assertions
	s.replace(/\x1b\[[0-9;]*m/g, "");

// Collected console output (ANSI-stripped) for assertions.
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logs = [];
	errs = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(stripAnsi(a.map(String).join(" ")));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errs.push(stripAnsi(a.map(String).join(" ")));
	});
	existsSyncMock.mockReset();
	createConnectionMock.mockReset();
	// Default: socket exists. Individual tests override.
	existsSyncMock.mockReturnValue(true);
	process.exitCode = 0;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = 0;
	vi.useRealTimers();
});

// Wire createConnection to return a FakeSocket and, after the handlers attach
// their listeners (next microtask via queueMicrotask), drive it to emit a
// successful reply line carrying `reply`.
function wireSuccessfulReply(reply: unknown): FakeSocket {
	const sock = new FakeSocket();
	createConnectionMock.mockImplementation(() => {
		queueMicrotask(() => {
			sock.emit("connect");
			sock.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`));
		});
		return sock;
	});
	return sock;
}

// =============================================================================
// skillEnterCommand
// =============================================================================

describe("skillEnterCommand", () => {
	it("errors and sets exitCode=1 when name is empty/whitespace", async () => {
		await skillEnterCommand("   ", {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
		// Never attempts a socket connection on bad input.
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	it("errors and sets exitCode=1 when name is undefined (optional-chain branch)", async () => {
		// name?.trim() with undefined exercises the ?. branch.
		await skillEnterCommand(undefined as unknown as string, {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
	});

	it("errors on invalid --ttl", async () => {
		await skillEnterCommand("deep-research", { ttl: "abc" });
		expect(errs.join("\n")).toContain("invalid --ttl 'abc'");
		expect(process.exitCode).toBe(1);
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	it("errors when harness unreachable (no reply)", async () => {
		existsSyncMock.mockReturnValue(false); // socket missing → sendSkillEvent resolves null
		await skillEnterCommand("deep-research", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(process.exitCode).toBe(1);
	});

	it("enters with a ttl and prints normal output including ttl suffix", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("deep-research", { ttl: "30m" });
		expect(process.exitCode).toBe(0);
		const out = logs.join("\n");
		expect(out).toContain("skill entered: deep-research");
		expect(out).toContain("ttl 30m");
		// Payload framing: trailing newline + SkillEnter event with ttl_seconds.
		expect(sock.written).toHaveLength(1);
		const payload = JSON.parse(sock.written[0].trimEnd());
		expect(payload.hook_event).toBe("SkillEnter");
		expect(payload.agent_source).toBe("cli");
		expect(payload.tool_input).toMatchObject({ name: "deep-research", ttl_seconds: 1800 });
	});

	it("enters without a ttl (no ttl suffix; ttl_seconds null in json)", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("verify", { json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ skill: "verify", status: "entered", ttl_seconds: null });
	});

	it("normal output omits ttl suffix when no ttl given", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("verify", {});
		const out = logs.join("\n");
		expect(out).toContain("skill entered: verify");
		expect(out).not.toContain("ttl ");
	});

	it("passes through --source and --session into the payload", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("review", { source: "manual", session: "sess-123" });
		const payload = JSON.parse(sock.written[0].trimEnd());
		expect(payload.session_id).toBe("sess-123");
		expect(payload.tool_input).toMatchObject({ name: "review", source: "manual" });
		// No ttl → no ttl_seconds key.
		expect(payload.tool_input.ttl_seconds).toBeUndefined();
	});

	it("defaults session_id to empty string when --session omitted", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("review", {});
		const payload = JSON.parse(sock.written[0].trimEnd());
		expect(payload.session_id).toBe("");
	});

	it("json output reports ttl_seconds when a ttl is present", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("review", { ttl: "2h", json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ skill: "review", status: "entered", ttl_seconds: 7200 });
	});
});

// =============================================================================
// skillLeaveCommand
// =============================================================================

describe("skillLeaveCommand", () => {
	it("errors and sets exitCode=1 when name is empty", async () => {
		await skillLeaveCommand("  ", {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	it("errors when harness unreachable", async () => {
		existsSyncMock.mockReturnValue(false);
		await skillLeaveCommand("deep-research", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(process.exitCode).toBe(1);
	});

	it("leaves and prints normal output", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillLeaveCommand("deep-research", { session: "s1" });
		expect(process.exitCode).toBe(0);
		expect(logs.join("\n")).toContain("skill left: deep-research");
		const payload = JSON.parse(sock.written[0].trimEnd());
		expect(payload.hook_event).toBe("SkillLeave");
		expect(payload.session_id).toBe("s1");
		expect(payload.tool_input).toEqual({ name: "deep-research" });
	});

	it("leaves with json output", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillLeaveCommand("deep-research", { json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ skill: "deep-research", status: "left" });
	});
});

// =============================================================================
// skillListCommand
// =============================================================================

describe("skillListCommand", () => {
	it("errors when harness unreachable", async () => {
		existsSyncMock.mockReturnValue(false);
		await skillListCommand({});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(process.exitCode).toBe(1);
	});

	it("errors on malformed skill list JSON", async () => {
		wireSuccessfulReply({ additional_context: "{not json" });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	it("prints 'No active sessions.' when list is empty array", async () => {
		wireSuccessfulReply({ additional_context: "[]" });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active sessions.");
		expect(process.exitCode).toBe(0);
	});

	it("treats missing additional_context (non-string) as empty list", async () => {
		// raw is undefined → the `typeof raw === "string"` guard is false.
		wireSuccessfulReply({ decision: "allow" });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active sessions.");
	});

	it("treats empty-string additional_context as empty list", async () => {
		// raw === "" → length > 0 guard is false, parsed stays [].
		wireSuccessfulReply({ additional_context: "" });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active sessions.");
	});

	it("prints 'No active skills across all sessions.' when sessions have no skills", async () => {
		const sessions = [{ session_id: "abcdef0123", agent_name: "agentA", skills: [] }];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active skills across all sessions.");
	});

	it("renders a table for sessions with active skills (normal mode)", async () => {
		const sessions = [
			{
				session_id: "abcdef0123456789",
				agent_name: "agentA",
				skills: [
					{
						name: "deep-research",
						entered_at: 0, // epoch → ISO 00:00:00
						expires_at: 60_000, // 60s from epoch
						source: "cli",
					},
				],
			},
			// A second session with no skills exercises the `continue` branch.
			{ session_id: "zzzz", agent_name: "agentB", skills: [] },
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		const out = logs.join("\n");
		expect(out).toContain("Active skills");
		expect(out).toContain("agentA");
		expect(out).toContain("(abcdef01)"); // session id sliced to 8 chars
		expect(out).toContain("deep-research");
		expect(out).toContain("cli");
		expect(out).toContain("00:00:00"); // entered (utc) from entered_at=0
		expect(out).toContain("total");
		// agentB has no skills → must not appear as a section header row.
		expect(out).not.toContain("agentB");
	});

	it("returns parsed list verbatim in json mode", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: "x", entered_at: 0, expires_at: 1000, source: "hook" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({ json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual(sessions);
	});

	it("sends a SkillList event with the given session id", async () => {
		const sock = wireSuccessfulReply({ additional_context: "[]" });
		await skillListCommand({ session: "sx" });
		const payload = JSON.parse(sock.written[0].trimEnd());
		expect(payload.hook_event).toBe("SkillList");
		expect(payload.session_id).toBe("sx");
		expect(payload.tool_input).toEqual({});
	});
});

// =============================================================================
// parseTtl — exercised via skillEnter (valid units) + invalid paths
// =============================================================================

describe("parseTtl (via skillEnterCommand)", () => {
	const cases: Array<[string, number]> = [
		["90s", 90],
		["90sec", 90],
		["45", 45], // bare number → seconds default
		["5m", 300],
		["5min", 300],
		["1h", 3600],
		["2hr", 7200],
	];
	for (const [input, seconds] of cases) {
		it(`parses '${input}' → ${seconds}s`, async () => {
			wireSuccessfulReply({ decision: "allow" });
			await skillEnterCommand("x", { ttl: input, json: true });
			const parsed = JSON.parse(logs.join("\n"));
			expect(parsed.ttl_seconds).toBe(seconds);
		});
	}

	// Truthy-but-unparseable / non-positive inputs all hit the `=== null` guard.
	// (An empty "" is falsy → the `opts.ttl ?` guard skips parseTtl entirely,
	// so it is not a rejection case and is excluded here.)
	const invalid = ["abc", "0", "-5", "0s", "10x"];
	for (const input of invalid) {
		it(`rejects invalid/non-positive ttl '${input}'`, async () => {
			await skillEnterCommand("x", { ttl: input });
			expect(errs.join("\n")).toContain(`invalid --ttl '${input}'`);
			expect(process.exitCode).toBe(1);
			expect(createConnectionMock).not.toHaveBeenCalled();
		});
	}
});

// =============================================================================
// formatTtl — exercised via skillList expires-in column rendering
// =============================================================================

describe("formatTtl (via skillListCommand rendering)", () => {
	function sessionWithExpiry(expires_at: number): unknown[] {
		return [
			{
				session_id: "sess0001",
				agent_name: "a",
				skills: [{ name: "sk", entered_at: 0, expires_at, source: "cli" }],
			},
		];
	}

	it("formats sub-minute as seconds", async () => {
		// Date.now() ~ large; expires_at small → max(0, ...) clamps to 0s.
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(0)) });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("0s");
	});

	it("formats minutes band", async () => {
		const expires = Date.now() + 300_000; // +5m
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(expires)) });
		await skillListCommand({});
		expect(logs.join("\n")).toMatch(/\b5m\b/);
	});

	it("formats hours band", async () => {
		const expires = Date.now() + 7_200_000; // +2h
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(expires)) });
		await skillListCommand({});
		expect(logs.join("\n")).toMatch(/\b2h\b/);
	});
});

// =============================================================================
// sendSkillEvent — socket branch coverage (via the public commands)
// =============================================================================

describe("sendSkillEvent socket paths", () => {
	it("resolves null when socket file does not exist", async () => {
		existsSyncMock.mockReturnValue(false);
		await skillEnterCommand("x", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	it("resolves null on socket 'error' event", async () => {
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => sock.emit("error", new Error("ECONNREFUSED")));
			return sock;
		});
		await skillEnterCommand("x", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
	});

	it("resolves null when the reply line is not valid JSON", async () => {
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => {
				sock.emit("connect");
				sock.emit("data", Buffer.from("not-json\n"));
			});
			return sock;
		});
		await skillEnterCommand("x", {});
		// Bad reply parse → resolve(null) → "could not reach" path.
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(sock.destroyed).toBe(true);
	});

	it("buffers across chunks and parses once a newline arrives", async () => {
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => {
				sock.emit("connect");
				// Split the JSON across two data events; no newline until the 2nd.
				sock.emit("data", Buffer.from('{"decision":'));
				sock.emit("data", Buffer.from('"allow"}\n'));
			});
			return sock;
		});
		await skillEnterCommand("x", {});
		expect(logs.join("\n")).toContain("skill entered: x");
		expect(sock.destroyed).toBe(true);
	});

	it("times out and resolves null when no data arrives", async () => {
		vi.useFakeTimers();
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			// connect, but never emit data → setTimeout fires.
			queueMicrotask(() => sock.emit("connect"));
			return sock;
		});
		const p = skillEnterCommand("x", {});
		// Let the microtask attach listeners + emit connect, then advance the
		// 2000ms socket timeout so the timeout callback runs.
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(2001);
		await p;
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(sock.destroyed).toBe(true);
		// connect handler still wrote the payload before timing out.
		expect(sock.written).toHaveLength(1);
	});

	it("timeout swallows a destroy() throw (defensive catch)", async () => {
		vi.useFakeTimers();
		const sock = new FakeSocket();
		sock.destroy = () => {
			throw new Error("already gone");
		};
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => sock.emit("connect"));
			return sock;
		});
		const p = skillEnterCommand("x", {});
		await Promise.resolve();
		// Must not reject despite destroy() throwing inside the timeout handler.
		await vi.advanceTimersByTimeAsync(2001);
		await expect(p).resolves.toBeUndefined();
		expect(errs.join("\n")).toContain("Could not reach harness");
	});
});
