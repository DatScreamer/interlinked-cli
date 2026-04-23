// ===========================================
// interlinked reset — Nuclear: clear all local state
// ===========================================

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, divider, header } from "../lib/formatter.js";

const INTERLINKED_MARKER = "interlinked-activity";

export async function resetCommand(opts: { force?: boolean; json?: boolean }): Promise<void> {
	const jsonMode = Boolean(opts.json);
	const emit = (line: string): void => {
		if (!jsonMode) {
			console.log(line);
		}
	};
	const emitError = (line: string): void => {
		if (!jsonMode) {
			console.error(line);
		}
	};

	if (!opts.force) {
		if (jsonMode) {
			console.log(
				JSON.stringify(
					{
						ok: false,
						error: "--force is required",
						usage: "interlinked reset --force",
					},
					null,
					2,
				),
			);
			process.exitCode = 1;
			return;
		}
		emit(c.red("This will remove ALL Interlinked CLI local state."));
		emit("");
		emit("  What will be removed:");
		emit("    - .interlinked/ directory (config, hooks, sessions)");
		emit("    - Hook entries from client settings (.claude, .github/hooks)");
		emit("");
		emit(c.bold("Run with --force to confirm:"));
		emit(c.dim("  interlinked reset --force"));
		return;
	}

	const cwd = process.cwd();
	const removed: string[] = [];
	const failed: string[] = [];

	emit(header("Resetting Interlinked CLI"));

	// ===========================================
	// 1. Remove .interlinked/ directory
	// ===========================================

	const configDir = join(cwd, ".interlinked");
	if (existsSync(configDir)) {
		try {
			rmSync(configDir, { recursive: true, force: true });
			removed.push(".interlinked/");
			emit(`  ${c.green("removed")} .interlinked/`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push(`.interlinked/: ${message}`);
			emitError(`  ${c.red("failed")} .interlinked/: ${e instanceof Error ? e.message : e}`);
		}
	} else {
		emit(`  ${c.dim("skip")}    .interlinked/ (not found)`);
	}

	// ===========================================
	// 2. Remove legacy config
	// ===========================================

	const legacyConfig = join(cwd, ".claude", "interlinked-session.json");
	if (existsSync(legacyConfig)) {
		try {
			rmSync(legacyConfig);
			removed.push(".claude/interlinked-session.json");
			emit(`  ${c.green("removed")} .claude/interlinked-session.json`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push(`.claude/interlinked-session.json: ${message}`);
			emitError(
				`  ${c.red("failed")} .claude/interlinked-session.json: ${e instanceof Error ? e.message : e}`,
			);
		}
	}

	// ===========================================
	// 3. Remove legacy hook script
	// ===========================================

	const legacyHook = join(cwd, ".claude", "hooks", "interlinked-activity.mjs");
	if (existsSync(legacyHook)) {
		try {
			rmSync(legacyHook);
			removed.push(".claude/hooks/interlinked-activity.mjs");
			emit(`  ${c.green("removed")} .claude/hooks/interlinked-activity.mjs`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push(`.claude/hooks/interlinked-activity.mjs: ${message}`);
			emitError(
				`  ${c.red("failed")} .claude/hooks/interlinked-activity.mjs: ${e instanceof Error ? e.message : e}`,
			);
		}
	}

	// ===========================================
	// 4. Remove hook entries from Claude Code settings
	// ===========================================

	const claudeSettings = join(cwd, ".claude", "settings.json");
	if (existsSync(claudeSettings)) {
		try {
			const content = readFileSync(claudeSettings, "utf-8");
			if (content.includes(INTERLINKED_MARKER)) {
				const settings = JSON.parse(content);
				let changed = false;

				if (settings.hooks) {
					for (const eventName of Object.keys(settings.hooks)) {
						const entries = settings.hooks[eventName];
						if (!Array.isArray(entries)) continue;

						const filtered = entries.filter(
							(entry: { hooks?: Array<{ command?: string }> }) =>
								!entry.hooks?.some((h) => h.command?.includes(INTERLINKED_MARKER)),
						);

						if (filtered.length !== entries.length) {
							settings.hooks[eventName] = filtered.length > 0 ? filtered : undefined;
							changed = true;
						}
					}

					// Clean up empty hooks
					if (Object.values(settings.hooks).every((v) => v === undefined)) {
						delete settings.hooks;
					}
				}

				if (changed) {
					writeFileSync(claudeSettings, `${JSON.stringify(settings, null, 2)}\n`);
					removed.push(".claude/settings.json (hook entries)");
					emit(`  ${c.green("cleaned")} .claude/settings.json (removed hook entries)`);
				}
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push(`.claude/settings.json: ${message}`);
			// Ignore parse errors
		}
	}

	// ===========================================
	// 5. Remove hook entries from Gemini settings
	// ===========================================

	const geminiSettings = join(cwd, ".gemini", "settings.json");
	if (existsSync(geminiSettings)) {
		try {
			const content = readFileSync(geminiSettings, "utf-8");
			if (content.includes(INTERLINKED_MARKER)) {
				const settings = JSON.parse(content);
				let changed = false;

				if (settings.hooks) {
					for (const eventName of Object.keys(settings.hooks)) {
						const entries = settings.hooks[eventName];
						if (!Array.isArray(entries)) continue;

						const filtered = entries.filter(
							(entry: { hooks?: Array<{ command?: string }> }) =>
								!entry.hooks?.some((h) => h.command?.includes(INTERLINKED_MARKER)),
						);

						if (filtered.length !== entries.length) {
							settings.hooks[eventName] = filtered.length > 0 ? filtered : undefined;
							changed = true;
						}
					}
				}

				if (changed) {
					writeFileSync(geminiSettings, `${JSON.stringify(settings, null, 2)}\n`);
					removed.push(".gemini/settings.json (hook entries)");
					emit(`  ${c.green("cleaned")} .gemini/settings.json (removed hook entries)`);
				}
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push(`.gemini/settings.json: ${message}`);
			// Ignore parse errors
		}
	}

	// ===========================================
	// 6. Remove hook entries from Codex config
	// ===========================================

	const codexConfig = join(cwd, ".codex", "config.toml");
	if (existsSync(codexConfig)) {
		try {
			let content = readFileSync(codexConfig, "utf-8");
			if (content.includes(INTERLINKED_MARKER)) {
				content = content.replace(/^notify\s*=\s*.*interlinked-activity.*\n?/m, "");
				writeFileSync(codexConfig, content);
				removed.push(".codex/config.toml (notify entry)");
				emit(`  ${c.green("cleaned")} .codex/config.toml (removed notify entry)`);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push(`.codex/config.toml: ${message}`);
			// Ignore errors
		}
	}

	// ===========================================
	// Summary
	// ===========================================

	if (jsonMode) {
		console.log(
			JSON.stringify(
				{
					ok: failed.length === 0,
					removed_count: removed.length,
					removed,
					failed_count: failed.length,
					failed,
				},
				null,
				2,
			),
		);
	} else {
		emit("");
		emit(divider());
		if (removed.length > 0) {
			emit(c.green(`  Reset complete. Removed ${removed.length} item(s).`));
			emit(c.dim("  Run 'interlinked enable' to set up again."));
		} else {
			emit(c.dim("  Nothing to remove. Already clean."));
		}
	}

	if (failed.length > 0) {
		process.exitCode = 1;
	}
}
