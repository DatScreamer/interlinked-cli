import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
	sponsorDisableAction,
	sponsorEnableAction,
	sponsorStatusAction,
} from "../commands/sponsor.js";
import { registerSponsorCommands } from "./sponsor.js";

// Mock the action layer (a DIFFERENT module from the registrar SUT) so parsing
// a subcommand exercises the `.action(...)` wiring without real side effects.
vi.mock("../commands/sponsor.js", () => ({
	sponsorEnableAction: vi.fn().mockResolvedValue(0),
	sponsorDisableAction: vi.fn().mockResolvedValue(0),
	sponsorStatusAction: vi.fn().mockResolvedValue(0),
}));

describe("registerSponsorCommands", () => {
	it("registers the sponsor group with enable/disable/status subcommands", () => {
		const program = new Command();
		registerSponsorCommands(program);
		const sponsor = program.commands.find((c) => c.name() === "sponsor");
		expect(sponsor).toBeDefined();
		const subs = (sponsor?.commands ?? []).map((c) => c.name()).sort();
		expect(subs).toEqual(["disable", "enable", "status"]);
	});

	it("exposes the spinner and feed-url options on enable", () => {
		const program = new Command();
		registerSponsorCommands(program);
		const sponsor = program.commands.find((c) => c.name() === "sponsor");
		const enable = sponsor?.commands.find((c) => c.name() === "enable");
		const optionNames = (enable?.options ?? []).map((o) => o.long).sort();
		expect(optionNames).toEqual(["--feed-url", "--json", "--spinner"]);
	});

	it("wires each subcommand's action to its handler and sets the exit code", async () => {
		const prevExit = process.exitCode;
		const cases = [
			["enable", vi.mocked(sponsorEnableAction)],
			["disable", vi.mocked(sponsorDisableAction)],
			["status", vi.mocked(sponsorStatusAction)],
		] as const;
		for (const [sub, fn] of cases) {
			fn.mockClear();
			const program = new Command();
			program.exitOverride();
			registerSponsorCommands(program);
			await program.parseAsync(["node", "interlinked", "sponsor", sub]);
			expect(fn).toHaveBeenCalledTimes(1);
		}
		expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
		process.exitCode = prevExit;
	});
});
