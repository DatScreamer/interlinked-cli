import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerObservabilityLogCommands } from "./observability-logs.js";

function names(cmd: Command): string[] {
	return cmd.commands.map((c) => c.name());
}

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

describe("registerObservabilityLogCommands", () => {
	it("registers the append-only log inspection groups", () => {
		const program = new Command();
		registerObservabilityLogCommands(program);
		const top = names(program);
		for (const name of ["recurrence", "trajectory", "audit", "plan", "cloud"]) {
			expect(top).toContain(name);
		}
	});

	it("registers recurrence subcommands", () => {
		const program = new Command();
		registerObservabilityLogCommands(program);
		expect(names(sub(program, "recurrence")).sort()).toEqual(
			["detail", "flag", "list", "propose", "scan"].sort(),
		);
	});

	it("registers trajectory + audit + plan + cloud subcommands", () => {
		const program = new Command();
		registerObservabilityLogCommands(program);
		expect(names(sub(program, "trajectory")).sort()).toEqual(["list", "replay", "show"].sort());
		expect(names(sub(program, "audit"))).toEqual(["verify"]);
		expect(names(sub(program, "plan")).sort()).toEqual(["list", "show"].sort());
		expect(names(sub(program, "cloud"))).toEqual(["recent"]);
	});
});
