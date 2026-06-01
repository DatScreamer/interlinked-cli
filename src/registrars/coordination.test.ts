import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerCoordinationCommands } from "./coordination.js";

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

describe("registerCoordinationCommands", () => {
	it("registers the coordination top-level commands", () => {
		const program = new Command();
		registerCoordinationCommands(program);
		const top = program.commands.map((c) => c.name());
		for (const name of ["attach", "reminder", "skill", "handoff", "send", "tasks", "workspace"]) {
			expect(top).toContain(name);
		}
	});

	it("registers reminder / skill / tasks / workspace subcommands", () => {
		const program = new Command();
		registerCoordinationCommands(program);
		expect(sub(program, "reminder").commands.map((c) => c.name()).sort()).toEqual(
			["add", "list", "remove"].sort(),
		);
		expect(sub(program, "skill").commands.map((c) => c.name()).sort()).toEqual(
			["enter", "leave", "list"].sort(),
		);
		expect(sub(program, "tasks").commands.map((c) => c.name()).sort()).toEqual(
			["claim", "complete", "create", "list", "show"].sort(),
		);
		expect(sub(program, "workspace").commands.map((c) => c.name()).sort()).toEqual(
			["list", "switch"].sort(),
		);
	});
});
