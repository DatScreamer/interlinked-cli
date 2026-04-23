// ===========================================
// interlinked clean — Remove stale data
// ===========================================

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { c, divider, header } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";

interface StaleItem {
	type: "session_file" | "orphaned_hook" | "large_activity_log" | "stale_session";
	path: string;
	detail: string;
	age?: string;
}

function formatAge(ms: number): string {
	const hours = Math.floor(ms / 3600000);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export async function cleanCommand(opts: {
	dryRun?: boolean;
	force?: boolean;
	json?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const isDryRun = !opts.force; // Default is dry-run unless --force
	const staleItems: StaleItem[] = [];
	const removedItems: string[] = [];

	// ===========================================
	// 1. Stale session files (older than 24h)
	// ===========================================

	const sessionsDir = join(cwd, ".interlinked", "hooks", "agent-sessions");
	if (existsSync(sessionsDir)) {
		try {
			const files = readdirSync(sessionsDir);
			const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24h

			for (const file of files) {
				const filePath = join(sessionsDir, file);
				try {
					const stat = statSync(filePath);
					if (stat.mtimeMs < staleThreshold) {
						const ageMs = Date.now() - stat.mtimeMs;
						staleItems.push({
							type: "session_file",
							path: filePath,
							detail: `Last modified ${formatAge(ageMs)} ago`,
							age: formatAge(ageMs),
						});

						if (!isDryRun) {
							unlinkSync(filePath);
							removedItems.push(filePath);
						}
					}
				} catch (_) {
					/* intentional: skip files we cannot stat (permission/race) */
				}
			}
		} catch (_) {
			/* intentional: sessions directory not readable, treat as empty */
		}
	}

	// ===========================================
	// 2. Activity log size check (>50MB → offer truncation)
	// ===========================================

	const activityPath = join(cwd, ".interlinked", "activity.jsonl");
	const syncStatePath = join(cwd, ".interlinked", "sync-state.json");
	if (existsSync(activityPath)) {
		try {
			const stat = statSync(activityPath);
			const sizeMB = stat.size / (1024 * 1024);
			if (sizeMB > 50) {
				staleItems.push({
					type: "large_activity_log",
					path: activityPath,
					detail: `Activity log is ${sizeMB.toFixed(1)} MB (>50 MB threshold)`,
				});

				if (!isDryRun) {
					// Keep last 10K lines
					const content = readFileSync(activityPath, "utf-8");
					const lines = content.split("\n").filter(Boolean);
					const kept = lines.slice(-10000);
					writeFileSync(activityPath, `${kept.join("\n")}\n`);
					removedItems.push(`${activityPath} (truncated to 10K lines)`);

					// Truncation invalidates byte offsets for sync state.
					writeFileSync(
						syncStatePath,
						`${JSON.stringify({
							synced_through_bytes: 0,
							last_sync_at: null,
							reset_at: new Date().toISOString(),
							reason: "activity_log_truncated",
						})}\n`,
					);
					removedItems.push(`${syncStatePath} (sync cursor reset)`);
				}
			}
		} catch (_) {
			/* intentional: activity log unreadable, skip size check */
		}
	}

	// ===========================================
	// 3. Stale local session files (>24h)
	// ===========================================

	const localSessionsDir = join(cwd, ".interlinked", "sessions");
	if (existsSync(localSessionsDir)) {
		try {
			const files = readdirSync(localSessionsDir);
			const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;

			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const filePath = join(localSessionsDir, file);
				try {
					const stat = statSync(filePath);
					if (stat.mtimeMs < staleThreshold) {
						const ageMs = Date.now() - stat.mtimeMs;
						staleItems.push({
							type: "stale_session",
							path: filePath,
							detail: `Session file last modified ${formatAge(ageMs)} ago`,
							age: formatAge(ageMs),
						});
						if (!isDryRun) {
							unlinkSync(filePath);
							removedItems.push(filePath);
						}
					}
				} catch (_) {
					/* intentional: skip file we cannot stat */
				}
			}
		} catch (_) {
			/* intentional: local sessions dir not readable, treat as empty */
		}
	}

	// ===========================================
	// 4. Orphaned hook entries in client settings
	// ===========================================

	const clientSettings: Array<{ name: string; path: string; format: "json" | "toml" }> = [
		{ name: "Claude Code", path: join(cwd, ".claude", "settings.json"), format: "json" },
		{ name: "Gemini CLI", path: join(cwd, ".gemini", "settings.json"), format: "json" },
		{ name: "Codex CLI", path: join(cwd, ".codex", "config.toml"), format: "toml" },
	];

	for (const client of clientSettings) {
		if (!existsSync(client.path)) continue;

		try {
			const content = readFileSync(client.path, "utf-8");
			if (content.includes("interlinked-activity")) {
				// Check if the referenced hook script actually exists
				const hookMatch = content.match(/interlinked-activity\.mjs/);
				if (hookMatch) {
					// Try to find the actual script path from the settings
					const scriptPathMatch = content.match(
						/node\s+([^\s"]+interlinked-activity\.mjs)/,
					);
					if (scriptPathMatch) {
						const scriptPath = scriptPathMatch[1];
						if (!existsSync(scriptPath)) {
							staleItems.push({
								type: "orphaned_hook",
								path: client.path,
								detail: `${client.name}: Hook references missing script at ${scriptPath}`,
							});
						}
					}
				}
			}
		} catch (_) {
			/* intentional: client settings unreadable, skip orphan detection */
		}
	}

	// ===========================================
	// Output
	// ===========================================

	output(mode, staleItems, {
		json: () => ({
			dry_run: isDryRun,
			stale_items: staleItems,
			removed: isDryRun ? [] : removedItems,
			total_found: staleItems.length,
			total_removed: removedItems.length,
		}),
		normal: () => {
			const lines: string[] = [];
			lines.push(header(isDryRun ? "Clean (dry-run)" : "Clean"));

			if (staleItems.length === 0) {
				lines.push(c.green("  No stale data found. Everything looks clean."));
				return lines.join("\n");
			}

			// Group by type
			const sessionFiles = staleItems.filter((i) => i.type === "session_file");
			const orphanedHooks = staleItems.filter((i) => i.type === "orphaned_hook");
			const largeLog = staleItems.filter((i) => i.type === "large_activity_log");
			const staleSessions = staleItems.filter((i) => i.type === "stale_session");

			if (largeLog.length > 0) {
				lines.push(`\n  ${c.bold("Large activity log")}:`);
				for (const item of largeLog) {
					const action = isDryRun ? c.yellow("would truncate") : c.green("truncated");
					lines.push(`    ${action} ${item.detail}`);
				}
			}

			if (sessionFiles.length > 0) {
				lines.push(`\n  ${c.bold("Stale hook session files")} (older than 24h):`);
				for (const item of sessionFiles) {
					const action = isDryRun ? c.yellow("would remove") : c.green("removed");
					lines.push(`    ${action} ${item.path}`);
					lines.push(`             ${c.dim(item.detail)}`);
				}
			}

			if (staleSessions.length > 0) {
				lines.push(`\n  ${c.bold("Stale local sessions")} (older than 24h):`);
				for (const item of staleSessions) {
					const action = isDryRun ? c.yellow("would remove") : c.green("removed");
					lines.push(`    ${action} ${item.path}`);
					lines.push(`             ${c.dim(item.detail)}`);
				}
			}

			if (orphanedHooks.length > 0) {
				lines.push(`\n  ${c.bold("Orphaned hook entries")}:`);
				for (const item of orphanedHooks) {
					lines.push(`    ${c.yellow("found")} ${item.detail}`);
					lines.push(
						`             ${c.dim("Run 'interlinked enable' to reinstall hooks")}`,
					);
				}
			}

			lines.push("");
			lines.push(divider());
			if (isDryRun) {
				lines.push(
					c.dim(
						`  Found ${staleItems.length} item(s). Run 'interlinked clean --force' to remove.`,
					),
				);
			} else {
				lines.push(c.green(`  Removed ${removedItems.length} item(s).`));
				if (orphanedHooks.length > 0) {
					lines.push(
						c.dim(
							`  ${orphanedHooks.length} orphaned hook(s) found. Run 'interlinked enable' to fix.`,
						),
					);
				}
			}

			return lines.join("\n");
		},
	});
}
