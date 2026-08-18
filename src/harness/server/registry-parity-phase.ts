// ===========================================
// Registry-parity PostToolUse phase
// ===========================================
// Runs the config-driven registry-parity detector (src/harness/registry-parity.ts)
// scoped to just the pair(s) whose LEFT or RIGHT file this edit touched — not a
// project-wide sweep. Same role at the per-edit surface that streamRegistryParity
// already plays at `interlinked verify`: both call the same detector, this one
// just narrows to the pair(s) relevant to the file just written so a drifted
// pair is visible the moment it drifts, not only at the next full verify run.
//
// Non-blocking guidance, same shape as runSpecLedgerPhase: mutates
// decision.warnings / acc.allCheckResults in place, never throws — a
// malformed config degrades to one logged warning rather than failing the
// edit that triggered it.

import { relative } from "node:path";
import {
	checkRegistryParity,
	loadRegistryParityConfig,
	type RegistryDriftFinding,
	type RegistryPair,
} from "../registry-parity.js";
import type { HarnessDecision } from "../types.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Max drift warnings surfaced per edit — matches spec-ledger-phase's cap;
 *  any remainder still surfaces at `interlinked verify`. */
const MAX_WARNINGS_PER_EVENT = 5;

/** repo-relative, forward-slash path so it compares equal to a config
 *  `file` value regardless of platform path separator (spec-ledger-phase
 *  applies the same normalization for the same reason). */
function toRelPosix(cwd: string, absPath: string): string {
	return relative(cwd, absPath).split("\\").join("/");
}

/** Pairs whose LEFT or RIGHT file is the edited file. */
function touchedPairs(pairs: readonly RegistryPair[], rel: string): RegistryPair[] {
	return pairs.filter((p) => p.left.file === rel || p.right.file === rel);
}

/**
 * When the edited file is the LEFT or RIGHT side of a configured
 * registry-parity pair, re-run drift detection scoped to just that pair and
 * warn on any drift it finds. No-op when `.interlinked/registry-parity.json`
 * is absent, declares no pairs, or declares no pair touching this file — the
 * common case pays one `existsSync` and returns. Consumed by
 * runPerFileChecks in post-tool-file-checks.ts.
 */
export function runRegistryParityPhase(
	ctx: ServerRuntime,
	editedFilePath: string,
	editedFileInRepo: boolean,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	if (!editedFilePath || !editedFileInRepo) return;
	try {
		const config = loadRegistryParityConfig(ctx.cwd);
		if (!config || config.pairs.length === 0) return;

		const rel = toRelPosix(ctx.cwd, editedFilePath);
		const pairs = touchedPairs(config.pairs, rel);
		if (pairs.length === 0) return;

		const findings = checkRegistryParity({ pairs }, ctx.cwd);
		if (findings.length === 0) return;

		recordFindings(findings, decision, acc);
	} catch (err) {
		ctx.log(
			`Registry-parity phase error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function recordFindings(
	findings: RegistryDriftFinding[],
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	acc.checksRan.push("registry_parity");
	if (!decision.warnings) decision.warnings = [];
	for (const f of findings.slice(0, MAX_WARNINGS_PER_EVENT)) {
		decision.warnings.push(`[interlinked:registry-parity][proven] ${f.message}`);
		acc.allCheckResults.push({
			source: "registry_parity",
			name: "registry_parity",
			severity: "warning",
			message: f.message,
			file: f.source_file,
			determinism: "fully_deterministic",
		});
	}
	if (findings.length > MAX_WARNINGS_PER_EVENT) {
		decision.warnings.push(
			`[interlinked:registry-parity] …and ${findings.length - MAX_WARNINGS_PER_EVENT} more drifted id(s); see \`interlinked verify\`.`,
		);
	}
}
