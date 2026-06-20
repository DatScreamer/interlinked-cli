// ===========================================
// Phase 1 Channel 5 — Rollback feasibility
// ===========================================
// When a tool failure leaves the working tree in an inconsistent state,
// surface a one-call rollback option. We do NOT execute the rollback; we
// only return the safe argv for the agent / user to inspect and run.
//
// Safety contract (load-bearing — see design doc §2.2 Channel 5):
//   1. No shell-string interpolation. Use execFileSync with argv form,
//      never exec(string). Filenames cannot become shell metacharacters.
//   2. `--` to terminate option parsing. A filename like `--all` would
//      otherwise reconfigure git's behavior silently.
//   3. `--porcelain -z` for machine-parseable output. Null-delimited entries;
//      whitespace and unusual filenames don't break parsing.
//   4. Provenance gate. Only suggest rollback when we have evidence WE
//      caused the change — otherwise we'd offer to wipe the user's own
//      in-progress work. The provenance check is provided by the caller
//      (Phase 1 reads session.files_written; Phase 2 walks the receipt log).
//   5. Returned command is argv, not a shell string. Callers stringify for
//      display only; they never `eval` it.
//
// The argv shape (`["git", "checkout", "--", "<path>"]` etc.) is the
// contract. Tests in __tests__/rollback-feasibility.test.ts pin the
// adversarial-filename behavior (filenames like `--all`, ` -- `, paths
// with newlines, paths with shell metacharacters) so a regression here
// can't silently introduce a shell-injection surface.

import { execFileSync } from "node:child_process";

import type { RollbackAssessment } from "../types.js";
import { nonNull } from "../../lib/non-null.js";

/** Public API — Channel 5 entry point. The harness handler calls this once
 *  per file-edit failure with a provenance check that returns true iff WE
 *  wrote this file successfully earlier in the session. */
export function assessRollbackFeasibility(
	filePath: string,
	cwd: string,
	provenanceCheck: (path: string) => boolean,
): RollbackAssessment {
	const causedByUs = provenanceCheck(filePath);

	let porcelain: string;
	try {
		porcelain = execFileSync(
			"git",
			["status", "--porcelain", "-z", "--", filePath],
			{ cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch {
		return {
			safe: false,
			reason: "git status failed (likely not a git repository)",
			caused_by_us: causedByUs,
		};
	}

	const entries = porcelain.split("\0").filter((e) => e.length > 0);
	if (entries.length === 0) {
		return {
			safe: false,
			reason: "no working-tree change to roll back",
			caused_by_us: causedByUs,
		};
	}

	// Porcelain entry: 2 status bytes, a space, then the path. Renames may
	// produce trailing entries which we don't try to roll back.
	const first = entries[0];
	if (nonNull(first).length < 3) {
		return {
			safe: false,
			reason: "unparseable git status entry",
			caused_by_us: causedByUs,
		};
	}
	const statusBytes = nonNull(first).slice(0, 2);
	const isUntracked = statusBytes === "??";
	const isAddedToIndex = statusBytes[0] === "A";
	const isModifiedToIndex = statusBytes[0] === "M";
	const isDeletedToIndex = statusBytes[0] === "D";
	const isRenamed = statusBytes[0] === "R";
	const isModifiedInWorkingTree = statusBytes[1] === "M";
	const isDeletedInWorkingTree = statusBytes[1] === "D";

	if (!causedByUs) {
		return {
			safe: false,
			reason: "no provenance evidence Interlinked caused this change; refusing to recommend rollback",
			caused_by_us: false,
		};
	}

	// Untracked file we created: safe to remove. The argv shape is the
	// safety contract — caller never `eval`s the joined string; if they
	// pass the argv to a child_process or to a shell that splits it
	// element-wise, no filename can become a shell metacharacter (the `--`
	// terminates option parsing on the binary side).
	if (isUntracked) {
		return {
			safe: true,
			command: ["rm", "--", filePath],
			reason: "untracked file created by Interlinked; safe to remove",
			caused_by_us: true,
		};
	}

	// Tracked file with unstaged modification only: `git checkout -- <path>`
	// reverts working-tree changes.
	if (
		!isAddedToIndex &&
		!isModifiedToIndex &&
		!isDeletedToIndex &&
		!isRenamed &&
		(isModifiedInWorkingTree || isDeletedInWorkingTree)
	) {
		return {
			safe: true,
			command: ["git", "checkout", "--", filePath],
			reason: "tracked file with unstaged change caused by Interlinked",
			caused_by_us: true,
		};
	}

	// Mixed staged + unstaged or rename: refuse — the agent should review.
	return {
		safe: false,
		reason: "complex git state (staged + unstaged or rename); manual review needed",
		caused_by_us: true,
	};
}

/** Public API — format a RollbackAssessment as a single human-readable line
 *  for inclusion in warnings[]. Returns null when the assessment isn't
 *  actionable. The displayed string is for HUMAN inspection; argv-aware
 *  callers should use `assessment.command` directly. Each argv segment is
 *  POSIX-shell-quoted so paths with whitespace or metacharacters render
 *  unambiguously when copy-pasted. */
export function formatRollbackLine(assessment: RollbackAssessment): string | null {
	if (!assessment.safe || !assessment.command) return null;
	const cmd = assessment.command.map(posixShellQuote).join(" ");
	return `[interlinked:rollback] ${assessment.reason}\nTo revert: \`${cmd}\``;
}

/** POSIX shell-quote a single argv element. Returns the element unchanged when
 *  it's safe (alphanumerics + a small allow-list of unreserved characters);
 *  otherwise wraps it in single quotes with embedded singles escaped via the
 *  classic `'\''` close-reopen pattern. The returned string is safe to paste
 *  into a POSIX shell prompt. */
function posixShellQuote(s: string): string {
	if (s === "") return "''";
	if (/^[A-Za-z0-9_./@%+:=,-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, "'\\''")}'`;
}
