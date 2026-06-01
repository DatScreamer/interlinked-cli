import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerQualityCommands } from "./quality.js";

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

describe("registerQualityCommands", () => {
	it("registers the quality / edit top-level commands", () => {
		const program = new Command();
		registerQualityCommands(program);
		const top = program.commands.map((c) => c.name());
		for (const name of [
			"check",
			"search",
			"multi-edit",
			"verify",
			"write",
			"structure",
			"coverage",
			"mutation",
		]) {
			expect(top).toContain(name);
		}
	});

	it("registers structure / coverage / mutation subcommands", () => {
		const program = new Command();
		registerQualityCommands(program);
		expect(sub(program, "structure").commands.map((c) => c.name()).sort()).toEqual(
			["accept", "baseline", "doctor", "init", "scan", "status"].sort(),
		);
		expect(sub(program, "coverage").commands.map((c) => c.name()).sort()).toEqual(
			["baseline", "check"].sort(),
		);
		expect(sub(program, "mutation").commands.map((c) => c.name()).sort()).toEqual(
			["baseline", "check"].sort(),
		);
	});
});
