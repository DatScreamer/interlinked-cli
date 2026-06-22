// interlinked doctor — thinking-capture health probe.
//
// Guards the regression that motivated the live-capture port: the active
// hook-entry → daemon path silently stopped attaching reasoning traces to
// tool_use_start records (the self-contained .mjs hook captured them; the thin
// path never replicated it), and nobody noticed for weeks. This probe makes that
// outage class visible in `interlinked doctor`: if the recent tool calls carry
// no reasoning at all, capture has probably gone dark again.
//
// Reads activity.jsonl DIRECTLY (the legacy mirror that carries `thinking`),
// not the merged readLocalActivity view — its collection.jsonl twin wins dedup
// and never carries thinking, which would make every record look unthinking.

import { existsSync } from "node:fs";
import { readRecentLines } from "../lib/local-activity-collection.js";
import { getActivityPath } from "../lib/local-activity-paths.js";
import type { CheckResult } from "./doctor-checks.js";

/** Newest tool_use_start records to inspect. */
const SAMPLE = 25;
/** Below this many recent tool calls there isn't enough signal to call an outage. */
const MIN_SIGNAL = 5;

/**
 * Health row for live reasoning-trace capture. Inspects the newest `SAMPLE`
 * `tool_use_start` records in activity.jsonl and warns when NONE carry a
 * `thinking` field over a meaningful sample — the signature of the capture path
 * regressing. Pass otherwise (and when there's too little data to judge).
 * Fail-open: any read error degrades to a warn, never throws.
 */
export function thinkingCaptureCheck(cwd: string): CheckResult {
	const name = "Thinking capture";
	const path = getActivityPath(cwd);
	if (!existsSync(path)) {
		return { name, status: "pass", message: "no activity log yet -- nothing to assess" };
	}

	const starts: Array<{ thinking?: unknown }> = [];
	try {
		// Newest-first; scan a generous line budget so lifecycle/tool_use records
		// interleaved with tool_use_start don't starve the sample.
		for (const line of readRecentLines(path, SAMPLE * 60)) {
			if (starts.length >= SAMPLE) break;
			try {
				const rec = JSON.parse(line) as { type?: string; thinking?: unknown };
				if (rec.type === "tool_use_start") starts.push(rec);
			} catch (e) {
				void e; // skip malformed line
			}
		}
	} catch (e) {
		void e;
		return { name, status: "warn", message: "could not read activity log to assess capture health" };
	}

	if (starts.length === 0) {
		return { name, status: "pass", message: "no tool calls recorded yet -- nothing to assess" };
	}

	const withThinking = starts.filter(
		(r) => typeof r.thinking === "string" && r.thinking.trim().length > 0,
	).length;

	if (withThinking === 0 && starts.length >= MIN_SIGNAL) {
		return {
			name,
			status: "warn",
			message: `0 of the last ${starts.length} tool calls carry reasoning traces -- the hook->daemon capture path may have regressed. If extended thinking is off for your model, ignore.`,
		};
	}

	return {
		name,
		status: "pass",
		message: `${withThinking}/${starts.length} recent tool calls carry reasoning traces`,
	};
}
