// ===========================================
// Experience registrar — `interlinked experience export|analyze|list`
// ===========================================
// Agent-readable trajectory projections over the session logs. Actions live
// in src/commands/experience.ts; formats in src/commands/experience/types.ts.

import type { Command } from "commander";
import {
	experienceAnalyzeAction,
	experienceExportAction,
	experienceListAction,
} from "../commands/experience.js";

export function registerExperienceCommands(program: Command): void {
	const experience = program
		.command("experience")
		.description(
			"Agent-readable trajectory export + analysis (trajectory-v1 interop / trajectory-ix.v1 annotated)",
		);

	experience
		.command("export")
		.description("Project a session's logs into a trajectory file")
		.requiredOption("--session <id>", "Session id to export")
		.option("--format <format>", "ix (annotated, default) or letta (interop)")
		.option("--out <path>", "Output path (default: .interlinked/trajectories/<session>.<format>.jsonl)")
		.option("--truncate <chars>", "Tool-result cap in chars (default 4000; 0 keeps everything)")
		.option("--json", "Machine-readable output")
		.action((opts: { session: string; format?: string; out?: string; truncate?: string; json?: boolean }) => {
			process.exitCode = experienceExportAction(opts);
		});

	experience
		.command("analyze")
		.description("Deterministic session metrics: tool mix, verify:edit, guard blocks, rework")
		.requiredOption("--session <id>", "Session id to analyze")
		.option("--json", "Machine-readable output")
		.action((opts: { session: string; json?: boolean }) => {
			process.exitCode = experienceAnalyzeAction(opts);
		});

	experience
		.command("list")
		.description("Sessions present in the timeline tail")
		.option("--limit <n>", "Max sessions to show (default 10)")
		.option("--json", "Machine-readable output")
		.action((opts: { limit?: string; json?: boolean }) => {
			process.exitCode = experienceListAction(opts);
		});
}
