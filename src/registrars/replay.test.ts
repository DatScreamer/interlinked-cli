// Replay registrar — pins the command surface (`interlinked replay
// capture|status`) so the subcommand names the docs reference stay wired.

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerReplayCommands } from "./replay.js";

// ---------------------------------------------------------------------------
// Mock every lazily-imported action so parseAsync runs the real .action
// bodies (option names, flag spellings, descriptions) without touching disk.
// ---------------------------------------------------------------------------
// Each mock returns a distinct exit code so tests can assert the real
// `process.exitCode` the registrar sets from the action's return value —
// not just that the mock was invoked.
const replayCaptureAction = vi.fn((..._args: unknown[]) => 11);
const replayAssembleAction = vi.fn((..._args: unknown[]) => 12);
const replayEvalAction = vi.fn(async (..._args: unknown[]) => 13);
const replayReportAction = vi.fn((..._args: unknown[]) => 14);
const replayRestoreAction = vi.fn((..._args: unknown[]) => 15);
const replayStatusAction = vi.fn((..._args: unknown[]) => 16);

vi.mock("../commands/replay.js", () => ({
	replayCaptureAction: (...args: unknown[]) => replayCaptureAction(...args),
	replayAssembleAction: (...args: unknown[]) => replayAssembleAction(...args),
	replayEvalAction: (...args: unknown[]) => replayEvalAction(...args),
	replayReportAction: (...args: unknown[]) => replayReportAction(...args),
	replayRestoreAction: (...args: unknown[]) => replayRestoreAction(...args),
	replayStatusAction: (...args: unknown[]) => replayStatusAction(...args),
}));

function sub(program: Command, name: string): Command {
	const found = program.commands
		.find((c) => c.name() === "replay")
		?.commands.find((c) => c.name() === name);
	if (!found) throw new Error(`missing replay subcommand: ${name}`);
	return found;
}

function build(): Command {
	const program = new Command();
	program.exitOverride();
	registerReplayCommands(program);
	return program;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("registerReplayCommands", () => {
	it("registers replay with capture + status subcommands", () => {
		const program = new Command();
		registerReplayCommands(program);
		const replay = program.commands.find((cmd) => cmd.name() === "replay");
		expect(replay).toBeDefined();
		const subs = (replay?.commands ?? []).map((cmd) => cmd.name()).sort();
		expect(subs).toEqual(["assemble", "capture", "eval", "report", "restore", "status"]);
	});

	it("pins the exact top-level `replay` description", () => {
		const program = new Command();
		registerReplayCommands(program);
		const replay = program.commands.find((cmd) => cmd.name() === "replay");
		expect(replay?.description()).toBe(
			"Capture + replay substrate for the RL/eval environment (G1 inference proxy)",
		);
	});

	it("pins the exact description of every subcommand", () => {
		const program = new Command();
		registerReplayCommands(program);
		expect(sub(program, "capture").description()).toBe(
			"Print how to start the inference-boundary capture proxy",
		);
		expect(sub(program, "assemble").description()).toBe(
			"Join hook logs + envelopes + snapshots into a session's replay trace",
		);
		expect(sub(program, "eval").description()).toBe(
			"Teacher-forced comparison: replay a session's exact observations into a candidate model",
		);
		expect(sub(program, "report").description()).toBe(
			"Aggregate an eval run's ledger (optionally compare two runs)",
		);
		expect(sub(program, "restore").description()).toBe(
			"Materialize a session's fork point: captured tree + harness state at a seq",
		);
		expect(sub(program, "status").description()).toBe(
			"Show captured-envelope counts for this repo",
		);
	});

	it("pins the exact --flag <arg> spelling of every option, per subcommand", () => {
		const program = new Command();
		registerReplayCommands(program);
		const flagsOf = (name: string) => sub(program, name).options.map((o) => o.flags).sort();
		expect(flagsOf("capture")).toEqual(["--json"]);
		expect(flagsOf("assemble")).toEqual(["--json", "--session <id>"].sort());
		expect(flagsOf("eval")).toEqual(
			[
				"--session <id>",
				"--candidate <model>",
				"--base-url <url>",
				"--limit <n>",
				"--keep-thinking",
				"--json",
			].sort(),
		);
		expect(flagsOf("report")).toEqual(["--run <id>", "--compare <id>", "--json"].sort());
		expect(flagsOf("restore")).toEqual(
			["--session <id>", "--seq <n>", "--dest <dir>", "--json"].sort(),
		);
		expect(flagsOf("status")).toEqual(["--json"]);
	});

	it("marks --session/--candidate/--run/--seq/--dest as required options (not plain --option)", () => {
		const program = new Command();
		registerReplayCommands(program);
		const requiredOf = (name: string) =>
			sub(program, name)
				.options.filter((o) => o.mandatory)
				.map((o) => o.long)
				.sort();
		expect(requiredOf("assemble")).toEqual(["--session"]);
		expect(requiredOf("eval")).toEqual(["--candidate", "--session"].sort());
		expect(requiredOf("report")).toEqual(["--run"]);
		expect(requiredOf("restore")).toEqual(["--dest", "--seq", "--session"].sort());
		// --json is optional everywhere, never mandatory.
		expect(sub(program, "capture").options.find((o) => o.long === "--json")?.mandatory).toBe(
			false,
		);
	});

	// Each `.option()`/`.requiredOption()` call takes TWO string-literal
	// arguments: the flag pattern (pinned above via `.flags`) and a help-text
	// description (Commander's `Option#description`, a plain string field —
	// distinct from `Command#description()`, the method pinned above for the
	// command/subcommand blurbs). Nothing about parsing or dispatch depends on
	// the description text, so only reading it back directly can distinguish
	// the real string from a mutated `""`.
	it("pins the exact help-text description of every option (the 2nd arg to .option/.requiredOption)", () => {
		const program = new Command();
		registerReplayCommands(program);
		const descOf = (name: string) => {
			const out: Record<string, string> = {};
			for (const o of sub(program, name).options) out[o.long ?? o.flags] = o.description;
			return out;
		};
		expect(descOf("capture")).toEqual({ "--json": "Machine-readable output" });
		expect(descOf("assemble")).toEqual({
			"--session": "Session id to assemble",
			"--json": "Machine-readable output",
		});
		expect(descOf("eval")).toEqual({
			"--session": "Assembled session to evaluate against",
			"--candidate": "Candidate model id",
			"--base-url": "Candidate endpoint (default: the real API; use for local backends)",
			"--limit": "Max steps to evaluate (cost control)",
			"--keep-thinking": "Keep prior-turn thinking blocks (same-model exactness mode)",
			"--json": "Machine-readable output",
		});
		expect(descOf("report")).toEqual({
			"--run": "Run id to aggregate",
			"--compare": "Second run id to compare against",
			"--json": "Machine-readable output",
		});
		expect(descOf("restore")).toEqual({
			"--session": "Recorded session id",
			"--seq": "Step ordinal to restore (a pre-phase snapshot)",
			"--dest": "Destination directory (created if missing)",
			"--json": "Machine-readable output",
		});
		expect(descOf("status")).toEqual({ "--json": "Machine-readable output" });
	});
});

describe("replay capture — action wiring", () => {
	it("forwards --json through the real --json flag to replayCaptureAction", async () => {
		const program = build();
		await program.parseAsync(["replay", "capture", "--json"], { from: "user" });
		expect(replayCaptureAction).toHaveBeenCalledWith({ json: true });
		expect(process.exitCode).toBe(11);
	});

	it("passes empty opts when --json is omitted", async () => {
		const program = build();
		await program.parseAsync(["replay", "capture"], { from: "user" });
		expect(replayCaptureAction).toHaveBeenCalledWith({});
		expect(process.exitCode).toBe(11);
	});
});

describe("replay assemble — action wiring", () => {
	it("forwards --session through the real flag name to replayAssembleAction", async () => {
		const program = build();
		await program.parseAsync(["replay", "assemble", "--session", "s1", "--json"], {
			from: "user",
		});
		expect(replayAssembleAction).toHaveBeenCalledWith({ session: "s1", json: true });
		expect(process.exitCode).toBe(12);
	});

	it("rejects when --session is omitted (proves the flag is truly required)", async () => {
		const program = build();
		await expect(
			program.parseAsync(["replay", "assemble"], { from: "user" }),
		).rejects.toThrow();
		expect(replayAssembleAction).not.toHaveBeenCalled();
	});
});

describe("replay eval — action wiring", () => {
	it("forwards every option through its real flag name to replayEvalAction", async () => {
		const program = build();
		await program.parseAsync(
			[
				"replay",
				"eval",
				"--session",
				"s1",
				"--candidate",
				"claude-x",
				"--base-url",
				"http://local:9",
				"--limit",
				"5",
				"--keep-thinking",
				"--json",
			],
			{ from: "user" },
		);
		expect(replayEvalAction).toHaveBeenCalledWith({
			session: "s1",
			candidate: "claude-x",
			baseUrl: "http://local:9",
			limit: "5",
			keepThinking: true,
			json: true,
		});
		expect(process.exitCode).toBe(13);
	});

	it("rejects when --candidate is omitted (proves the flag is truly required)", async () => {
		const program = build();
		await expect(
			program.parseAsync(["replay", "eval", "--session", "s1"], { from: "user" }),
		).rejects.toThrow();
		expect(replayEvalAction).not.toHaveBeenCalled();
	});
});

describe("replay report — action wiring", () => {
	it("forwards --run/--compare/--json through their real flag names to replayReportAction", async () => {
		const program = build();
		await program.parseAsync(
			["replay", "report", "--run", "r1", "--compare", "r2", "--json"],
			{ from: "user" },
		);
		expect(replayReportAction).toHaveBeenCalledWith({ run: "r1", compare: "r2", json: true });
		expect(process.exitCode).toBe(14);
	});

	it("rejects when --run is omitted (proves the flag is truly required)", async () => {
		const program = build();
		await expect(program.parseAsync(["replay", "report"], { from: "user" })).rejects.toThrow();
		expect(replayReportAction).not.toHaveBeenCalled();
	});
});

describe("replay restore — action wiring", () => {
	it("forwards --session/--seq/--dest/--json through their real flag names to replayRestoreAction", async () => {
		const program = build();
		await program.parseAsync(
			["replay", "restore", "--session", "s1", "--seq", "3", "--dest", "/tmp/x", "--json"],
			{ from: "user" },
		);
		expect(replayRestoreAction).toHaveBeenCalledWith({
			session: "s1",
			seq: "3",
			dest: "/tmp/x",
			json: true,
		});
		expect(process.exitCode).toBe(15);
	});

	it("rejects when --dest is omitted (proves the flag is truly required)", async () => {
		const program = build();
		await expect(
			program.parseAsync(["replay", "restore", "--session", "s1", "--seq", "3"], {
				from: "user",
			}),
		).rejects.toThrow();
		expect(replayRestoreAction).not.toHaveBeenCalled();
	});
});

describe("replay status — action wiring", () => {
	it("forwards --json through the real flag to replayStatusAction", async () => {
		const program = build();
		await program.parseAsync(["replay", "status", "--json"], { from: "user" });
		expect(replayStatusAction).toHaveBeenCalledWith({ json: true });
		expect(process.exitCode).toBe(16);
	});

	it("passes empty opts when --json is omitted", async () => {
		const program = build();
		await program.parseAsync(["replay", "status"], { from: "user" });
		expect(replayStatusAction).toHaveBeenCalledWith({});
		expect(process.exitCode).toBe(16);
	});
});
