// Stop-event deterministic pattern rescan.
//
// On every Stop event the harness walks `session.files_written` and re-runs
// the inline detector suite against the CURRENT contents of each file.
// Findings that remain in the file at end-of-turn are surfaced as warnings;
// the `// interlinked: defer <check-id>` (and `# interlinked: defer ...`)
// markers carve out an acknowledgment escape hatch so the agent can mark
// a finding "saw it, intentionally not fixing this turn" without
// scope-creep refactor pressure.
//
// This complements the PostToolUse pipeline (which catches new findings as
// they're written) by catching findings that *persist* into a completed
// turn. It is deterministic — no LLM call — per
// `[[feedback_harness_deterministic_only]]`. Per
// `[[feedback_recurring_warnings_amplify_not_silence]]` the rescan does not
// dedup repeats: every Stop with unaddressed findings re-surfaces them, so
// the signal stays loud until the agent fixes or defers.

import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { buildAgentSafetyChecks } from "./check-registry/index.js";
import { scanInlineDeferrals } from "./suppressions.js";
import type { SessionTrajectory } from "./types.js";

/** One detector hit from the rescan, paired with deferral state. */
export interface PatternRescanFinding {
	/** Working-tree-relative path. */
	file: string;
	/** Check id (e.g. `ubs_pickle_untrusted_load`). */
	checkId: string;
	/** 1-based line number in the current file. */
	line: number;
	/** Trimmed match text (≤150 chars). */
	text: string;
	/** True when the line carries an `interlinked: defer <checkId>` marker. */
	deferred: boolean;
	/** Operator-supplied justification when present, else null. */
	deferReason: string | null;
}

/**
 * Re-run the inline detector suite against the current contents of every
 * file in `session.files_written`. Returns one finding per (file, line,
 * check) tuple, annotated with whether the agent has marked that line as
 * acknowledged-deferred. Best-effort: a file that was deleted between the
 * last write and the rescan is silently skipped, and an individual buggy
 * detector cannot break the whole scan.
 */
export function rescanSessionFiles(
	session: SessionTrajectory,
	cwd: string,
): PatternRescanFinding[] {
	const cwdResolved = resolve(cwd);
	const findings: PatternRescanFinding[] = [];
	const seen = new Set<string>();

	for (const rawPath of session.files_written) {
		// `session.files_written` stores both the path the tool reported and
		// its absolute resolution (see `session-state.ts`). Canonicalise so
		// the same file scanned via two paths produces one set of findings.
		const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwdResolved, rawPath);
		if (seen.has(absPath)) continue;
		seen.add(absPath);
		appendFileFindings(absPath, cwdResolved, findings);
	}

	return findings;
}

/** Read one file, run all detectors, append findings (annotated with
 *  deferral state) to the shared accumulator. Pulled out of
 *  `rescanSessionFiles` to keep nesting at two levels — the outer loop
 *  walks files, this helper walks checks-and-matches. */
function appendFileFindings(
	absPath: string,
	cwdResolved: string,
	out: PatternRescanFinding[],
): void {
	let content: string;
	try {
		content = readFileSync(absPath, "utf-8");
	} catch (_err) {
		// File deleted, permission denied, raced — skip silently. The
		// harness must never block end-of-turn cleanup on a stat error.
		return;
	}

	const relPath = relative(cwdResolved, absPath) || absPath;
	const deferrals = scanInlineDeferrals(content);
	for (const check of buildAgentSafetyChecks(content, relPath)) {
		let matches: Array<{ line: number; text: string }>;
		try {
			matches = check.fn();
		} catch (_err) {
			continue;
		}
		annotateMatches({ matches, checkId: check.name, relPath, deferrals, out });
	}
}

interface AnnotateMatchesArgs {
	matches: ReadonlyArray<{ line: number; text: string }>;
	checkId: string;
	relPath: string;
	deferrals: ReturnType<typeof scanInlineDeferrals>;
	out: PatternRescanFinding[];
}

/** Annotate raw detector matches with deferral state and push them onto
 *  the accumulator. Extracted so the per-check loop body stays a single
 *  call instead of an inline for-loop. */
function annotateMatches(args: AnnotateMatchesArgs): void {
	const { matches, checkId, relPath, deferrals, out } = args;
	for (const m of matches) {
		const lineDeferrals = deferrals.get(m.line);
		const deferred = lineDeferrals?.has(checkId) ?? false;
		const deferReason = lineDeferrals?.get(checkId) ?? null;
		out.push({
			file: relPath,
			checkId,
			line: m.line,
			text: m.text,
			deferred,
			deferReason,
		});
	}
}

/**
 * Format the rescan output into stderr-style warning strings. Returns one
 * warning per (file, status) pair — unaddressed findings group separately
 * from acknowledged-deferred findings so the agent reads a clean split.
 * Caller is responsible for deciding whether to surface them; the rescan
 * itself never blocks.
 */
export function buildPatternRescanWarnings(
	session: SessionTrajectory,
	cwd: string,
): string[] {
	const findings = rescanSessionFiles(session, cwd);
	if (findings.length === 0) return [];

	const byFile = new Map<string, PatternRescanFinding[]>();
	for (const f of findings) {
		let list = byFile.get(f.file);
		if (!list) {
			list = [];
			byFile.set(f.file, list);
		}
		list.push(f);
	}

	const warnings: string[] = [];
	for (const [file, fileFindings] of byFile) {
		const unaddressed = fileFindings.filter((f) => !f.deferred);
		const deferred = fileFindings.filter((f) => f.deferred);

		if (unaddressed.length > 0) {
			const list = unaddressed
				.map((f) => `  ${f.checkId}:${f.line} — ${f.text}`)
				.join("\n");
			// Provenance honesty: this is a WHOLE-FILE scan of files the session
			// touched, so findings may predate the agent's edits. The old wording
			// ("you wrote or touched this turn") read as an authorship claim — a
			// live report (2026-07-28) showed an agent spending its final message
			// disclaiming findings its one-line edit never introduced. Repo policy
			// still asks for touched files to be left clean
			// ([[feedback_fix_pre_existing_in_touched_files]]); the message now
			// states which claim it is actually making.
			warnings.push(
				`[interlinked:stop-rescan] ${file} — ${unaddressed.length} open finding(s) in this file you touched this turn (whole-file scan; some may predate your edits):\n${list}\nFix them (repo policy: leave touched files clean), or add \`// interlinked: defer <check-id> -- <reason>\` (or \`# ...\` in Python) to each line to acknowledge.`,
			);
		}
		if (deferred.length > 0) {
			const list = deferred
				.map((f) => `  ${f.checkId}:${f.line}${f.deferReason ? ` — ${f.deferReason}` : ""}`)
				.join("\n");
			warnings.push(
				`[interlinked:stop-rescan] ${file} has ${deferred.length} acknowledged-deferred finding(s) (logged, not escalated):\n${list}`,
			);
		}
	}
	return warnings;
}
