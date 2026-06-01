import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerCheckpointCommands } from "./checkpoints.js";

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

describe("registerCheckpointCommands", () => {
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
});
