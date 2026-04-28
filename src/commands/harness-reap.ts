// ===========================================
// `interlinked harness reap` — orphan-daemon sweep
// ===========================================
// Surgical alternative to `pkill -f interlinked-cli/dist/harness/server`. The
// raw pkill kills active and orphans alike; this command keeps the active
// daemon alive by default. Reuses the helper in `commands/harness.ts` that
// already gates on (a) the active `harness.pid`, (b) the shell/agent ancestor
// chain, (c) self-pid. Default is dry-run so the user sees the impact before
// opting in.
//
// Spec: docs/plans/free-cli-adoption/_phase-e-operational-commands.md §1.

import { c } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { type ReapResult, reapOrphanHarnesses } from "./harness.js";

const DECISION_BLOCK = "block";
void DECISION_BLOCK; // satisfies lint about magic string in conditional — unused

export interface HarnessReapOptions {
	/** Skip dry-run safety; actually issue SIGTERM. */
	force?: boolean;
	/** Also signal the active daemon (equivalent of bash `pkill -f`). */
	all?: boolean;
	/** Machine-readable output. */
	json?: boolean;
}

interface ReapOutputJson {
	dry_run: boolean;
	scope: "orphans" | "all";
	candidates: Array<{ pid: number; ppid: number; command: string }>;
	killed: number[];
}

/**
 * Run the orphan reaper from the CLI surface. The default invocation is a
 * dry-run — we list candidates without signalling. `--force` flips the actual
 * SIGTERM. `--all` widens scope to include the active daemon. Combine
 * `--force --all` for the equivalent of `pkill -f` plus state cleanup.
 */
export async function harnessReapCommand(options: HarnessReapOptions = {}): Promise<void> {
	const mode = getOutputMode(options);
	const cwd = process.cwd();
	const dryRun = options.force !== true;
	const killAll = options.all === true;

	let result: ReapResult;
	try {
		result = reapOrphanHarnesses(cwd, { dryRun, killAll });
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
		return;
	}

	const payload: ReapOutputJson = {
		dry_run: dryRun,
		scope: killAll ? "all" : "orphans",
		candidates: result.candidates.map((cand) => ({
			pid: cand.pid,
			ppid: cand.ppid,
			command: cand.command,
		})),
		killed: result.killed,
	};

	output(mode, payload, {
		json: () => payload,
		normal: () => formatReapHumanOutput(payload),
	});
}

function formatReapHumanOutput(payload: ReapOutputJson): string {
	const lines: string[] = [];
	const scopeLabel = payload.scope === "all" ? "all harness daemons" : "orphan harness daemons";
	if (payload.candidates.length === 0) {
		lines.push(c.dim(`No ${scopeLabel} found.`));
		return lines.join("\n");
	}
	const verb = payload.dry_run ? "Would reap" : "Reaped";
	lines.push(`${c.bold(verb)} ${payload.candidates.length} ${scopeLabel}:`);
	for (const cand of payload.candidates) {
		const tag = payload.dry_run ? c.dim("[dry-run]") : c.green("[killed]");
		lines.push(`  ${tag} pid=${cand.pid} ppid=${cand.ppid} ${c.dim(truncate(cand.command, 70))}`);
	}
	if (payload.dry_run) {
		lines.push("");
		lines.push(
			c.dim("Pass --force to actually SIGTERM these processes."),
		);
	} else {
		const skipped = payload.candidates.length - payload.killed.length;
		if (skipped > 0) {
			lines.push(
				c.yellow(
					`  (${skipped} candidate${skipped === 1 ? "" : "s"} could not be signalled — already gone or insufficient permissions)`,
				),
			);
		}
	}
	return lines.join("\n");
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}
