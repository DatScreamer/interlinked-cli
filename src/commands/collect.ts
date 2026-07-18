// ===========================================
// interlinked collect — sync external model sessions into the unified timeline
// ===========================================
// Folds OpenAI Codex session transcripts (~/.codex/sessions/) into the repo's
// normalized `.interlinked/timeline.jsonl` (schema timeline.v1), the SAME store
// the daemon fills live from Claude Code transcripts. One place for every
// model's input+output — cross-model analysis, distillation, fine-tuning
// (project ask 2026-07-18). Claude sessions are already captured live/backfill;
// this closes the Codex gap. Idempotent — safe to re-run or schedule.

import type { Command } from "commander";
import { codexSessionsDir, collectCodexSessions } from "../harness/codex-collect.js";
import { parseDuration } from "../lib/activity-utils.js";

interface CollectOpts {
	provider: string;
	since?: string;
	dir?: string;
	dryRun?: boolean;
	json?: boolean;
	cwd?: string;
}

export function registerCollectCommand(program: Command): void {
	program
		.command("collect")
		.description("Sync external model sessions (Codex) into .interlinked/timeline.jsonl")
		.option("--provider <name>", "model provider to collect", "codex")
		.option("--since <duration>", "only sessions modified within this window (e.g. 24h, 7d)")
		.option("--dir <path>", "override the source sessions directory")
		.option("--dry-run", "report counts without writing")
		.option("--json", "machine-readable output")
		.option("--cwd <path>", "working directory whose .interlinked/timeline.jsonl receives the records")
		.action((opts: CollectOpts) => {
			const cwd = opts.cwd ?? process.cwd();
			const provider = (opts.provider ?? "codex").toLowerCase();
			if (provider !== "codex") {
				const msg =
					provider === "claude" || provider === "claude-code"
						? "Claude sessions are already captured live by the daemon (and rebuildable via the timeline backfill) — `collect` covers the external-provider gap. Only `--provider codex` is supported today."
						: `Unknown provider "${provider}". Supported: codex.`;
				if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
				else console.error(msg);
				process.exitCode = 2;
				return;
			}

			let sinceMs: number | undefined;
			if (opts.since) {
				try {
					sinceMs = Date.now() - parseDuration(opts.since);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
					else console.error(msg);
					process.exitCode = 2;
					return;
				}
			}

			const result = collectCodexSessions({
				cwd,
				dir: opts.dir ?? codexSessionsDir(),
				...(sinceMs !== undefined ? { sinceMs } : {}),
				dryRun: opts.dryRun === true,
			});

			if (opts.json) {
				console.log(JSON.stringify({ ok: true, provider, dryRun: opts.dryRun === true, ...result }));
				return;
			}
			const verb = opts.dryRun ? "would add" : "added";
			console.log(
				`codex: scanned ${result.files} rollout file(s) across ${result.sessions} session(s); ` +
					`${verb} ${result.added} new record(s) to .interlinked/timeline.jsonl (parsed ${result.parsed}).`,
			);
			if (result.added === 0 && !opts.dryRun) {
				console.log("timeline already up to date.");
			}
		});
}
