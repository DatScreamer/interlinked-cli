// ===========================================
// Adopt registrar — `interlinked adopt`
// ===========================================
// One-command ratchet-from-here bootstrap for large/legacy repos: builds the
// trigram index and seeds every ratchet water-line (large-files grandfather
// list, untested-files exemption list, coverage baseline, metric caps) from
// the repo's CURRENT state. Idempotent; never loosens an existing entry.
// Action lives in src/commands/adopt.ts.

import type { Command } from "commander";
import { adoptCommand } from "../commands/adopt.js";

export function registerAdoptCommands(program: Command): void {
	program
		.command("adopt")
		.description("Bootstrap all ratchet baselines + trigram index from the repo's current state")
		.option("--dry-run", "Print what would be written without writing anything")
		.option("--json", "Machine-readable output")
		.option(
			"--suite-baseline",
			"Also run the test suite once and record red/green + failing tests — the commit-gate red-bar then blocks only NEW failures (re-run after greening)",
		)
		.action(async (opts: { dryRun?: boolean; json?: boolean; suiteBaseline?: boolean }) => {
			await adoptCommand(opts);
		});
}
