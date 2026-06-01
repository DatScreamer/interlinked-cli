import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSetupCommands } from "./setup.js";

describe("registerSetupCommands", () => {
	it("registers the setup / lifecycle top-level commands", () => {
		const program = new Command();
		registerSetupCommands(program);
		const top = program.commands.map((c) => c.name());
		for (const name of [
			"clean",
			"completions",
			"context",
			"disable",
			"doctor",
			"enable",
			"env",
			"init",
			"login",
			"logout",
			"setup",
			"update",
			"install-hooks",
			"uninstall-hooks",
			"mode",
		]) {
			expect(top).toContain(name);
		}
	});

	it("exposes the upgrade alias on update", () => {
		const program = new Command();
		registerSetupCommands(program);
		const update = program.commands.find((c) => c.name() === "update");
		if (!update) throw new Error("update not registered");
		expect(update.aliases()).toContain("upgrade");
	});
});
