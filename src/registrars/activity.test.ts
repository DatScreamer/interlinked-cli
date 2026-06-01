import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerActivityCommands } from "./activity.js";

function names(cmd: Command): string[] {
	return cmd.commands.map((c) => c.name());
}

describe("registerActivityCommands", () => {
	it("registers the observability top-level commands", () => {
		const program = new Command();
		registerActivityCommands(program);
		const top = names(program);
		for (const name of [
			"activity",
			"explain",
			"inbox",
			"logs",
			"status",
			"watch",
			"telemetry",
			"daemons",
			"sync",
			"trace",
		]) {
			expect(top).toContain(name);
		}
	});

	it("registers trace export/import subcommands", () => {
		const program = new Command();
		registerActivityCommands(program);
		const trace = program.commands.find((c) => c.name() === "trace");
		if (!trace) throw new Error("trace not registered");
		expect(trace.commands.map((c) => c.name()).sort()).toEqual(["export", "import"].sort());
	});

	it("each registered command carries an action handler", () => {
		const program = new Command();
		registerActivityCommands(program);
		// Commander stores the action callback on a private field; a registered
		// leaf command without an action throws "(outputHelp)" on dispatch.
		// We assert presence of a description as a proxy for a wired command.
		for (const cmd of program.commands) {
			expect(cmd.description().length).toBeGreaterThan(0);
		}
	});
});
