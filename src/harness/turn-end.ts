// ===========================================
// Session Turn End Handler
// ===========================================
// Produces a trajectory-level summary at the end of an agent turn,
// detecting cross-tool-call patterns that individual PreToolUse/PostToolUse
// checks cannot see.

import type { SessionTrajectory, TurnEndSummary } from "./types.js";

// ===========================================
// Turn Patterns
// ===========================================

/** Detect trajectory-level patterns across a full turn */
export function detectTurnPatterns(session: SessionTrajectory): string[] {
	const patterns: string[] = [];

	// Edit-without-test: agent edited source files but never ran tests
	if (hasEditsWithoutTests(session)) {
		patterns.push("edit-without-test");
	}

	// Repeated-failure: same file failed checks multiple times
	if (hasRepeatedFailures(session)) {
		patterns.push("repeated-failure");
	}

	// Read-then-reread: agent read files it already read (wasted context)
	if (hasRedundantReads(session)) {
		patterns.push("redundant-reread");
	}

	// Write-without-read: agent wrote to files it never read first
	if (hasWriteWithoutRead(session)) {
		patterns.push("write-without-read");
	}

	// Thrashing: alternating edits to same file (>3 edits to same file)
	if (hasThrashing(session)) {
		patterns.push("file-thrashing");
	}

	return patterns;
}

function hasEditsWithoutTests(session: SessionTrajectory): boolean {
	if (session.files_written.size === 0) return false;
	const hasSourceEdits = [...session.files_written].some(
		(f) => /\.(tsx?|jsx?|py|rs|go)$/.test(f) && !/\.(test|spec)\.\w+$/.test(f),
	);
	if (!hasSourceEdits) return false;
	const hasTestRun = session.commands_run.some((cmd) =>
		/\b(vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+test)\b/.test(cmd),
	);
	return !hasTestRun;
}

function hasRepeatedFailures(session: SessionTrajectory): boolean {
	for (const entry of session.failed_files.values()) {
		if (entry.failure_count >= 3) return true;
	}
	return false;
}

function hasRedundantReads(session: SessionTrajectory): boolean {
	let redundantCount = 0;
	for (const [_file, readAt] of session.file_read_at) {
		if (readAt < session.tool_call_count - 5) {
			redundantCount++;
		}
	}
	return redundantCount >= 3;
}

function hasWriteWithoutRead(session: SessionTrajectory): boolean {
	for (const file of session.files_written) {
		if (!session.files_read.has(file) && !/\.(test|spec)\.\w+$/.test(file)) {
			return true;
		}
	}
	return false;
}

function hasThrashing(session: SessionTrajectory): boolean {
	const editCounts = new Map<string, number>();
	for (const entry of session.tool_sequence) {
		if (!entry.startsWith("Edit:") && !entry.startsWith("Write:")) continue;
		const file = entry.split(":").slice(1).join(":");
		editCounts.set(file, (editCounts.get(file) || 0) + 1);
	}
	for (const count of editCounts.values()) {
		if (count > 3) return true;
	}
	return false;
}

// ===========================================
// Turn End Summary Builder
// ===========================================

/** Build a summary of the agent's turn for logging and analysis */
export function buildTurnEndSummary(
	session: SessionTrajectory,
	blockCount: number,
	warningCount: number,
): TurnEndSummary {
	const startTime = new Date(session.started_at).getTime();
	const turnPatterns = detectTurnPatterns(session);

	return {
		session_id: session.session_id,
		agent_name: session.agent_name,
		tool_call_count: session.tool_call_count,
		files_written: [...session.files_written],
		files_read: [...session.files_read],
		commands_run: [...session.commands_run],
		warning_count: warningCount,
		block_count: blockCount,
		turn_patterns: turnPatterns,
		sensitivity_level: session.sensitivity_level,
		turn_duration_ms: Date.now() - startTime,
	};
}

/** Format turn-end warnings from detected patterns */
export function formatTurnEndWarnings(summary: TurnEndSummary): string[] {
	const warnings: string[] = [];

	for (const pattern of summary.turn_patterns) {
		switch (pattern) {
			case "edit-without-test":
				warnings.push(
					`[interlinked:turn-end] You edited ${summary.files_written.length} source file(s) but didn't run tests. Consider running the test suite before finishing.`,
				);
				break;
			case "repeated-failure":
				warnings.push(
					"[interlinked:turn-end] Multiple files failed checks repeatedly this session. Step back and re-read the failing files before making more edits.",
				);
				break;
			case "redundant-reread":
				warnings.push(
					"[interlinked:turn-end] Several files were re-read without changes. Use the information from the first read — re-reading wastes context.",
				);
				break;
			case "write-without-read":
				// Cut: this advisory burned context on every legitimate
				// new-file creation, template scaffolding, and apply-patch
				// flow. Claude Code already enforces read-before-edit at the
				// Edit-tool level (the tool errors without a prior Read);
				// duplicating that as a turn-end heuristic produced more
				// noise than signal. If a repo wants the advisory back, it
				// should be opt-in via guard-rules.local.json with explicit
				// scoping — not on by default.
				break;
			case "file-thrashing":
				warnings.push(
					"[interlinked:turn-end] A file was edited 4+ times this session. Plan your changes before editing — frequent small edits waste tool calls.",
				);
				break;
		}
	}

	return warnings;
}
