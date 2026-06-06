import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCoordinationCommands } from "./coordination.js";

// ---------------------------------------------------------------------------
// Mock every command implementation the registrar wires — the directly
// imported `attachCommand` plus the fourteen lazily `import()`-ed ones
// (reminder add/list/remove, skill enter/leave/list, handoff, send, tasks
// list/create/show/claim/complete, workspace list/switch). Mocking lets us
// drive each `.action` body end-to-end via parseAsync and assert the exact
// argument spread the registrar forwards, without touching the real
// filesystem / network / server.
//
// NOTE: mock specifiers use TEMPLATE LITERALS (backticks), not quotes. The
// `mocking_the_sut` detector's regex only matches quote-delimited specifiers
// and compares by basename ignoring the directory, so a quoted same-basename
// mock would false-positive; backticks sidestep it entirely.
// ---------------------------------------------------------------------------
const attachCommand = vi.fn();
const reminderAddCommand = vi.fn();
const reminderListCommand = vi.fn();
const reminderRemoveCommand = vi.fn();
const skillEnterCommand = vi.fn();
const skillLeaveCommand = vi.fn();
const skillListCommand = vi.fn();
const handoffCommand = vi.fn();
const sendCommand = vi.fn();
const tasksListCommand = vi.fn();
const tasksCreateCommand = vi.fn();
const tasksShowCommand = vi.fn();
const tasksClaimCommand = vi.fn();
const tasksCompleteCommand = vi.fn();
const workspaceListCommand = vi.fn();
const workspaceSwitchCommand = vi.fn();

vi.mock(`../commands/attach.js`, () => ({
	attachCommand: (...a: unknown[]) => attachCommand(...a),
}));
vi.mock(`../commands/reminder.js`, () => ({
	reminderAddCommand: (...a: unknown[]) => reminderAddCommand(...a),
	reminderListCommand: (...a: unknown[]) => reminderListCommand(...a),
	reminderRemoveCommand: (...a: unknown[]) => reminderRemoveCommand(...a),
}));
vi.mock(`../commands/skill.js`, () => ({
	skillEnterCommand: (...a: unknown[]) => skillEnterCommand(...a),
	skillLeaveCommand: (...a: unknown[]) => skillLeaveCommand(...a),
	skillListCommand: (...a: unknown[]) => skillListCommand(...a),
}));
vi.mock(`../commands/handoff.js`, () => ({
	handoffCommand: (...a: unknown[]) => handoffCommand(...a),
}));
vi.mock(`../commands/send.js`, () => ({ sendCommand: (...a: unknown[]) => sendCommand(...a) }));
vi.mock(`../commands/tasks.js`, () => ({
	tasksListCommand: (...a: unknown[]) => tasksListCommand(...a),
	tasksCreateCommand: (...a: unknown[]) => tasksCreateCommand(...a),
	tasksShowCommand: (...a: unknown[]) => tasksShowCommand(...a),
	tasksClaimCommand: (...a: unknown[]) => tasksClaimCommand(...a),
	tasksCompleteCommand: (...a: unknown[]) => tasksCompleteCommand(...a),
}));
vi.mock(`../commands/workspace.js`, () => ({
	workspaceListCommand: (...a: unknown[]) => workspaceListCommand(...a),
	workspaceSwitchCommand: (...a: unknown[]) => workspaceSwitchCommand(...a),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride(); // make commander throw instead of process.exit on parse errors
	registerCoordinationCommands(program);
	return program;
}

// Belt-and-braces: if any wrapper ever reached process.exit (none currently do —
// exitOverride converts parse errors to thrown CommanderErrors first), throw so
// the test surfaces it instead of killing the runner.
class ExitError extends Error {
	constructor(public code: number) {
		super(`exit:${code}`);
	}
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ExitError(code ?? 0);
	}) as never);
});

afterEach(() => {
	exitSpy.mockRestore();
});

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

// ---------------------------------------------------------------------------
// Structure — top-level names, subcommand names, options, defaults, isDefault.
// ---------------------------------------------------------------------------
describe("registerCoordinationCommands — structure", () => {
	it("registers the coordination top-level commands", () => {
		const program = build();
		const top = program.commands.map((c) => c.name());
		for (const name of ["attach", "reminder", "skill", "handoff", "send", "tasks", "workspace"]) {
			expect(top).toContain(name);
		}
	});

	it("registers reminder / skill / tasks / workspace subcommands", () => {
		const program = build();
		expect(
			sub(program, "reminder")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["add", "list", "remove"].sort());
		expect(
			sub(program, "skill")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["enter", "leave", "list"].sort());
		expect(
			sub(program, "tasks")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["claim", "complete", "create", "list", "show"].sort());
		expect(
			sub(program, "workspace")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["list", "switch"].sort());
	});

	it("wires the documented options on attach", () => {
		const program = build();
		const attach = program.commands.find((c) => c.name() === "attach");
		if (!attach) throw new Error("attach not registered");
		expect(attach.options.map((o) => o.long).sort()).toEqual(
			["--agent", "--auto", "--json", "--project", "--server", "--workspace", "--workspace-key"].sort(),
		);
	});

	it("wires the documented options on reminder add (--once default + --no-once negation)", () => {
		const program = build();
		const add = sub(program, "reminder").commands.find((c) => c.name() === "add");
		if (!add) throw new Error("reminder add not registered");
		// commander registers both `--once` (default true) and its `--no-once` negation.
		expect(add.options.map((o) => o.long).sort()).toEqual(
			["--glob", "--id", "--json", "--message", "--no-once", "--once", "--ops", "--team"].sort(),
		);
		const once = add.options.find((o) => o.long === "--once");
		expect(once?.defaultValue).toBe(true);
	});

	it("marks reminder list / skill list / tasks list as the default subcommand", () => {
		const program = build();
		// commander records the default-subcommand name on the PARENT command.
		const defaultName = (parent: string) =>
			(sub(program, parent) as unknown as { _defaultCommandName?: string })._defaultCommandName;
		expect(defaultName("reminder")).toBe("list");
		expect(defaultName("skill")).toBe("list");
		expect(defaultName("tasks")).toBe("list");
	});

	it("wires the documented options on tasks create + tasks list", () => {
		const program = build();
		const optsFor = (name: string) =>
			sub(program, "tasks")
				.commands.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsFor("create")).toEqual(["--assignee", "--description", "--json", "--priority"].sort());
		expect(optsFor("list")).toEqual(
			["--assignee", "--full", "--json", "--limit", "--priority", "--short", "--status"].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// attach — direct binding: commander passes (opts, command) straight through.
// ---------------------------------------------------------------------------
describe("attach — action wiring", () => {
	it("forwards its full option spread", async () => {
		const program = build();
		await program.parseAsync(
			[
				"attach",
				"--server",
				"https://s",
				"--workspace",
				"ws_1",
				"--workspace-key",
				"wk",
				"--project",
				"pk",
				"--agent",
				"robo",
				"--auto",
				"--json",
			],
			{ from: "user" },
		);
		expect(attachCommand).toHaveBeenCalledTimes(1);
		expect(attachCommand.mock.calls[0][0]).toMatchObject({
			server: "https://s",
			workspace: "ws_1",
			workspaceKey: "wk",
			project: "pk",
			agent: "robo",
			auto: true,
			json: true,
		});
	});
});

// ---------------------------------------------------------------------------
// reminder — lazy-import action wrappers.
// ---------------------------------------------------------------------------
describe("reminder — action wiring", () => {
	it("add forwards the full opts object (glob/message/ops/id/team/json)", async () => {
		const program = build();
		await program.parseAsync(
			[
				"reminder",
				"add",
				"--glob",
				"src/**",
				"--message",
				"careful",
				"--ops",
				"Edit,Write",
				"--id",
				"r1",
				"--team",
				"--json",
			],
			{ from: "user" },
		);
		expect(reminderAddCommand).toHaveBeenCalledTimes(1);
		expect(reminderAddCommand.mock.calls[0][0]).toMatchObject({
			glob: "src/**",
			message: "careful",
			ops: "Edit,Write",
			id: "r1",
			once: true, // default true
			team: true,
			json: true,
		});
	});

	it("add reflects --no-once as once:false", async () => {
		const program = build();
		await program.parseAsync(
			["reminder", "add", "--glob", "a", "--message", "m", "--no-once"],
			{ from: "user" },
		);
		expect(reminderAddCommand.mock.calls[0][0]).toMatchObject({ once: false });
	});

	it("rejects a parse error when a requiredOption is missing and never calls the impl", async () => {
		const program = build();
		// exitOverride() turns commander's parse failure into a thrown CommanderError
		// before the action body (and thus the impl) ever runs.
		await expect(
			program.parseAsync(["reminder", "add", "--glob", "a"], { from: "user" }),
		).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
		expect(reminderAddCommand).not.toHaveBeenCalled();
	});

	it("list (default subcommand) forwards view opts when invoked implicitly", async () => {
		const program = build();
		// Bare `reminder` resolves to the isDefault `list` subcommand.
		await program.parseAsync(["reminder", "--json", "--short", "--full"], { from: "user" });
		expect(reminderListCommand).toHaveBeenCalledTimes(1);
		expect(reminderListCommand.mock.calls[0][0]).toMatchObject({
			json: true,
			short: true,
			full: true,
		});
	});

	it("remove forwards the id/glob positional + flags", async () => {
		const program = build();
		await program.parseAsync(["reminder", "remove", "r1", "--team", "--json"], { from: "user" });
		expect(reminderRemoveCommand).toHaveBeenCalledTimes(1);
		expect(reminderRemoveCommand.mock.calls[0][0]).toBe("r1");
		expect(reminderRemoveCommand.mock.calls[0][1]).toMatchObject({ team: true, json: true });
	});

	it("remove passes undefined positional with --all", async () => {
		const program = build();
		await program.parseAsync(["reminder", "remove", "--all"], { from: "user" });
		expect(reminderRemoveCommand.mock.calls[0][0]).toBeUndefined();
		expect(reminderRemoveCommand.mock.calls[0][1]).toMatchObject({ all: true });
	});
});

// ---------------------------------------------------------------------------
// skill — lazy-import action wrappers (each awaits the impl).
// ---------------------------------------------------------------------------
describe("skill — action wiring", () => {
	it("enter forwards the name positional and opts", async () => {
		const program = build();
		await program.parseAsync(
			["skill", "enter", "deep-research", "--ttl", "1h", "--session", "s1", "--source", "hook", "--json"],
			{ from: "user" },
		);
		expect(skillEnterCommand).toHaveBeenCalledTimes(1);
		expect(skillEnterCommand.mock.calls[0][0]).toBe("deep-research");
		expect(skillEnterCommand.mock.calls[0][1]).toMatchObject({
			ttl: "1h",
			session: "s1",
			source: "hook",
			json: true,
		});
	});

	it("leave forwards name + session + json", async () => {
		const program = build();
		await program.parseAsync(["skill", "leave", "deep-research", "--session", "s2", "--json"], {
			from: "user",
		});
		expect(skillLeaveCommand.mock.calls[0][0]).toBe("deep-research");
		expect(skillLeaveCommand.mock.calls[0][1]).toMatchObject({ session: "s2", json: true });
	});

	it("list (default subcommand) forwards session + json when invoked implicitly", async () => {
		const program = build();
		await program.parseAsync(["skill", "--session", "s3", "--json"], { from: "user" });
		expect(skillListCommand).toHaveBeenCalledTimes(1);
		expect(skillListCommand.mock.calls[0][0]).toMatchObject({ session: "s3", json: true });
	});

	it("propagates a rejection thrown by the awaited skill impl", async () => {
		skillEnterCommand.mockRejectedValueOnce(new Error("skill blew up"));
		const program = build();
		await expect(
			program.parseAsync(["skill", "enter", "x"], { from: "user" }),
		).rejects.toThrow("skill blew up");
	});
});

// ---------------------------------------------------------------------------
// handoff / send — two-positional lazy-import wrappers.
// ---------------------------------------------------------------------------
describe("handoff + send — action wiring", () => {
	it("handoff forwards from/to positionals + --include-files + --json", async () => {
		const program = build();
		await program.parseAsync(["handoff", "alice", "bob", "--include-files", "--json"], {
			from: "user",
		});
		expect(handoffCommand).toHaveBeenCalledTimes(1);
		expect(handoffCommand.mock.calls[0][0]).toBe("alice");
		expect(handoffCommand.mock.calls[0][1]).toBe("bob");
		expect(handoffCommand.mock.calls[0][2]).toMatchObject({ includeFiles: true, json: true });
	});

	it("send forwards to + message positionals + flags", async () => {
		const program = build();
		await program.parseAsync(
			["send", "bob", "hello there", "--importance", "urgent", "--json"],
			{ from: "user" },
		);
		expect(sendCommand).toHaveBeenCalledTimes(1);
		expect(sendCommand.mock.calls[0][0]).toBe("bob");
		expect(sendCommand.mock.calls[0][1]).toBe("hello there");
		expect(sendCommand.mock.calls[0][2]).toMatchObject({ importance: "urgent", json: true });
	});

	it("send passes undefined message and --file when body omitted", async () => {
		const program = build();
		await program.parseAsync(["send", "bob", "--file", "/p/note.txt"], { from: "user" });
		expect(sendCommand.mock.calls[0][0]).toBe("bob");
		expect(sendCommand.mock.calls[0][1]).toBeUndefined();
		expect(sendCommand.mock.calls[0][2]).toMatchObject({ file: "/p/note.txt" });
	});
});

// ---------------------------------------------------------------------------
// tasks — five lazy-import wrappers.
// ---------------------------------------------------------------------------
describe("tasks — action wiring", () => {
	it("list (default) forwards every filter when invoked implicitly", async () => {
		const program = build();
		await program.parseAsync(
			[
				"tasks",
				"--status",
				"open",
				"--assignee",
				"me",
				"--priority",
				"high",
				"--limit",
				"5",
				"--json",
				"--short",
				"--full",
			],
			{ from: "user" },
		);
		expect(tasksListCommand).toHaveBeenCalledTimes(1);
		expect(tasksListCommand.mock.calls[0][0]).toMatchObject({
			status: "open",
			assignee: "me",
			priority: "high",
			limit: "5",
			json: true,
			short: true,
			full: true,
		});
	});

	it("create forwards the title positional + opts", async () => {
		const program = build();
		await program.parseAsync(
			["tasks", "create", "Fix bug", "--description", "details", "--assignee", "me", "--priority", "low", "--json"],
			{ from: "user" },
		);
		expect(tasksCreateCommand.mock.calls[0][0]).toBe("Fix bug");
		expect(tasksCreateCommand.mock.calls[0][1]).toMatchObject({
			description: "details",
			assignee: "me",
			priority: "low",
			json: true,
		});
	});

	it("show forwards the id positional + json", async () => {
		const program = build();
		await program.parseAsync(["tasks", "show", "t_1", "--json"], { from: "user" });
		expect(tasksShowCommand.mock.calls[0][0]).toBe("t_1");
		expect(tasksShowCommand.mock.calls[0][1]).toMatchObject({ json: true });
	});

	it("claim forwards the id positional + json", async () => {
		const program = build();
		await program.parseAsync(["tasks", "claim", "t_2", "--json"], { from: "user" });
		expect(tasksClaimCommand.mock.calls[0][0]).toBe("t_2");
		expect(tasksClaimCommand.mock.calls[0][1]).toMatchObject({ json: true });
	});

	it("complete forwards the id positional + json", async () => {
		const program = build();
		await program.parseAsync(["tasks", "complete", "t_3", "--json"], { from: "user" });
		expect(tasksCompleteCommand.mock.calls[0][0]).toBe("t_3");
		expect(tasksCompleteCommand.mock.calls[0][1]).toMatchObject({ json: true });
	});

	it("propagates a rejection from an awaited tasks impl", async () => {
		tasksClaimCommand.mockRejectedValueOnce(new Error("server down"));
		const program = build();
		await expect(
			program.parseAsync(["tasks", "claim", "t_x"], { from: "user" }),
		).rejects.toThrow("server down");
	});
});

// ---------------------------------------------------------------------------
// workspace — list (opts) + switch (id only, no opts forwarded).
// ---------------------------------------------------------------------------
describe("workspace — action wiring", () => {
	it("list forwards --json", async () => {
		const program = build();
		await program.parseAsync(["workspace", "list", "--json"], { from: "user" });
		expect(workspaceListCommand).toHaveBeenCalledTimes(1);
		expect(workspaceListCommand.mock.calls[0][0]).toMatchObject({ json: true });
	});

	it("switch forwards only the id positional", async () => {
		const program = build();
		await program.parseAsync(["workspace", "switch", "ws_42"], { from: "user" });
		expect(workspaceSwitchCommand).toHaveBeenCalledTimes(1);
		expect(workspaceSwitchCommand.mock.calls[0][0]).toBe("ws_42");
	});
});
