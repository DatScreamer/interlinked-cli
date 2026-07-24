// Replay registrar — pins the command surface (`interlinked replay
// capture|status`) so the subcommand names the docs reference stay wired.

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerReplayCommands } from "./replay.js";

describe("registerReplayCommands", () => {
	it("registers replay with capture + status subcommands", () => {
		const program = new Command();
		registerReplayCommands(program);
		const replay = program.commands.find((cmd) => cmd.name() === "replay");
		expect(replay).toBeDefined();
		const subs = (replay?.commands ?? []).map((cmd) => cmd.name()).sort();
		expect(subs).toEqual(["assemble", "capture", "eval", "report", "restore", "status"]);
	});
});
