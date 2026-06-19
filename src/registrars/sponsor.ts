// ===========================================
// Sponsor registrar — `interlinked sponsor enable|disable|status`
// ===========================================
// Opt-in sponsor slot for the statusline (docs/design/sponsor-slots.md).
// The actions live in src/commands/sponsor.ts; the daemon renders the row.

import type { Command } from "commander";
import {
	sponsorDisableAction,
	sponsorEnableAction,
	sponsorStatusAction,
} from "../commands/sponsor.js";

export function registerSponsorCommands(program: Command): void {
	const sponsor = program
		.command("sponsor")
		.description("Opt-in sponsor slot on the statusline (free-sponsor phase)");

	sponsor
		.command("enable")
		.description("Enable the sponsor row (and optionally a spinner verb)")
		.option("--spinner", "Also add an append-mode sponsored spinner verb (Claude Code)")
		.option("--feed-url <url>", "Override the sponsor feed URL")
		.option("--json", "Machine-readable output")
		.action(async (opts: { spinner?: boolean; feedUrl?: string; json?: boolean }) => {
			process.exitCode = await sponsorEnableAction(opts);
		});

	sponsor
		.command("disable")
		.description("Disable the sponsor row and remove any sponsored spinner verbs")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			process.exitCode = await sponsorDisableAction(opts);
		});

	sponsor
		.command("status")
		.description("Show sponsor slot configuration and the live creative")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			process.exitCode = await sponsorStatusAction(opts);
		});
}
