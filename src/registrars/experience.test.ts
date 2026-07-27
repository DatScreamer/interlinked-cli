// Experience registrar — pins the `interlinked experience` command surface so
// the subcommand names the docs reference stay wired.

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerExperienceCommands } from "./experience.js";

describe("registerExperienceCommands", () => {
	it("registers experience with export + analyze + list subcommands", () => {
		const program = new Command();
		registerExperienceCommands(program);
		const experience = program.commands.find((cmd) => cmd.name() === "experience");
		expect(experience).toBeDefined();
		const subs = (experience?.commands ?? []).map((cmd) => cmd.name()).sort();
		expect(subs).toEqual(["analyze", "export", "list"]);
	});
});
