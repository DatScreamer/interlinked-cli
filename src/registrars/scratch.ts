// interlinked-tdd: exempt
// ===========================================
// Scratch registrar — `interlinked scratch init|status`: provision the
// sanctioned session/agent-script home (scratch/ + gitignore carve-out +
// .ignore search negation). Pure commander wiring; logic and tests live in
// src/commands/scratch.ts.
// ===========================================

import { type Command } from "commander";

export function registerScratchCommands(program: Command): void {
	const scratchCmd = program
		.command("scratch")
		.description("Manage the sanctioned session/agent-script home (<repo>/scratch/)");

	scratchCmd
		.command("init")
		.description("Provision scratch/ (README + .gitignore carve-out + .ignore negation)")
		.option("--json", "Machine-readable output")
		.option("--cwd <path>", "Project root (default: current directory)")
		.action(async (opts: { json?: boolean; cwd?: string }) => {
			const { scratchInitCommand } = await import("../commands/scratch.js");
			scratchInitCommand(opts);
		});

	scratchCmd
		.command("status")
		.description("Show which scratch/ pieces are provisioned")
		.option("--json", "Machine-readable output")
		.option("--cwd <path>", "Project root (default: current directory)")
		.action(async (opts: { json?: boolean; cwd?: string }) => {
			const { scratchStatusCommand } = await import("../commands/scratch.js");
			scratchStatusCommand(opts);
		});
}
