// `interlinked harness checks` — print the authoritative check inventory.
// Static (no daemon needed): reads counts live from each family's registry via
// `getCheckInventory()`, the single source of truth. The numbers are pinned in
// check-inventory.test.ts, so this surface can never disagree with reality.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { OptionValues } from "commander";
import {
	createCheckHealthAccumulator,
	finalizeCheckHealth,
	foldRecurrenceLine,
} from "../harness/check-health.js";
import { type CheckInventory, getCheckInventory } from "../harness/check-inventory.js";
import { classifyDeterminism } from "../harness/quality-checks.js";
import { recurrencesPath } from "../harness/recurrence.js";
import { header } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";

/** Right-aligned column width for counts (max count is 3 digits today). */
const COUNT_WIDTH = 5;

/** Skip the probation summary when the recurrence log exceeds this size —
 *  `harness checks` must stay fast; the full streaming aggregation lives in
 *  `interlinked harness health`, which this line merely points at. */
const PROBATION_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Count probation-candidate check ids from the recurrence log (the same
 *  fold `interlinked harness health` streams). Returns 0 — i.e. stays
 *  silent — when the log is absent, oversized, or unreadable: the summary
 *  line is a pointer, never an error surface. */
function countProbationCandidates(cwd: string): number {
	try {
		const logPath = recurrencesPath(cwd);
		if (!existsSync(logPath)) return 0;
		if (statSync(logPath).size > PROBATION_LOG_MAX_BYTES) return 0;
		const acc = createCheckHealthAccumulator();
		for (const line of readFileSync(logPath, "utf-8").split("\n")) {
			foldRecurrenceLine(acc, line);
		}
		return finalizeCheckHealth(acc, classifyDeterminism).filter(
			(row) => row.status === "probation-candidate",
		).length;
	} catch {
		return 0; // intentional: unreadable log reads as "no signal", same as absent
	}
}

/** Lazily-computed trailer for the human renders: "" when no check is on
 *  probation (or the log is absent/oversized), one pointer line otherwise. */
function probationSummarySuffix(cwd: string): string {
	const n = countProbationCandidates(cwd);
	if (n === 0) return "";
	return `\n\n  ${n} check(s) on probation — run 'interlinked harness health'`;
}

function row(count: number, label: string): string {
	return `  ${String(count).padStart(COUNT_WIDTH)}  ${label}`;
}

function renderInventory(inv: CheckInventory, withSource: boolean): string {
	const lines = [header("Check inventory")];
	for (const f of inv.families) {
		lines.push(row(f.count, withSource ? `${f.label}  ⟵ ${f.source}` : f.label));
	}
	lines.push(`  ${"─".repeat(COUNT_WIDTH)}`);
	lines.push(row(inv.total, "Total checks"));
	lines.push("");
	lines.push(
		"  Guard rules (PreToolUse command/path gating) are a separate primitive —",
	);
	lines.push("  see `interlinked harness status` or docs/generated/guard-rules.md.");
	return lines.join("\n");
}

export function harnessChecksCommand(opts: OptionValues): void {
	const inv = getCheckInventory();
	output(getOutputMode(opts), inv, {
		json: () => inv,
		short: () => `${inv.total} checks across ${inv.families.length} families`,
		normal: () => renderInventory(inv, false) + probationSummarySuffix(process.cwd()),
		full: () => renderInventory(inv, true) + probationSummarySuffix(process.cwd()),
	});
}
