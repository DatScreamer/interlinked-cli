// `interlinked harness health` — check-health governance report (Tricorder-
// style demotion signal, v1 log-derived). Streams .interlinked/recurrences.jsonl
// line-by-line (40k+ rows in production — never materialized as one array),
// folds per-check-id stats, and flags heuristic checks whose findings re-fire
// without changing as probation candidates for demotion (default → advisory)
// or detection refinement. The UP direction lives in `interlinked recurrence
// propose`; this is the DOWN direction.

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { OptionValues } from "commander";
import {
	type CheckHealthRow,
	createCheckHealthAccumulator,
	finalizeCheckHealth,
	foldRecurrenceLine,
} from "../harness/check-health.js";
import { classifyDeterminism } from "../harness/quality-checks.js";
import { recurrencesPath } from "../harness/recurrence.js";
import { c, header, table } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** Normal mode shows the worst offenders; --full shows every check id. */
const NORMAL_MODE_ROW_LIMIT = 25;

export async function harnessHealthCommand(opts: OptionValues): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const logPath = recurrencesPath(cwd);
		if (!existsSync(logPath)) {
			output(
				mode,
				{ checks: [], probation_candidates: 0 },
				{
					json: () => ({ checks: [], probation_candidates: 0 }),
					normal: () =>
						c.dim(`No recurrence log at ${logPath} — nothing to grade yet.`),
				},
			);
			return;
		}

		const rows = await aggregateHealthFromLog(logPath);
		const candidates = rows.filter((r) => r.status === "probation-candidate");
		const result = { checks: rows, probation_candidates: candidates.length };

		output(mode, result, {
			json: () => result,
			short: () =>
				`${rows.length} check ids graded, ${candidates.length} probation candidate(s)`,
			normal: () => renderHealthReport(rows, candidates, NORMAL_MODE_ROW_LIMIT),
			full: () => renderHealthReport(rows, candidates, rows.length),
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

/** Line-by-line fold over the JSONL — lazy by construction. Torn lines are
 *  skipped inside foldRecurrenceLine (same tolerance as loadRecurrenceEvents). */
async function aggregateHealthFromLog(logPath: string): Promise<CheckHealthRow[]> {
	const acc = createCheckHealthAccumulator();
	const rl = createInterface({
		input: createReadStream(logPath, { encoding: "utf-8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		foldRecurrenceLine(acc, line);
	}
	return finalizeCheckHealth(acc, classifyDeterminism);
}

function renderHealthReport(
	rows: CheckHealthRow[],
	candidates: CheckHealthRow[],
	limit: number,
): string {
	const lines: string[] = [header("Check health (repeat-rate = events per unique finding)")];
	const shown = rows.slice(0, limit);
	lines.push(
		table(
			["check id", "status", "repeat", "events", "unique", "sessions", "determinism"],
			shown.map((r) => [
				r.check_id,
				statusCell(r.status),
				r.repeat_rate.toFixed(1),
				String(r.events),
				String(r.unique_findings),
				String(r.sessions),
				r.determinism ?? "unknown",
			]),
		),
	);
	if (rows.length > shown.length) {
		lines.push(c.dim(`  … ${rows.length - shown.length} more (use --full)`));
	}
	lines.push("");
	lines.push(...renderProbationSection(candidates));
	return lines.join("\n");
}

function statusCell(status: CheckHealthRow["status"]): string {
	if (status === "probation-candidate") return c.red("PROBATION");
	if (status === "low-data") return c.dim("low-data");
	return c.green("healthy");
}

function renderProbationSection(candidates: CheckHealthRow[]): string[] {
	if (candidates.length === 0) {
		return [c.dim("No probation candidates — every graded check is healthy or low-data.")];
	}
	const lines = [
		c.bold(`Probation candidates (${candidates.length}) — demote to advisory or refine detection:`),
	];
	for (const r of candidates) {
		lines.push(`  ${c.red("●")} ${r.check_id} — ${r.why}`);
	}
	lines.push(
		c.dim(
			"  Same finding re-firing unchanged = likely FP noise or an ignored advisory. " +
				"Prefer refining the check over demoting (see CLAUDE.md verify policy).",
		),
	);
	return lines;
}
