// ===========================================
// Replay registrar — `interlinked replay capture|status`
// ===========================================
// Operator surface for the reproducibility/replay program
// (docs/design/reproducibility/). Actions live in src/commands/replay.ts;
// the eval/assembler subcommands arrive with Tier 1.

import type { Command } from "commander";
import {
	replayAssembleAction,
	replayCaptureAction,
	replayEvalAction,
	replayReportAction,
	replayRestoreAction,
	replayStatusAction,
} from "../commands/replay.js";

export function registerReplayCommands(program: Command): void {
	const replay = program
		.command("replay")
		.description("Capture + replay substrate for the RL/eval environment (G1 inference proxy)");

	replay
		.command("capture")
		.description("Print how to start the inference-boundary capture proxy")
		.option("--json", "Machine-readable output")
		.action((opts: { json?: boolean }) => {
			process.exitCode = replayCaptureAction(opts);
		});

	replay
		.command("assemble")
		.description("Join hook logs + envelopes + snapshots into a session's replay trace")
		.requiredOption("--session <id>", "Session id to assemble")
		.option("--json", "Machine-readable output")
		.action((opts: { session: string; json?: boolean }) => {
			process.exitCode = replayAssembleAction(opts);
		});

	replay
		.command("eval")
		.description("Teacher-forced comparison: replay a session's exact observations into a candidate model")
		.requiredOption("--session <id>", "Assembled session to evaluate against")
		.requiredOption("--candidate <model>", "Candidate model id")
		.option("--base-url <url>", "Candidate endpoint (default: the real API; use for local backends)")
		.option("--limit <n>", "Max steps to evaluate (cost control)")
		.option("--keep-thinking", "Keep prior-turn thinking blocks (same-model exactness mode)")
		.option("--json", "Machine-readable output")
		.action(
			async (opts: {
				session: string;
				candidate: string;
				baseUrl?: string;
				limit?: string;
				keepThinking?: boolean;
				json?: boolean;
			}) => {
				process.exitCode = await replayEvalAction(opts);
			},
		);

	replay
		.command("report")
		.description("Aggregate an eval run's ledger (optionally compare two runs)")
		.requiredOption("--run <id>", "Run id to aggregate")
		.option("--compare <id>", "Second run id to compare against")
		.option("--json", "Machine-readable output")
		.action((opts: { run: string; compare?: string; json?: boolean }) => {
			process.exitCode = replayReportAction(opts);
		});

	replay
		.command("restore")
		.description("Materialize a session's fork point: captured tree + harness state at a seq")
		.requiredOption("--session <id>", "Recorded session id")
		.requiredOption("--seq <n>", "Step ordinal to restore (a pre-phase snapshot)")
		.requiredOption("--dest <dir>", "Destination directory (created if missing)")
		.option("--json", "Machine-readable output")
		.action((opts: { session: string; seq: string; dest: string; json?: boolean }) => {
			process.exitCode = replayRestoreAction(opts);
		});

	replay
		.command("status")
		.description("Show captured-envelope counts for this repo")
		.option("--json", "Machine-readable output")
		.action((opts: { json?: boolean }) => {
			process.exitCode = replayStatusAction(opts);
		});
}
