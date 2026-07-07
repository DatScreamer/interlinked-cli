import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { adoptCommand } from "../commands/adopt.js";
import { registerAdoptCommands } from "./adopt.js";

// Mock the action layer (a different module from the registrar SUT) so parsing
// exercises the `.action(...)` wiring without walking a real repo or writing
// any baselines.
vi.mock("../commands/adopt.js", () => ({
	adoptCommand: vi.fn().mockResolvedValue(undefined),
}));

describe("registerAdoptCommands", () => {
	it("registers the adopt command with --dry-run, --json, and --suite-baseline options", () => {
		const program = new Command();
		registerAdoptCommands(program);
		const adopt = program.commands.find((c) => c.name() === "adopt");
		expect(adopt).toBeDefined();
		const optionNames = (adopt?.options ?? []).map((o) => o.long).sort();
		expect(optionNames).toEqual(["--dry-run", "--json", "--suite-baseline"]);
	});

	it("runs adoptCommand for a bare `adopt` invocation", async () => {
		vi.mocked(adoptCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerAdoptCommands(program);
		await program.parseAsync(["node", "interlinked", "adopt"]);
		expect(vi.mocked(adoptCommand)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(adoptCommand)).toHaveBeenCalledWith(
			expect.not.objectContaining({ dryRun: true }),
		);
	});

	it("forwards --dry-run and --json to adoptCommand", async () => {
		vi.mocked(adoptCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerAdoptCommands(program);
		await program.parseAsync(["node", "interlinked", "adopt", "--dry-run", "--json"]);
		expect(vi.mocked(adoptCommand)).toHaveBeenCalledWith(
			expect.objectContaining({ dryRun: true, json: true }),
		);
	});
});
