// ===========================================
// Experience analyzer — deterministic metrics over trajectory records
// ===========================================
// Pure counting/grouping over a built experience (either format; ix
// annotations unlock the tool/guard/file dimensions). No LLM, no I/O —
// the aggregation stance of `interlinked recurrence` applies here too.

import type { ExperienceRecord, IxAnnotations, IxExperienceRecord } from "./types.js";

export interface ExperienceAnalysis {
	records: number;
	episodes: number;
	span_ms: number | null;
	by_role: Record<string, number>;
	tools: {
		calls: number;
		by_class: Record<string, number>;
		errors: number;
		verification_runs: number;
	};
	files: { edit_events: number; edited: number; reworked: number };
	guard: { blocks: number; warns: number; top_rules: [string, number][] };
	ratios: {
		verify_to_edit: number | null;
		think_to_message_chars: number | null;
	};
}

const EDIT_CLASSES = new Set(["file_edit", "file_write", "notebook_edit"]);

interface Tally {
	byRole: Record<string, number>;
	byClass: Record<string, number>;
	ruleCounts: Map<string, number>;
	editsPerFile: Map<string, number>;
	calls: number;
	errors: number;
	verificationRuns: number;
	editEvents: number;
	blocks: number;
	warns: number;
	thinkChars: number;
	messageChars: number;
	episodes: number;
	firstTs: string | null;
	lastTs: string | null;
}

export function analyzeExperience(records: (ExperienceRecord | IxExperienceRecord)[]): ExperienceAnalysis {
	const tally = emptyTally();
	for (const record of records) {
		if (record.role === "meta") continue;
		foldRecord(tally, record);
	}
	return finalize(tally);
}

function emptyTally(): Tally {
	return {
		byRole: {},
		byClass: {},
		ruleCounts: new Map(),
		editsPerFile: new Map(),
		calls: 0,
		errors: 0,
		verificationRuns: 0,
		editEvents: 0,
		blocks: 0,
		warns: 0,
		thinkChars: 0,
		messageChars: 0,
		episodes: 0,
		firstTs: null,
		lastTs: null,
	};
}

function foldRecord(
	tally: Tally,
	record: Exclude<ExperienceRecord | IxExperienceRecord, { role: "meta" }>,
): void {
	tally.byRole[record.role] = (tally.byRole[record.role] ?? 0) + 1;
	if (tally.firstTs === null) tally.firstTs = record.timestamp;
	tally.lastTs = record.timestamp;
	foldText(tally, record);

	const ix: IxAnnotations | undefined = "ix" in record ? record.ix : undefined;
	if (ix?.episode !== undefined) tally.episodes = Math.max(tally.episodes, ix.episode + 1);
	if (record.role === "assistant" && record.tool_calls !== undefined) {
		foldCall(tally, ix);
	}
	if (ix?.outcome === "error") tally.errors++;
}

function foldText(
	tally: Tally,
	record: Exclude<ExperienceRecord | IxExperienceRecord, { role: "meta" }>,
): void {
	if (record.role === "reasoning") tally.thinkChars += record.content.length;
	if (record.role === "assistant" && typeof record.content === "string") {
		tally.messageChars += record.content.length;
	}
}

function foldCall(tally: Tally, ix: IxAnnotations | undefined): void {
	tally.calls++;
	const toolClass = ix?.tool_class ?? "unknown";
	tally.byClass[toolClass] = (tally.byClass[toolClass] ?? 0) + 1;
	if (ix?.is_verification) tally.verificationRuns++;
	if (EDIT_CLASSES.has(toolClass)) {
		tally.editEvents++;
		if (ix?.file !== undefined) {
			tally.editsPerFile.set(ix.file, (tally.editsPerFile.get(ix.file) ?? 0) + 1);
		}
	}
	if (ix?.guard?.decision === "block") {
		tally.blocks++;
		foldRule(tally, ix.guard.rule_id);
	}
	if (ix?.guard?.decision === "warn") tally.warns++;
}

function foldRule(tally: Tally, ruleId: string | null): void {
	const key = ruleId ?? "(unknown rule)";
	tally.ruleCounts.set(key, (tally.ruleCounts.get(key) ?? 0) + 1);
}

function finalize(tally: Tally): ExperienceAnalysis {
	let reworked = 0;
	for (const count of tally.editsPerFile.values()) if (count >= 2) reworked++;
	const topRules = [...tally.ruleCounts.entries()].sort(
		(a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
	);
	const spanMs =
		tally.firstTs !== null && tally.lastTs !== null
			? Date.parse(tally.lastTs) - Date.parse(tally.firstTs)
			: null;
	return {
		records: Object.values(tally.byRole).reduce((a, b) => a + b, 0),
		episodes: tally.episodes,
		span_ms: spanMs !== null && Number.isFinite(spanMs) ? spanMs : null,
		by_role: tally.byRole,
		tools: {
			calls: tally.calls,
			by_class: tally.byClass,
			errors: tally.errors,
			verification_runs: tally.verificationRuns,
		},
		files: {
			edit_events: tally.editEvents,
			edited: tally.editsPerFile.size,
			reworked,
		},
		guard: { blocks: tally.blocks, warns: tally.warns, top_rules: topRules },
		ratios: {
			verify_to_edit: tally.editEvents > 0 ? tally.verificationRuns / tally.editEvents : null,
			think_to_message_chars:
				tally.messageChars > 0 ? tally.thinkChars / tally.messageChars : null,
		},
	};
}
