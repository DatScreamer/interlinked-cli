// ===========================================
// Interlinked Harness — Feedback Effectiveness
// ===========================================
// Tracks whether agents resolve warnings and computes resolution
// statistics. Used to measure how effective harness feedback is
// at driving agent behavior toward fixes (vs. ignoring or suppressing).

import type { FeedbackEffectivenessSummary, SessionTrajectory, WarningRecord } from "./types.js";

/**
 * Record that warnings were issued for specific checks on a file.
 * Called after PostToolUse checks produce warnings.
 */
export function recordWarningsIssued(
	session: SessionTrajectory,
	filePath: string,
	checkNames: string[],
): void {
	for (const checkName of checkNames) {
		const key = `${filePath}::${checkName}`;
		const existing = session.warnings_issued.get(key);

		if (existing) {
			existing.issue_count++;
			existing.last_issued_at = session.tool_call_count;
			existing.resolved = false; // re-opened
		} else {
			const record: WarningRecord = {
				check_name: checkName,
				issue_count: 1,
				first_issued_at: session.tool_call_count,
				last_issued_at: session.tool_call_count,
				resolved: false,
			};
			session.warnings_issued.set(key, record);
		}
	}
}

/**
 * Mark warnings as resolved when the agent re-edits a file and the
 * check no longer fires. Called after PostToolUse checks complete
 * for a file — any previously-issued warning whose check is no
 * longer in the current set is considered resolved.
 */
export function recordWarningResolutions(
	session: SessionTrajectory,
	filePath: string,
	currentCheckNames: Set<string>,
): void {
	const prefix = `${filePath}::`;

	for (const [key, record] of session.warnings_issued) {
		if (!key.startsWith(prefix)) continue;

		const checkName = key.slice(prefix.length);
		if (!currentCheckNames.has(checkName) && !record.resolved) {
			record.resolved = true;
		}
	}
}

/**
 * Compute aggregate effectiveness statistics for the current session.
 * Groups warnings by check name and computes resolution rates.
 */
export function computeEffectivenessSummary(
	session: SessionTrajectory,
): FeedbackEffectivenessSummary {
	// Group by check_name
	const byCheck = new Map<string, { issued: number; resolved: number }>();

	for (const record of session.warnings_issued.values()) {
		const existing = byCheck.get(record.check_name);
		if (existing) {
			existing.issued += record.issue_count;
			existing.resolved += record.resolved ? 1 : 0;
		} else {
			byCheck.set(record.check_name, {
				issued: record.issue_count,
				resolved: record.resolved ? 1 : 0,
			});
		}
	}

	// Build per-check stats
	const perCheck = Array.from(byCheck.entries()).map(([checkName, stats]) => ({
		check_name: checkName,
		times_issued: stats.issued,
		times_resolved: stats.resolved,
		resolution_rate: stats.issued > 0 ? stats.resolved / stats.issued : 0,
	}));

	// Compute overall
	let totalIssued = 0;
	let totalResolved = 0;
	for (const stats of byCheck.values()) {
		totalIssued += stats.issued;
		totalResolved += stats.resolved;
	}

	return {
		per_check: perCheck,
		overall_resolution_rate: totalIssued > 0 ? totalResolved / totalIssued : 0,
		total_issued: totalIssued,
		total_resolved: totalResolved,
	};
}
