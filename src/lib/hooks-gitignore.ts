// interlinked-tdd: exempt
// ===========================================
// .gitignore Management
// ===========================================
// Ensures `.gitignore` carries entries for the local files Interlinked
// writes under `.interlinked/`. Extracted out of `hooks.ts` so the main
// hooks module stays focused on hook install/uninstall orchestration.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GITIGNORE_ENTRIES = [
	".interlinked/config.local.json",
	".interlinked/activity.jsonl",
	".interlinked/collection.jsonl",
	".interlinked/recurrences.jsonl",
	".interlinked/realtime-retry.jsonl",
	".interlinked/sync-errors.jsonl",
	".interlinked/sync-state.json",
	".interlinked/sessions/",
	".interlinked/failures/",
	".interlinked/checkpoints.json",
	".interlinked/guard-cache.json",
	".interlinked/guard-rules.local.json",
	".interlinked/harness.sock",
	".interlinked/harness.pid",
	".interlinked/pending-quality-warnings.json",
	".interlinked/index/",
	".interlinked/semantic.local.json",
	".interlinked/error-history.jsonl",
	// Personal guard stand-down marker + the append-only guard audit log. The
	// TEAM marker (`guard-disabled.json`, no `.local`) is committed on purpose
	// (PR-visible), so it is deliberately NOT listed here.
	".interlinked/guard-disabled.local.json",
	".interlinked/guard-events.jsonl",
	// Sponsor opt-in runtime: row-3 status, cached signed feed, impression beacons.
	".interlinked/sponsor.status",
	".interlinked/sponsor-feed.json",
	".interlinked/sponsor-beacons.jsonl",
];

const DATA_GITIGNORE_ENTRIES = new Set([
	".interlinked/activity.jsonl",
	".interlinked/collection.jsonl",
	".interlinked/recurrences.jsonl",
	".interlinked/realtime-retry.jsonl",
	".interlinked/sync-errors.jsonl",
	".interlinked/sync-state.json",
	".interlinked/sessions/",
	".interlinked/failures/",
	".interlinked/checkpoints.json",
]);

/**
 * Ensure .gitignore contains entries for Interlinked CLI local files.
 * Skips data-related entries when data dir is outside the repo.
 * Returns true if modifications were made.
 */
export function ensureGitignore(cwd: string): boolean {
	const gitignorePath = join(cwd, ".gitignore");
	let content = "";

	if (existsSync(gitignorePath)) {
		content = readFileSync(gitignorePath, "utf-8");
	}

	const envDataDir = process.env.INTERLINKED_DATA_DIR?.trim();
	const isExternalData = Boolean(envDataDir) && !envDataDir?.startsWith(cwd);

	const lines = content.split("\n");
	const missingEntries: string[] = [];

	for (const entry of GITIGNORE_ENTRIES) {
		if (isExternalData && DATA_GITIGNORE_ENTRIES.has(entry)) continue;
		const alreadyPresent = lines.some(
			(line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""),
		);
		if (!alreadyPresent) {
			missingEntries.push(entry);
		}
	}

	if (missingEntries.length === 0) return false;

	const additions: string[] = [];
	if (!content.includes("# Interlinked CLI") && !content.includes("# Interlinked")) {
		additions.push("");
		additions.push("# Interlinked CLI (local agent config)");
	}
	additions.push(...missingEntries);

	const newContent = `${content.trimEnd()}\n${additions.join("\n")}\n`;
	writeFileSync(gitignorePath, newContent);
	return true;
}
