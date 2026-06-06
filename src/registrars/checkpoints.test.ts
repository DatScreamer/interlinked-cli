import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCheckpointCommands } from "./checkpoints.js";

// ---------------------------------------------------------------------------
// Mock every lazily-imported command implementation so the .action bodies run
// end-to-end (option spreads, parent-opts merge, default cwd) without touching
// the real git tree, filesystem, or network.
// ---------------------------------------------------------------------------
const checkpointCommand = vi.fn();
const checkpointListCommand = vi.fn();
const checkpointShowCommand = vi.fn();
const checkpointCompareCommand = vi.fn();
const checkpointPruneCommand = vi.fn();
const checkpointArchiveCommand = vi.fn();
const gitContextCommand = vi.fn();
const gitLinkCheckpointCommand = vi.fn();
const guardInstallCommand = vi.fn();
const guardCheckCommand = vi.fn();
const guardStatusCommand = vi.fn();
const guardUninstallCommand = vi.fn();
const resumeCommand = vi.fn();
const rewindCommand = vi.fn();
const resetCommand = vi.fn();

vi.mock("../commands/checkpoint.js", () => ({
	checkpointCommand: (...args: unknown[]) => checkpointCommand(...args),
	checkpointListCommand: (...args: unknown[]) => checkpointListCommand(...args),
	checkpointShowCommand: (...args: unknown[]) => checkpointShowCommand(...args),
	checkpointCompareCommand: (...args: unknown[]) => checkpointCompareCommand(...args),
	checkpointPruneCommand: (...args: unknown[]) => checkpointPruneCommand(...args),
	checkpointArchiveCommand: (...args: unknown[]) => checkpointArchiveCommand(...args),
}));
vi.mock("../commands/git.js", () => ({
	gitContextCommand: (...args: unknown[]) => gitContextCommand(...args),
	gitLinkCheckpointCommand: (...args: unknown[]) => gitLinkCheckpointCommand(...args),
}));
vi.mock("../commands/guard.js", () => ({
	guardInstallCommand: (...args: unknown[]) => guardInstallCommand(...args),
	guardCheckCommand: (...args: unknown[]) => guardCheckCommand(...args),
	guardStatusCommand: (...args: unknown[]) => guardStatusCommand(...args),
	guardUninstallCommand: (...args: unknown[]) => guardUninstallCommand(...args),
}));
vi.mock("../commands/resume.js", () => ({
	resumeCommand: (...args: unknown[]) => resumeCommand(...args),
}));
vi.mock("../commands/rewind.js", () => ({
	rewindCommand: (...args: unknown[]) => rewindCommand(...args),
}));
vi.mock("../commands/reset.js", () => ({
	resetCommand: (...args: unknown[]) => resetCommand(...args),
}));

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

function build(): Command {
	const program = new Command();
	program.exitOverride();
	registerCheckpointCommands(program);
	return program;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerCheckpointCommands — structure", () => {
	it("registers the checkpoint / git / guard groups and top-level restore commands", () => {
		const program = new Command();
		registerCheckpointCommands(program);
		const top = program.commands.map((c) => c.name());
		for (const name of ["checkpoint", "git", "guard", "resume", "rewind", "reset"]) {
			expect(top).toContain(name);
		}
	});

	it("registers checkpoint subcommands", () => {
		const program = new Command();
		registerCheckpointCommands(program);
		expect(sub(program, "checkpoint").commands.map((c) => c.name()).sort()).toEqual(
			["archive", "compare", "list", "prune", "show"].sort(),
		);
	});

	it("registers git and guard subcommands", () => {
		const program = new Command();
		registerCheckpointCommands(program);
		expect(sub(program, "git").commands.map((c) => c.name()).sort()).toEqual(
			["context", "link-checkpoint"].sort(),
		);
		expect(sub(program, "guard").commands.map((c) => c.name()).sort()).toEqual(
			["check", "install", "status", "uninstall"].sort(),
		);
	});

	it("wires the documented options on each subcommand", () => {
		const program = build();
		const cp = sub(program, "checkpoint");
		const git = sub(program, "git");
		const guard = sub(program, "guard");
		const optsOf = (c: Command, name: string) =>
			c.commands
				.find((s) => s.name() === name)
				?.options.map((o) => o.long)
				.sort();
		// Top-level `checkpoint [message]` carries its own options.
		expect(cp.options.map((o) => o.long).sort()).toEqual(["--agent", "--json"].sort());
		expect(optsOf(cp, "list")).toEqual(["--agent", "--json", "--limit", "--since"].sort());
		expect(optsOf(cp, "show")).toEqual(["--json"]);
		expect(optsOf(cp, "compare")).toEqual(["--json"]);
		expect(optsOf(cp, "prune")).toEqual(["--json", "--keep-latest", "--older-than"].sort());
		expect(optsOf(cp, "archive")).toEqual(["--json"]);
		expect(optsOf(git, "context")).toEqual(["--commit", "--json"].sort());
		expect(optsOf(git, "link-checkpoint")).toEqual(
			["--apply", "--checkpoint", "--commit", "--json"].sort(),
		);
		expect(optsOf(guard, "install")).toEqual(["--json", "--mode", "--pre-push"].sort());
		expect(optsOf(guard, "check")).toEqual(["--files", "--json"].sort());
		expect(optsOf(guard, "status")).toEqual(["--json"]);
		expect(optsOf(guard, "uninstall")).toEqual(["--json"]);
		const resume = program.commands.find((c) => c.name() === "resume");
		expect(resume?.options.map((o) => o.long).sort()).toEqual(["--agent", "--json"].sort());
		const rewind = program.commands.find((c) => c.name() === "rewind");
		expect(rewind?.options.map((o) => o.long).sort()).toEqual(
			["--force", "--json", "--list"].sort(),
		);
		const reset = program.commands.find((c) => c.name() === "reset");
		expect(reset?.options.map((o) => o.long).sort()).toEqual(["--force", "--json"].sort());
	});

	it("install --mode defaults to warn", () => {
		const program = build();
		const install = sub(program, "guard").commands.find((c) => c.name() === "install");
		const modeOpt = install?.options.find((o) => o.long === "--mode");
		expect(modeOpt?.defaultValue).toBe("warn");
	});
});

describe("checkpoint (top-level) — action wiring", () => {
	it("forwards the message argument and explicit opts", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "wip: refactor", "--agent", "alice", "--json"], {
			from: "user",
		});
		expect(checkpointCommand).toHaveBeenCalledWith("wip: refactor", {
			agent: "alice",
			json: true,
		});
	});

	it("passes undefined message when omitted and bare opts", async () => {
		const program = build();
		await program.parseAsync(["checkpoint"], { from: "user" });
		expect(checkpointCommand).toHaveBeenCalledWith(undefined, {});
	});
});

describe("checkpoint list — action wiring + parent-opts merge", () => {
	it("uses subcommand's own --json/--agent when present", async () => {
		const program = build();
		await program.parseAsync(
			["checkpoint", "list", "--agent", "bob", "--since", "1d", "--limit", "5", "--json"],
			{ from: "user" },
		);
		expect(checkpointListCommand).toHaveBeenCalledWith({
			agent: "bob",
			since: "1d",
			limit: "5",
			json: true,
		});
	});

	it("inherits --json/--agent from the parent checkpoint command", async () => {
		const program = build();
		// flags placed before the subcommand land on the parent.
		await program.parseAsync(["checkpoint", "--agent", "carol", "--json", "list"], {
			from: "user",
		});
		expect(checkpointListCommand).toHaveBeenCalledWith({
			agent: "carol",
			json: true,
		});
	});

	it("merges to undefined json/agent when neither level sets them", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "list"], { from: "user" });
		expect(checkpointListCommand).toHaveBeenCalledWith({
			json: undefined,
			agent: undefined,
		});
	});
});

describe("checkpoint show — action wiring + parent-opts merge", () => {
	it("forwards id with its own --json", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "show", "cp123", "--json"], { from: "user" });
		expect(checkpointShowCommand).toHaveBeenCalledWith("cp123", { json: true });
	});

	it("inherits --json from the parent checkpoint command", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "--json", "show", "cp9"], { from: "user" });
		expect(checkpointShowCommand).toHaveBeenCalledWith("cp9", { json: true });
	});

	it("merges json to undefined when unset on both levels", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "show", "cpX"], { from: "user" });
		expect(checkpointShowCommand).toHaveBeenCalledWith("cpX", { json: undefined });
	});
});

describe("checkpoint compare — action wiring + parent-opts merge", () => {
	it("forwards both ids with its own --json", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "compare", "a1", "b2", "--json"], { from: "user" });
		expect(checkpointCompareCommand).toHaveBeenCalledWith("a1", "b2", { json: true });
	});

	it("inherits --json from the parent checkpoint command", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "--json", "compare", "a3", "b4"], { from: "user" });
		expect(checkpointCompareCommand).toHaveBeenCalledWith("a3", "b4", { json: true });
	});
});

describe("checkpoint prune — action wiring + parent-opts merge", () => {
	it("forwards prune options with its own --json", async () => {
		const program = build();
		await program.parseAsync(
			["checkpoint", "prune", "--older-than", "30", "--keep-latest", "3", "--json"],
			{ from: "user" },
		);
		expect(checkpointPruneCommand).toHaveBeenCalledWith({
			olderThan: "30",
			keepLatest: "3",
			json: true,
		});
	});

	it("inherits --json from the parent checkpoint command", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "--json", "prune"], { from: "user" });
		expect(checkpointPruneCommand).toHaveBeenCalledWith({ json: true });
	});
});

describe("checkpoint archive — action wiring + parent-opts merge", () => {
	it("forwards its own --json", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "archive", "--json"], { from: "user" });
		expect(checkpointArchiveCommand).toHaveBeenCalledWith({ json: true });
	});

	it("inherits --json from the parent checkpoint command", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "--json", "archive"], { from: "user" });
		expect(checkpointArchiveCommand).toHaveBeenCalledWith({ json: true });
	});

	it("merges json to undefined when unset on both levels", async () => {
		const program = build();
		await program.parseAsync(["checkpoint", "archive"], { from: "user" });
		expect(checkpointArchiveCommand).toHaveBeenCalledWith({ json: undefined });
	});
});

// NOTE: each merge-pattern subcommand (list/show/compare/prune/archive) computes
// `cmd.parent?.opts() || {}`. Commander always passes the real subcommand — which
// always has a parent when its action fires — so the `?.` short-circuit and the
// `|| {}` fallback are unreachable belt-and-suspenders (5 uncovered branch paths).
// Calling `_actionHandler` directly does not help: commander rebuilds `cmd` as the
// real subcommand (real parent) and ignores any synthetic argument. Left untested.

describe("git context / link-checkpoint — action wiring", () => {
	it("forwards opts to gitContextCommand", async () => {
		const program = build();
		await program.parseAsync(["git", "context", "--commit", "deadbeef", "--json"], {
			from: "user",
		});
		expect(gitContextCommand).toHaveBeenCalledWith({ commit: "deadbeef", json: true });
	});

	it("passes empty opts to gitContextCommand by default", async () => {
		const program = build();
		await program.parseAsync(["git", "context"], { from: "user" });
		expect(gitContextCommand).toHaveBeenCalledWith({});
	});

	it("forwards opts to gitLinkCheckpointCommand", async () => {
		const program = build();
		await program.parseAsync(
			["git", "link-checkpoint", "--checkpoint", "cp1", "--commit", "abc", "--apply", "--json"],
			{ from: "user" },
		);
		expect(gitLinkCheckpointCommand).toHaveBeenCalledWith({
			checkpoint: "cp1",
			commit: "abc",
			apply: true,
			json: true,
		});
	});
});

describe("guard install / check / status / uninstall — action wiring", () => {
	it("forwards install opts including the default --mode warn", async () => {
		const program = build();
		await program.parseAsync(["guard", "install"], { from: "user" });
		expect(guardInstallCommand).toHaveBeenCalledWith({ mode: "warn" });
	});

	it("forwards install opts with overrides", async () => {
		const program = build();
		await program.parseAsync(
			["guard", "install", "--mode", "block", "--pre-push", "--json"],
			{ from: "user" },
		);
		expect(guardInstallCommand).toHaveBeenCalledWith({
			mode: "block",
			prePush: true,
			json: true,
		});
	});

	it("forwards variadic --files to guardCheckCommand", async () => {
		const program = build();
		await program.parseAsync(
			["guard", "check", "--files", "a.ts", "b.ts", "--json"],
			{ from: "user" },
		);
		expect(guardCheckCommand).toHaveBeenCalledWith({ files: ["a.ts", "b.ts"], json: true });
	});

	it("passes empty opts to guardCheckCommand by default", async () => {
		const program = build();
		await program.parseAsync(["guard", "check"], { from: "user" });
		expect(guardCheckCommand).toHaveBeenCalledWith({});
	});

	it("forwards opts to guardStatusCommand", async () => {
		const program = build();
		await program.parseAsync(["guard", "status", "--json"], { from: "user" });
		expect(guardStatusCommand).toHaveBeenCalledWith({ json: true });
	});

	it("forwards opts to guardUninstallCommand", async () => {
		const program = build();
		await program.parseAsync(["guard", "uninstall", "--json"], { from: "user" });
		expect(guardUninstallCommand).toHaveBeenCalledWith({ json: true });
	});
});

describe("resume / rewind / reset — action wiring", () => {
	it("forwards id + opts to resumeCommand", async () => {
		const program = build();
		await program.parseAsync(["resume", "cp42", "--agent", "dan", "--json"], { from: "user" });
		expect(resumeCommand).toHaveBeenCalledWith("cp42", { agent: "dan", json: true });
	});

	it("passes undefined id to resumeCommand when omitted", async () => {
		const program = build();
		await program.parseAsync(["resume"], { from: "user" });
		expect(resumeCommand).toHaveBeenCalledWith(undefined, {});
	});

	it("forwards id + opts to rewindCommand", async () => {
		const program = build();
		await program.parseAsync(["rewind", "cp7", "--force", "--list", "--json"], { from: "user" });
		expect(rewindCommand).toHaveBeenCalledWith("cp7", { force: true, list: true, json: true });
	});

	it("passes undefined id to rewindCommand when omitted", async () => {
		const program = build();
		await program.parseAsync(["rewind"], { from: "user" });
		expect(rewindCommand).toHaveBeenCalledWith(undefined, {});
	});

	it("forwards opts to resetCommand", async () => {
		const program = build();
		await program.parseAsync(["reset", "--force", "--json"], { from: "user" });
		expect(resetCommand).toHaveBeenCalledWith({ force: true, json: true });
	});

	it("passes empty opts to resetCommand by default", async () => {
		const program = build();
		await program.parseAsync(["reset"], { from: "user" });
		expect(resetCommand).toHaveBeenCalledWith({});
	});
});
