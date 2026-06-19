#!/usr/bin/env node
// ===========================================
// Interlinked CLI — Local companion: hooks, activity capture, guard evaluation, and developer observability
// ===========================================
//
// This is the thin entry point. Command registration is grouped by domain
// into registrar modules under `src/registrars/` (each `registerXxx(program)`
// is independently unit-testable). A handful of older command groups expose
// their own `registerXxxCommand(program)` from `src/commands/`. This file owns
// only the wiring: program metadata, help text, the version command (which
// closes over `CLI_VERSION`), alphabetical sort, and parse/dispatch.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerCiCommand } from "./commands/ci-status.js";
import { registerCompactCommand } from "./commands/compact.js";
import { handleImplicitEntry } from "./commands/first-run.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { registerActivityCommands } from "./registrars/activity.js";
import { registerCapsCommands } from "./registrars/caps.js";
import { registerCheckpointCommands } from "./registrars/checkpoints.js";
import { registerCoordinationCommands } from "./registrars/coordination.js";
import { registerHarnessCommands } from "./registrars/harness.js";
import { registerMcpCommands } from "./registrars/mcp.js";
import { registerObservabilityLogCommands } from "./registrars/observability-logs.js";
import { registerQualityCommands } from "./registrars/quality.js";
import { registerSetupCommands } from "./registrars/setup.js";
import { registerSponsorCommands } from "./registrars/sponsor.js";
import { registerSupplyChainCommands } from "./registrars/supply-chain.js";

const program = new Command();

// Read version from package.json so it stays in sync with the package
function resolveVersion(): string {
	try {
		const pkgPath = new URL("../package.json", import.meta.url);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}
const CLI_VERSION = resolveVersion();

program
	.name("interlinked")
	.description("Interlinked CLI: local hooks, activity capture, and developer observability")
	.version(CLI_VERSION);

program.showHelpAfterError();
program.addHelpText(
	"afterAll",
	`
Interface boundaries:
  Interlinked CLI        local hooks, harness checks, activity capture, diagnostics
  Server                 optional remote tasks/messages/reservations/agent state
  Web UI (/chat, /map)   optional human oversight and coordination

Zero-arg behavior:
  interlinked            setup wizard (if unconfigured) or status dashboard

Quick start:
  interlinked install-hooks --runner claude-code    install local agent hooks
  interlinked harness start                         start local guard server
  interlinked status                                 dashboard
  interlinked login --server <url>                  optional server auth
`,
);

// ===========================================
// Command registration (grouped by domain)
// ===========================================
registerActivityCommands(program);
registerObservabilityLogCommands(program);
registerSupplyChainCommands(program);
registerHarnessCommands(program);
registerMcpCommands(program);
registerCheckpointCommands(program);
registerCoordinationCommands(program);
registerQualityCommands(program);
registerCapsCommands(program);
registerSetupCommands(program);
registerSponsorCommands(program);
registerIndexCommand(program);
registerCiCommand(program);
registerCompactCommand(program);

program
	.command("version")
	.description("Show Interlinked CLI + server version")
	.action(async () => {
		const { getClient } = await import("./lib/api-client.js");
		console.log(`Interlinked CLI v${CLI_VERSION}`);
		try {
			const client = getClient();
			const result = await client.callTool<{ status?: string }>("health_check");
			console.log(
				`Server: ${client.getConfig().server_url} (${result.status || "ok"})`,
			);
		} catch {
			console.log(
				`Server: ${getClient().getConfig().server_url} (unreachable or not authenticated)`,
			);
		}
	});

// ===========================================
// Parse and Execute
// ===========================================

// Sort top-level commands alphabetically in help output.
// Commander renders commands in registration order, so we sort the
// internal array just before parsing. This keeps help tidy even as
// new commands are added anywhere in this file.
(program.commands as Command[]).sort((a: Command, b: Command) => a.name().localeCompare(b.name()));

if (!(await handleImplicitEntry())) {
	await program.parseAsync(process.argv);
}
