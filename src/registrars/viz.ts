// ===========================================
// Viz registrar — `interlinked viz [serve|snapshot]`
// ===========================================
// The baseline-test visualizer: a loopback dashboard rendering the codebase as
// cells, interlinked. Actions live in src/commands/viz.ts.

import type { Command } from "commander";
import { runVizServe, runVizSnapshot } from "../commands/viz.js";

export function registerVizCommands(program: Command): void {
	const viz = program
		.command("viz")
		.description("Baseline-test visualizer — the cells, interlinked (loopback dashboard)");

	viz
		.command("serve", { isDefault: true })
		.description("Serve the live dashboard on a loopback port (ctrl-c to stop)")
		.option("--port <port>", "Port to bind (default 6403)")
		.option("--root <dir>", "Project root to graph (default: cwd)")
		.option("--json", "Print the server URL as JSON and keep serving")
		.action(async (opts: { port?: string; root?: string; json?: boolean }) => {
			process.exitCode = await runVizServe(opts);
		});

	viz
		.command("snapshot")
		.description("Print the graph snapshot the dashboard renders")
		.option("--root <dir>", "Project root to graph (default: cwd)")
		.option("--json", "Machine-readable output")
		.option("--full", "Detailed output")
		.action(async (opts: { root?: string; json?: boolean; full?: boolean }) => {
			process.exitCode = await runVizSnapshot(opts);
		});
}
