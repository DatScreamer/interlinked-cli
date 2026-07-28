// ===========================================
// PostToolUse — claiming mutation results the PreToolUse window could not wait for
// ===========================================
// The per-edit budget is a deadline, not a measure of the work. A run that hit
// the deadline is still computing, and the runner retains its report. This phase
// claims those reports after the write and turns them into findings.
//
// It cannot block — the bytes are on disk by now. What it buys is TIME: roughly
// double the mutation work per edit, reported in the same turn the agent made
// it, instead of thrown away at the deadline.
//
// Three properties this phase must hold:
//   * NEVER THROWS. It runs after a tool call already succeeded.
//   * NEVER BLOCKS. It only appends warnings.
//   * NEVER MISATTRIBUTES. Results are matched to the bytes actually on disk;
//     a mismatch is a miss, never a report against the wrong text.

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isFileWrite } from "../evaluator/tool-classifiers.js";
import {
	DEFAULT_HARVEST_BUDGET_MS,
	formatHarvestWarning,
	type HarvestFetch,
	harvestPending,
} from "../mutation/harvest.js";
import { overlayHash, pendingRegistry } from "../mutation/pending-registry.js";
import { type PendingStore, takePending } from "../mutation/pending-runs.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Seams for tests: real disk and real network by default. */
export interface HarvestDeps {
	readDisk?: (absPath: string) => string | null;
	fetchImpl?: HarvestFetch;
	now?: () => number;
	/** Injected so polling tests need no real time. */
	sleep?: (ms: number) => Promise<void>;
}

function readDiskSafe(absPath: string): string | null {
	try {
		return readFileSync(absPath, "utf8");
	} catch {
		// A file that vanished between the write and this phase simply has no
		// current bytes to correlate against — treated as a miss below.
		return null;
	}
}

/** The repo-relative path this event wrote, or null when it wrote no file. */
function writtenFile(event: HarnessEvent, cwd: string): string | null {
	if (!isFileWrite(event.tool_name ?? "")) return null;
	const input = (event.tool_input ?? {}) as { file_path?: unknown; path?: unknown };
	const fromFilePath = typeof input.file_path === "string" ? input.file_path : "";
	const named = fromFilePath !== "" ? fromFilePath : typeof input.path === "string" ? input.path : "";
	if (named === "") return null;
	return relative(cwd, resolve(cwd, named));
}

/** Hash of what is on disk NOW — the bytes the agent actually left behind. */
function currentHash(cwd: string, file: string, deps: HarvestDeps): string {
	const read = deps.readDisk ?? readDiskSafe;
	const content = read(resolve(cwd, file));
	return content === null ? "" : overlayHash(content);
}

/**
 * Explain a pending run that exists for this file but did not match what landed.
 *
 * This is the anti-misattribution guard firing, and it must NOT look like
 * "nothing was pending": either the bytes changed between measurement and
 * landing, or the two windows disagree about the key. Silence here hid a live
 * key-format bug (absolute vs repo-relative) for an entire session.
 */
function unmatchedPendingWarning(store: PendingStore, file: string, hash: string): string | null {
	const orphans = store.runs.filter((r) => r.file === file);
	if (orphans.length === 0) return null;
	return `[interlinked:mutation] ${file}: ${orphans.length} pending run(s) could not be matched to what landed (measured ${orphans[0]?.overlayHash}, on disk ${hash || "unreadable"}) \u2014 not measured.`;
}

/**
 * Append a survivor warning for any run that finished after the earlier window.
 *
 * Silent in every uninteresting case — feature off, nothing pending, nothing
 * survived, runner unreachable. A per-edit phase that speaks every time trains
 * the reader to stop looking.
 */
export async function appendMutationHarvestWarning(
	ctx: ServerRuntime,
	event: HarnessEvent,
	decision: HarnessDecision,
	deps: HarvestDeps = {},
): Promise<void> {
	const cfg = ctx.rules.per_edit_mutation;
	if (!cfg?.enabled) return; // fast path: default OFF

	const file = writtenFile(event, ctx.cwd);
	if (file === null) return;

	const now = deps.now ? deps.now() : Date.now();
	const store = pendingRegistry(now);
	const hash = currentHash(ctx.cwd, file, deps);
	const claimed = takePending(store, file, hash, now);
	if (claimed.length === 0) {
		const unmatched = unmatchedPendingWarning(store, file, hash);
		if (unmatched) decision.warnings = [...(decision.warnings ?? []), unmatched];
		return;
	}

	const fetchImpl = deps.fetchImpl ?? ((url: string) => fetch(url) as never);
	// harvestPending is contractually non-throwing; this phase depends on that
	// rather than re-wrapping it, so a regression there surfaces in its own tests.
	//
	// The budget is what makes this a real second WINDOW rather than one hopeful
	// poll: the run that outlived PreToolUse still needs seconds, and PostToolUse
	// fires milliseconds after the write. An unreachable runner returns at once
	// regardless, so the budget is only ever spent on work that is still coming.
	const result = await harvestPending(claimed, fetchImpl, {
		budgetMs: cfg.harvest_budget_ms ?? DEFAULT_HARVEST_BUDGET_MS,
		...(deps.now ? { now: deps.now } : {}),
		...(deps.sleep ? { sleep: deps.sleep } : {}),
	});
	const warning = formatHarvestWarning(file, result.survivors);
	if (warning) {
		decision.warnings = [...(decision.warnings ?? []), warning];
		return;
	}
	// A claimed-but-empty harvest is NOT the same as nothing having happened, and
	// staying silent about it made the whole path unobservable: a run that was
	// claimed, waited for, and came back with no findings looked identical to a
	// run that never correlated at all. Say which it was — measured-clean is a
	// result the agent should be able to see it earned.
	decision.warnings = [
		...(decision.warnings ?? []),
		result.harvested > 0
			? `[interlinked:mutation] ${file}: measured clean in the second window (${result.harvested}/${claimed.length} shard(s) reported, no survivors).`
			: `[interlinked:mutation] ${file}: ${claimed.length} pending mutation run(s) did not report back within the harvest budget — not measured.`,
	];
}
