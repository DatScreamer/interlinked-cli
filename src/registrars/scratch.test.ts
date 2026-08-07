import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { scratchInitCommand, scratchStatusCommand } from "../commands/scratch.js";
import { registerScratchCommands } from "./scratch.js";

// Mock the action layer (a different module from the registrar SUT) so parsing
// exercises the `.action(...)` wiring — including the dynamic `import(...)`
// inside each action — without touching the filesystem.
vi.mock("../commands/scratch.js", () => ({
	scratchInitCommand: vi.fn().mockResolvedValue(undefined),
	scratchStatusCommand: vi.fn().mockResolvedValue(undefined),
}));

describe("registerScratchCommands", () => {
	it("registers `scratch init` and `scratch status` subcommands with --json and --cwd", () => {
		const program = new Command();
		registerScratchCommands(program);
		const scratchCmd = program.commands.find((c) => c.name() === "scratch");
		expect(scratchCmd).toBeDefined();
		const sub = (scratchCmd?.commands ?? []).map((c) => c.name()).sort();
		expect(sub).toEqual(["init", "status"]);

		const initCmd = scratchCmd?.commands.find((c) => c.name() === "init");
		const initOptionNames = (initCmd?.options ?? []).map((o) => o.long).sort();
		expect(initOptionNames).toEqual(["--cwd", "--json"]);

		const statusCmd = scratchCmd?.commands.find((c) => c.name() === "status");
		const statusOptionNames = (statusCmd?.options ?? []).map((o) => o.long).sort();
		expect(statusOptionNames).toEqual(["--cwd", "--json"]);
	});

	it("runs scratchInitCommand for `scratch init`, forwarding --json and --cwd", async () => {
		vi.mocked(scratchInitCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerScratchCommands(program);
		await program.parseAsync([
			"node",
			"interlinked",
			"scratch",
			"init",
			"--json",
			"--cwd",
			"/tmp/proj",
		]);
		expect(vi.mocked(scratchInitCommand)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(scratchInitCommand)).toHaveBeenCalledWith(
			expect.objectContaining({ json: true, cwd: "/tmp/proj" }),
		);
	});

	it("runs scratchStatusCommand for a bare `scratch status` invocation", async () => {
		vi.mocked(scratchStatusCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerScratchCommands(program);
		await program.parseAsync(["node", "interlinked", "scratch", "status"]);
		expect(vi.mocked(scratchStatusCommand)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(scratchStatusCommand)).toHaveBeenCalledWith(
			expect.not.objectContaining({ json: true }),
		);
	});
});
