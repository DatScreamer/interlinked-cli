import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSupplyChainCommands } from "./supply-chain.js";

describe("registerSupplyChainCommands", () => {
	it("registers the allowlist command group", () => {
		const program = new Command();
		registerSupplyChainCommands(program);
		expect(program.commands.map((c) => c.name())).toContain("allowlist");
	});

	it("registers all allowlist subcommands", () => {
		const program = new Command();
		registerSupplyChainCommands(program);
		const allowlist = program.commands.find((c) => c.name() === "allowlist");
		if (!allowlist) throw new Error("allowlist not registered");
		expect(allowlist.commands.map((c) => c.name()).sort()).toEqual(
			["add", "list", "remove", "snapshot", "verify"].sort(),
		);
	});
});
