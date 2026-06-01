import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerHarnessCommands } from "./harness.js";

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

describe("registerHarnessCommands", () => {
	it("registers the harness and scanner groups", () => {
		const program = new Command();
		registerHarnessCommands(program);
		const top = program.commands.map((c) => c.name());
		expect(top).toContain("harness");
		expect(top).toContain("scanner");
	});

	it("registers harness lifecycle subcommands", () => {
		const program = new Command();
		registerHarnessCommands(program);
		expect(sub(program, "harness").commands.map((c) => c.name()).sort()).toEqual(
			["clean", "latency", "mode", "reap", "restart", "start", "status", "stop", "test"].sort(),
		);
	});

	it("registers scanner subcommands", () => {
		const program = new Command();
		registerHarnessCommands(program);
		expect(sub(program, "scanner").commands.map((c) => c.name()).sort()).toEqual(
			["off", "on", "review", "status", "toggle"].sort(),
		);
	});
});
