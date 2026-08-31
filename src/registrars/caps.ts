// ===========================================
// Caps registrar — `interlinked caps [set|explain]`
// ===========================================
// One surface for the six quality-metric caps/goals the harness enforces. Bare
// `caps` shows the effective caps + provenance; `caps set` writes a per-repo
// override to .interlinked/metric-caps.json; `caps explain` prints the glossary.
// Actions live in src/commands/caps.ts.

import type { Command } from "commander";
import { capsExplainAction, capsSetAction, capsShowAction } from "../commands/caps.js";

export function registerCapsCommands(program: Command): void {
	const caps = program
		.command("caps")
		.description("View, set, and explain quality caps (lines/function-tokens/complexity/CRAP/coverage)")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			process.exitCode = await capsShowAction(opts);
		});

	caps
		.command("set <metric> <value>")
		.description("Set a cap (metric: lines | function-tokens | cyclomatic | cognitive | crap | coverage)")
		.option("--json", "Machine-readable output")
		.action(async (metric: string, value: string, opts: { json?: boolean }) => {
			process.exitCode = await capsSetAction(metric, value, opts);
		});

	caps
		.command("explain [metric]")
		.description("Explain what each metric means, its default, and how to change it")
		.option("--json", "Machine-readable output")
		.action(async (metric: string | undefined, opts: { json?: boolean }) => {
			process.exitCode = await capsExplainAction(metric, opts);
		});
}
