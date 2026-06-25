import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { runVizServe, runVizSnapshot } from "../commands/viz.js";
import { registerVizCommands } from "./viz.js";

// Mock the action layer (a DIFFERENT module from the registrar SUT) so parsing
// a subcommand exercises the `.action(...)` wiring without serving a real port.
vi.mock("../commands/viz.js", () => ({
	runVizServe: vi.fn().mockResolvedValue(0),
	runVizSnapshot: vi.fn().mockResolvedValue(0),
}));

describe("registerVizCommands", () => {
	it("registers the viz group with serve/snapshot subcommands", () => {
		const program = new Command();
		registerVizCommands(program);
		const viz = program.commands.find((c) => c.name() === "viz");
		expect(viz).toBeDefined();
		const subs = (viz?.commands ?? []).map((c) => c.name()).sort();
		expect(subs).toEqual(["serve", "snapshot"]);
	});

	it("exposes port/root/json options on serve", () => {
		const program = new Command();
		registerVizCommands(program);
		const viz = program.commands.find((c) => c.name() === "viz");
		const serve = viz?.commands.find((c) => c.name() === "serve");
		const optionNames = (serve?.options ?? []).map((o) => o.long).sort();
		expect(optionNames).toEqual(["--json", "--port", "--root"]);
	});

	it("wires each subcommand's action to its handler", async () => {
		const prevExit = process.exitCode;
		const cases = [
			["serve", vi.mocked(runVizServe)],
			["snapshot", vi.mocked(runVizSnapshot)],
		] as const;
		for (const [sub, fn] of cases) {
			fn.mockClear();
			const program = new Command();
			program.exitOverride();
			registerVizCommands(program);
			await program.parseAsync(["node", "interlinked", "viz", sub]);
			expect(fn).toHaveBeenCalledTimes(1);
		}
		expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
		process.exitCode = prevExit;
	});
});
