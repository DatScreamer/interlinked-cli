// ===========================================
// interlinked tasks — behavioral coverage
// ===========================================
// Replaces the prior import-only tombstone. Mocks the single I/O boundary
// (../lib/api-client.js → getClient) and runs the REAL output.js / formatter.js
// so assertions land on the actual rendered strings, JSON payloads, and
// side-effects (process.exitCode). The fake client is reconfigured per-test to
// flip each branch.
//
// Branch map covered (across all five commands + shared helpers):
//   - isUnauthenticatedRemote: unauth + non-local (early return) vs
//     authenticated vs unauth-but-local-dev (proceeds).
//   - parsePositiveInt: valid; NaN ("abc"); "0" (<= 0 guard); negative.
//   - requireAgentName: configured; absent (throw); whitespace-only (throw).
//   - unwrapTask: { task } unwrap; { task: undefined } → {}; raw Task object;
//     null/undefined result → {}.
//   - list: arg mapping (status/assignee/priority/limit, each present/absent);
//     result.tasks vs null → []; json / short(empty+plural) / normal(empty dim
//     + populated table with id||"", status||pending, assignee||unassigned,
//     priority||normal, updated_at||created_at) / full(description present vs
//     absent, assignee/priority fallbacks).
//   - create: title pass-through, optional description/assignee/priority,
//     creator_name from agent; json(raw shape) / normal(task.title vs title
//     fallback, task.id vs "?" fallback); agent-missing throw.
//   - show: id parse; unwrap; json / normal(id||arg, title/status/priority/
//     assignee fallbacks, description present vs absent); bad id.
//   - claim / complete: id parse + agent; correct tool + args; json / normal;
//     agent-missing + bad-id throws.
//   - catch: Error message vs non-Error (string reject), in normal + json.
//
// NO_COLOR + an ANSI strip helper keep the matchers hermetic (TTY vs piped).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../lib/json-types.js";

// ---- single I/O boundary mock --------------------------------------------
const mockGetClient = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: () => mockGetClient(),
}));

process.env.NO_COLOR = "1";

import {
	tasksClaimCommand,
	tasksCompleteCommand,
	tasksCreateCommand,
	tasksListCommand,
	tasksShowCommand,
} from "./tasks.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

// ---- fake client builder --------------------------------------------------
interface FakeClientOpts {
	authenticated?: boolean;
	localDev?: boolean;
	agentName?: string | undefined;
	callTool?: (name: string, args: JsonObject) => unknown;
}

let lastCall: { name: string; args: JsonObject } | undefined;

function installClient(opts: FakeClientOpts): void {
	lastCall = undefined;
	const callTool = opts.callTool ?? ((_name: string, _args: JsonObject) => ({ tasks: [] }));
	const config: { agent_name?: string } = {};
	if (opts.agentName !== undefined) config.agent_name = opts.agentName;
	mockGetClient.mockReturnValue({
		isAuthenticated: () => opts.authenticated ?? true,
		isLocalDevServer: () => opts.localDev ?? false,
		getConfig: () => config,
		callTool: async (name: string, args: JsonObject) => {
			lastCall = { name, args };
			return callTool(name, args);
		},
	});
}

// ---- console / exit capture ----------------------------------------------
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const join = (calls: unknown[][]): string =>
	calls
		.map((call) => call.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
		.join("\n");
const out = (): string => strip(join(logSpy.mock.calls));
const err = (): string => strip(join(errSpy.mock.calls));
// Unstripped first console.log payload — json mode never colorizes, so
// JSON.parse sees raw text.
const rawOut = (): string => String(logSpy.mock.calls[0]?.[0] ?? "");

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	mockGetClient.mockReset();
	vi.useRealTimers();
});

// ===========================================
// Shared auth gate — exercised once per command (isUnauthenticatedRemote)
// ===========================================
describe("tasks: auth gate (isUnauthenticatedRemote)", () => {
	it("list: returns early with an error when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false });
		await tasksListCommand({});
		expect(err()).toBe("Error: Not authenticated. Run: interlinked login");
		expect(out()).toBe("");
		expect(process.exitCode).toBe(1);
		expect(lastCall).toBeUndefined();
	});

	it("list: structured JSON error when unauthenticated in --json mode", async () => {
		installClient({ authenticated: false, localDev: false });
		await tasksListCommand({ json: true });
		expect(JSON.parse(err())).toEqual({
			error: "Not authenticated. Run: interlinked login",
			details: undefined,
		});
		expect(process.exitCode).toBe(1);
	});

	it("list: proceeds when unauthenticated but pointed at a local dev server", async () => {
		installClient({ authenticated: false, localDev: true, callTool: () => ({ tasks: [] }) });
		await tasksListCommand({});
		expect(lastCall?.name).toBe("list_tasks");
		expect(out()).toContain("Tasks");
	});

	it("create: gated when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false, agentName: "a" });
		await tasksCreateCommand("T", {});
		expect(err()).toContain("Not authenticated");
		expect(lastCall).toBeUndefined();
	});

	it("show: gated when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false });
		await tasksShowCommand("1", {});
		expect(err()).toContain("Not authenticated");
		expect(lastCall).toBeUndefined();
	});

	it("claim: gated when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false, agentName: "a" });
		await tasksClaimCommand("1", {});
		expect(err()).toContain("Not authenticated");
		expect(lastCall).toBeUndefined();
	});

	it("complete: gated when unauthenticated and not local-dev", async () => {
		installClient({ authenticated: false, localDev: false, agentName: "a" });
		await tasksCompleteCommand("1", {});
		expect(err()).toContain("Not authenticated");
		expect(lastCall).toBeUndefined();
	});
});

// ===========================================
// tasksListCommand — request args (status/assignee/priority/limit)
// ===========================================
describe("tasks list: request args", () => {
	it("sends an empty args object with no filters", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({ json: true });
		expect(lastCall?.name).toBe("list_tasks");
		expect(lastCall?.args).toEqual({});
	});

	it("maps status, assignee, priority, and a parsed limit", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({
			status: "pending",
			assignee: "worker-1",
			priority: "high",
			limit: "5",
			json: true,
		});
		expect(lastCall?.args).toEqual({
			status: "pending",
			assignee_name: "worker-1",
			priority: "high",
			limit: 5,
		});
	});

	it("rejects a non-numeric --limit (NaN guard) via the catch path", async () => {
		installClient({});
		await tasksListCommand({ limit: "abc" });
		expect(err()).toBe("Error: Server error: Invalid --limit value: abc");
		expect(process.exitCode).toBe(1);
		expect(lastCall).toBeUndefined();
	});

	it("rejects a zero --limit (<= 0 guard)", async () => {
		installClient({});
		await tasksListCommand({ limit: "0" });
		expect(err()).toContain("Server error: Invalid --limit value: 0");
		expect(lastCall).toBeUndefined();
	});

	it("rejects a negative --limit", async () => {
		installClient({});
		await tasksListCommand({ limit: "-3" });
		expect(err()).toContain("Server error: Invalid --limit value: -3");
		expect(lastCall).toBeUndefined();
	});
});

// ===========================================
// tasksListCommand — result shape + output modes
// ===========================================
describe("tasks list: result shape precedence", () => {
	it("falls back to [] when the tool returns null", async () => {
		installClient({ callTool: () => null });
		await tasksListCommand({ short: true });
		expect(out()).toBe("No tasks");
	});

	it("uses result.tasks when present", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 1 }] }) });
		await tasksListCommand({ short: true });
		expect(out()).toBe("1 task(s)");
	});
});

describe("tasks list: json output", () => {
	it("wraps the tasks array under a tasks key", async () => {
		const tasks = [{ id: 1, title: "a" }];
		installClient({ callTool: () => ({ tasks }) });
		await tasksListCommand({ json: true });
		expect(JSON.parse(rawOut())).toEqual({ tasks });
	});

	it("emits an empty tasks array in json mode when empty", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({ json: true });
		expect(JSON.parse(rawOut())).toEqual({ tasks: [] });
	});
});

describe("tasks list: short output", () => {
	it("says 'No tasks' when empty", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({ short: true });
		expect(out()).toBe("No tasks");
	});

	it("pluralizes the count when populated", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 1 }, { id: 2 }] }) });
		await tasksListCommand({ short: true });
		expect(out()).toBe("2 task(s)");
	});
});

describe("tasks list: normal (table) output", () => {
	it("renders the header + dim 'No tasks found' line when empty", async () => {
		installClient({ callTool: () => ({ tasks: [] }) });
		await tasksListCommand({});
		const text = out();
		expect(text).toContain("Tasks");
		expect(text).toContain("No tasks found");
	});

	it("renders a fully-populated row verbatim", async () => {
		installClient({
			callTool: () => ({
				tasks: [
					{
						id: 7,
						status: "completed",
						title: "Ship it",
						assignee_name: "alice",
						priority: "high",
						updated_at: new Date().toISOString(),
					},
				],
			}),
		});
		await tasksListCommand({});
		const text = out();
		expect(text).toContain("ID");
		expect(text).toContain("Status");
		expect(text).toContain("Assignee");
		expect(text).toContain("7");
		expect(text).toContain("[completed]");
		expect(text).toContain("Ship it");
		expect(text).toContain("alice");
		expect(text).toContain("high");
	});

	it("applies every fallback: missing id/status/assignee/priority + created_at date", async () => {
		installClient({
			callTool: () => ({ tasks: [{ title: "Anon", created_at: new Date().toISOString() }] }),
		});
		await tasksListCommand({});
		const text = out();
		expect(text).toContain("Anon");
		expect(text).toContain("[pending]"); // status || "pending"
		expect(text).toContain("unassigned"); // assignee_name || dim("unassigned")
		expect(text).toContain("normal"); // priority || dim("normal")
		// id || "" → empty cell, not the literal "undefined"
		expect(text).not.toContain("undefined");
	});

	it("uses updated_at when both updated_at and created_at are present", async () => {
		const now = new Date().toISOString();
		installClient({
			callTool: () => ({ tasks: [{ id: 1, title: "x", updated_at: now, created_at: now }] }),
		});
		await tasksListCommand({});
		expect(out()).toContain("s ago"); // relativeTime of a fresh timestamp
	});

	it("shows 'never' when both timestamps are absent (relativeTime fallback)", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 1, title: "x" }] }) });
		await tasksListCommand({});
		expect(out()).toContain("never");
	});

	it("renders a row with an empty title cell when title is missing (title || '')", async () => {
		// Exercises the right side of `truncate(t.title || "", 40)` in the table.
		installClient({ callTool: () => ({ tasks: [{ id: 21 }] }) });
		await tasksListCommand({});
		const text = out();
		expect(text).toContain("21");
		expect(text).not.toContain("undefined");
	});
});

describe("tasks list: full output", () => {
	it("renders description, assignee, priority, and timestamps when present", async () => {
		const now = new Date().toISOString();
		installClient({
			callTool: () => ({
				tasks: [
					{
						id: 3,
						status: "in_progress",
						title: "Build",
						description: "wire it up",
						assignee_name: "bob",
						priority: "low",
						created_at: now,
						updated_at: now,
					},
				],
			}),
		});
		await tasksListCommand({ full: true });
		const text = out();
		expect(text).toContain("Tasks (Full)");
		expect(text).toContain("#3");
		expect(text).toContain("[in_progress]");
		expect(text).toContain("Build");
		expect(text).toContain("wire it up");
		expect(text).toContain("Assignee: bob | Priority: low");
		expect(text).toContain("Created:");
		expect(text).toContain("Updated:");
	});

	it("omits the description line and uses unassigned/normal/pending fallbacks", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 4, title: "Bare" }] }) });
		await tasksListCommand({ full: true });
		const text = out();
		expect(text).toContain("#4");
		expect(text).toContain("[pending]"); // status || "pending"
		expect(text).toContain("Assignee: unassigned | Priority: normal");
		expect(text).not.toContain("undefined");
	});

	it("renders an empty title gracefully (title || '')", async () => {
		installClient({ callTool: () => ({ tasks: [{ id: 5 }] }) });
		await tasksListCommand({ full: true });
		expect(out()).toContain("#5");
	});
});

describe("tasks list: server error handling", () => {
	it("reports an Error message in normal mode", async () => {
		installClient({
			callTool: () => {
				throw new Error("connection refused");
			},
		});
		await tasksListCommand({});
		expect(err()).toBe("Error: Server error: connection refused");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error reject (String(err) branch)", async () => {
		installClient({
			callTool: () => {
				throw "boom-string";
			},
		});
		await tasksListCommand({});
		expect(err()).toContain("Server error: boom-string");
		expect(process.exitCode).toBe(1);
	});

	it("emits a structured JSON error in --json mode", async () => {
		installClient({
			callTool: () => {
				throw new Error("kaboom");
			},
		});
		await tasksListCommand({ json: true });
		const parsed = JSON.parse(err());
		expect(parsed.error).toBe("Server error: kaboom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// tasksCreateCommand
// ===========================================
describe("tasks create: request args + agent resolution", () => {
	it("sends title + creator_name with no optional fields", async () => {
		installClient({ agentName: "agent-default", callTool: () => ({ task: { id: 1 } }) });
		await tasksCreateCommand("Test task", { json: true });
		expect(lastCall?.name).toBe("create_task");
		expect(lastCall?.args).toEqual({ title: "Test task", creator_name: "agent-default" });
	});

	it("maps optional description / assignee / priority", async () => {
		installClient({ agentName: "a", callTool: () => ({ task: { id: 1 } }) });
		await tasksCreateCommand("T", {
			description: "do the thing",
			assignee: "carol",
			priority: "high",
			json: true,
		});
		expect(lastCall?.args).toEqual({
			title: "T",
			creator_name: "a",
			description: "do the thing",
			assignee_name: "carol",
			priority: "high",
		});
	});

	it("trims the configured agent_name before sending", async () => {
		installClient({ agentName: "  spaced  ", callTool: () => ({ task: { id: 1 } }) });
		await tasksCreateCommand("T", { json: true });
		expect(lastCall?.args.creator_name).toBe("spaced");
	});

	it("throws (caught as Server error) when agent_name is absent", async () => {
		installClient({ agentName: undefined });
		await tasksCreateCommand("T", {});
		expect(err()).toContain("Server error: agent_name is required for task creation.");
		expect(err()).toContain("interlinked enable --agent <name>");
		expect(lastCall).toBeUndefined();
		expect(process.exitCode).toBe(1);
	});

	it("treats a whitespace-only agent_name as missing", async () => {
		installClient({ agentName: "   " });
		await tasksCreateCommand("T", {});
		expect(err()).toContain("Server error: agent_name is required for task creation.");
		expect(lastCall).toBeUndefined();
	});
});

describe("tasks create: output", () => {
	it("preserves the raw response shape in json mode", async () => {
		installClient({
			agentName: "a",
			callTool: () => ({ task: { id: 9, title: "Made" }, created_by: "a" }),
		});
		await tasksCreateCommand("Made", { json: true });
		expect(JSON.parse(rawOut())).toEqual({ task: { id: 9, title: "Made" }, created_by: "a" });
	});

	it("normal mode uses the unwrapped task title + id", async () => {
		installClient({ agentName: "a", callTool: () => ({ task: { id: 9, title: "FromServer" } }) });
		await tasksCreateCommand("FromArg", {});
		expect(out()).toBe("Task created: FromServer (#9)");
	});

	it("falls back to the arg title and '?' id when the server returns a bare object", async () => {
		// rawResult is a Task without a `task` key → unwrapTask returns it as-is,
		// but it has no id/title, so title || title(arg) and id || "?" kick in.
		installClient({ agentName: "a", callTool: () => ({}) });
		await tasksCreateCommand("ArgTitle", {});
		expect(out()).toBe("Task created: ArgTitle (#?)");
	});

	it("unwraps { task: undefined } to {} and still renders fallbacks", async () => {
		installClient({ agentName: "a", callTool: () => ({ task: undefined }) });
		await tasksCreateCommand("ArgTitle2", {});
		expect(out()).toBe("Task created: ArgTitle2 (#?)");
	});

	it("handles a null result (unwrapTask undefined → {})", async () => {
		installClient({ agentName: "a", callTool: () => null });
		await tasksCreateCommand("NullCase", {});
		expect(out()).toBe("Task created: NullCase (#?)");
	});
});

describe("tasks create: server error handling", () => {
	it("reports an Error from callTool", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw new Error("create failed");
			},
		});
		await tasksCreateCommand("T", {});
		expect(err()).toBe("Error: Server error: create failed");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error reject (String(err) branch)", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw "create-string";
			},
		});
		await tasksCreateCommand("T", {});
		expect(err()).toContain("Server error: create-string");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// tasksShowCommand
// ===========================================
describe("tasks show: request + parsing", () => {
	it("parses the id and calls get_task", async () => {
		installClient({ callTool: () => ({ id: 42, title: "Test" }) });
		await tasksShowCommand("42", { json: true });
		expect(lastCall?.name).toBe("get_task");
		expect(lastCall?.args).toEqual({ task_id: 42 });
	});

	it("rejects a non-numeric id via the catch path", async () => {
		installClient({});
		await tasksShowCommand("nope", {});
		expect(err()).toContain("Server error: Invalid task id value: nope");
		expect(lastCall).toBeUndefined();
		expect(process.exitCode).toBe(1);
	});

	it("rejects a zero id", async () => {
		installClient({});
		await tasksShowCommand("0", {});
		expect(err()).toContain("Server error: Invalid task id value: 0");
		expect(lastCall).toBeUndefined();
	});
});

describe("tasks show: unwrap + output", () => {
	it("unwraps a { task } envelope in json mode", async () => {
		installClient({ callTool: () => ({ task: { id: 5, title: "Wrapped" } }) });
		await tasksShowCommand("5", { json: true });
		expect(JSON.parse(rawOut())).toEqual({ id: 5, title: "Wrapped" });
	});

	it("passes a bare Task object straight through in json mode", async () => {
		installClient({ callTool: () => ({ id: 6, title: "Bare" }) });
		await tasksShowCommand("6", { json: true });
		expect(JSON.parse(rawOut())).toEqual({ id: 6, title: "Bare" });
	});

	it("renders all fields + description in normal mode", async () => {
		installClient({
			callTool: () => ({
				id: 11,
				title: "Full task",
				status: "blocked",
				priority: "high",
				assignee_name: "dave",
				description: "the details",
			}),
		});
		await tasksShowCommand("11", {});
		const text = out();
		expect(text).toContain("Task #11");
		expect(text).toContain("Full task");
		expect(text).toContain("blocked");
		expect(text).toContain("high");
		expect(text).toContain("dave");
		expect(text).toContain("the details");
	});

	it("applies fallbacks (id||arg, title '', pending, normal, unassigned) and omits description", async () => {
		// Empty object after unwrap → result?.id falsy → header uses the arg id.
		installClient({ callTool: () => ({}) });
		await tasksShowCommand("99", {});
		const text = out();
		expect(text).toContain("Task #99"); // result?.id || id(arg)
		expect(text).toContain("pending"); // status || "pending"
		expect(text).toContain("normal"); // priority || "normal"
		expect(text).toContain("unassigned"); // assignee_name || "unassigned"
		// no description line
		expect(text).not.toContain("the details");
	});

	it("uses the server id over the arg id when present", async () => {
		installClient({ callTool: () => ({ id: 500, title: "x" }) });
		await tasksShowCommand("7", {});
		expect(out()).toContain("Task #500");
	});

	it("handles a null result (unwrap → {})", async () => {
		installClient({ callTool: () => null });
		await tasksShowCommand("3", {});
		expect(out()).toContain("Task #3");
	});

	it("reports an Error from callTool", async () => {
		installClient({
			callTool: () => {
				throw new Error("show failed");
			},
		});
		await tasksShowCommand("1", {});
		expect(err()).toContain("Server error: show failed");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error reject (String(err) branch)", async () => {
		installClient({
			callTool: () => {
				throw "show-string";
			},
		});
		await tasksShowCommand("1", {});
		expect(err()).toContain("Server error: show-string");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// tasksClaimCommand
// ===========================================
describe("tasks claim", () => {
	it("parses the id, resolves the agent, and calls claim_task", async () => {
		installClient({ agentName: "agent-default", callTool: () => ({ claimed: true }) });
		await tasksClaimCommand("5", { json: true });
		expect(lastCall?.name).toBe("claim_task");
		expect(lastCall?.args).toEqual({ task_id: 5, agent_name: "agent-default" });
	});

	it("renders the success line using the raw arg id in normal mode", async () => {
		installClient({ agentName: "a", callTool: () => ({ claimed: true }) });
		await tasksClaimCommand("8", {});
		expect(out()).toBe("Claimed task #8");
	});

	it("passes the raw result through in json mode", async () => {
		installClient({ agentName: "a", callTool: () => ({ claimed: true, by: "a" }) });
		await tasksClaimCommand("8", { json: true });
		expect(JSON.parse(rawOut())).toEqual({ claimed: true, by: "a" });
	});

	it("rejects a bad id before resolving the agent", async () => {
		installClient({ agentName: "a" });
		await tasksClaimCommand("bad", {});
		expect(err()).toContain("Server error: Invalid task id value: bad");
		expect(lastCall).toBeUndefined();
	});

	it("throws when agent_name is absent", async () => {
		installClient({ agentName: undefined });
		await tasksClaimCommand("1", {});
		expect(err()).toContain("Server error: agent_name is required for claiming tasks.");
		expect(lastCall).toBeUndefined();
	});

	it("reports an Error from callTool", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw new Error("claim failed");
			},
		});
		await tasksClaimCommand("1", {});
		expect(err()).toContain("Server error: claim failed");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error reject (String(err) branch)", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw "claim-string";
			},
		});
		await tasksClaimCommand("1", {});
		expect(err()).toContain("Server error: claim-string");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// tasksCompleteCommand
// ===========================================
describe("tasks complete", () => {
	it("parses the id, resolves the agent, and calls update_task_status", async () => {
		installClient({ agentName: "agent-default", callTool: () => ({ updated: true }) });
		await tasksCompleteCommand("5", { json: true });
		expect(lastCall?.name).toBe("update_task_status");
		expect(lastCall?.args).toEqual({
			task_id: 5,
			agent_name: "agent-default",
			status: "completed",
		});
	});

	it("renders the success line using the raw arg id in normal mode", async () => {
		installClient({ agentName: "a", callTool: () => ({ updated: true }) });
		await tasksCompleteCommand("12", {});
		expect(out()).toBe("Completed task #12");
	});

	it("passes the raw result through in json mode", async () => {
		installClient({ agentName: "a", callTool: () => ({ updated: true, status: "completed" }) });
		await tasksCompleteCommand("12", { json: true });
		expect(JSON.parse(rawOut())).toEqual({ updated: true, status: "completed" });
	});

	it("rejects a bad id before resolving the agent", async () => {
		installClient({ agentName: "a" });
		await tasksCompleteCommand("x", {});
		expect(err()).toContain("Server error: Invalid task id value: x");
		expect(lastCall).toBeUndefined();
	});

	it("throws when agent_name is absent", async () => {
		installClient({ agentName: undefined });
		await tasksCompleteCommand("1", {});
		expect(err()).toContain("Server error: agent_name is required for completing tasks.");
		expect(lastCall).toBeUndefined();
	});

	it("reports an Error from callTool", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw new Error("complete failed");
			},
		});
		await tasksCompleteCommand("1", {});
		expect(err()).toContain("Server error: complete failed");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error reject (String(err) branch)", async () => {
		installClient({
			agentName: "a",
			callTool: () => {
				throw "complete-string";
			},
		});
		await tasksCompleteCommand("1", {});
		expect(err()).toContain("Server error: complete-string");
		expect(process.exitCode).toBe(1);
	});
});
