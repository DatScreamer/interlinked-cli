// `interlinked harness checks` — print the authoritative check inventory.
// Static (no daemon needed): reads counts live from each family's registry via
// `getCheckInventory()`, the single source of truth. The numbers are pinned in
// check-inventory.test.ts, so this surface can never disagree with reality.

import type { OptionValues } from "commander";
import { type CheckInventory, getCheckInventory } from "../harness/check-inventory.js";
import { header } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";

/** Right-aligned column width for counts (max count is 3 digits today). */
const COUNT_WIDTH = 5;

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
		normal: () => renderInventory(inv, false),
		full: () => renderInventory(inv, true),
	});
}
