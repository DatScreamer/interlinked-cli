// ===========================================
// interlinked reset — Nuclear: clear all local state
// ===========================================

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { c, divider, header } from "../lib/formatter.js";

const INTERLINKED_MARKER = "interlinked-activity";

// Shared mutable accumulators + output sinks threaded through every reset phase.
interface ResetContext {
	removed: string[];
	failed: string[];
	emit: (line: string) => void;
	emitError: (line: string) => void;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// A single hook-group entry inside a client settings file.
interface HookEntry {
	hooks?: Array<{ command?: string }>;
}

// A parsed client settings file. The `hooks` map keys events to their entry
// lists; malformed values (non-arrays) are tolerated at runtime and narrowed
// via Array.isArray, hence the `HookEntry[] | undefined` value type. Indexer
// keys are event names (free-form), so a typed map is the precise shape here.
interface HookSettings {
	hooks?: { [eventName: string]: HookEntry[] | undefined };
}

// Render the confirmation gate shown when --force is absent (non-JSON mode).
function printConfirmationPreview(emit: (line: string) => void): void {
	emit(c.red("This will remove ALL Interlinked CLI local state."));
	emit("");
	emit("  What will be removed:");
	emit("    - .interlinked/ directory (config, hooks, sessions)");
	emit("    - Hook entries from client settings (.claude, .github/hooks)");
	emit("");
	emit(c.bold("Run with --force to confirm:"));
	emit(c.dim("  interlinked reset --force"));
}

// Phases 1–3: remove a path, recording success/failure and emitting to stderr
// on error (the loud-removal phases). `rmOpts` is omitted for plain file unlinks.
function removeAndReport(
	path: string,
	label: string,
	ctx: ResetContext,
	rmOpts?: { recursive: true; force: true },
): void {
	try {
		if (rmOpts) {
			rmSync(path, rmOpts);
		} else {
			rmSync(path);
		}
		ctx.removed.push(label);
		ctx.emit(`  ${c.green("removed")} ${label}`);
	} catch (e) {
		ctx.failed.push(`${label}: ${errorMessage(e)}`);
		ctx.emitError(`  ${c.red("failed")} ${label}: ${e instanceof Error ? e.message : e}`);
	}
}

// Filter interlinked hook entries out of a parsed settings object in place.
// Returns whether any entry was removed. Optionally deletes a fully-emptied
// `hooks` key (Claude behavior; Gemini leaves the key in place).
function filterInterlinkedHooks(settings: HookSettings, deleteEmptyHooks: boolean): boolean {
	if (!settings.hooks) return false;
	let changed = false;
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

	if (deleteEmptyHooks && Object.values(settings.hooks).every((v) => v === undefined)) {
		delete settings.hooks;
	}
	return changed;
}

// Phases 4–5: strip interlinked hook entries from a JSON settings file. Parse /
// write errors are recorded in `failed` but kept quiet on stderr (intentional).
function cleanSettingsFile(
	path: string,
	label: string,
	deleteEmptyHooks: boolean,
	ctx: ResetContext,
): void {
	if (!existsSync(path)) return;
	try {
		const content = readFileSync(path, "utf-8");
		if (!content.includes(INTERLINKED_MARKER)) return;

		const settings = JSON.parse(content);
		if (filterInterlinkedHooks(settings, deleteEmptyHooks)) {
			writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
			ctx.removed.push(`${label} (hook entries)`);
			ctx.emit(`  ${c.green("cleaned")} ${label} (removed hook entries)`);
		}
	} catch (e) {
		ctx.failed.push(`${label}: ${errorMessage(e)}`);
		// Ignore parse errors
	}
}

// Phase 6: strip the interlinked notify line from Codex's config.toml.
function cleanCodexConfig(path: string, label: string, ctx: ResetContext): void {
	if (!existsSync(path)) return;
	try {
		let content = readFileSync(path, "utf-8");
		if (content.includes(INTERLINKED_MARKER)) {
			content = content.replace(/^notify\s*=\s*.*interlinked-activity.*\n?/m, "");
			writeFileSync(path, content);
			ctx.removed.push(`${label} (notify entry)`);
			ctx.emit(`  ${c.green("cleaned")} ${label} (removed notify entry)`);
		}
	} catch (e) {
		ctx.failed.push(`${label}: ${errorMessage(e)}`);
		// Ignore errors
	}
}

// Render the JSON result payload (--json mode summary).
function printJsonSummary(removed: string[], failed: string[]): void {
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
}

// Render the human-readable summary (non-JSON mode).
function printHumanSummary(removed: string[], emit: (line: string) => void): void {
	emit("");
	emit(divider());
	if (removed.length > 0) {
		emit(c.green(`  Reset complete. Removed ${removed.length} item(s).`));
		emit(c.dim("  Run 'interlinked enable' to set up again."));
	} else {
		emit(c.dim("  Nothing to remove. Already clean."));
	}
}

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
		printConfirmationPreview(emit);
		return;
	}

	const cwd = process.cwd();
	const ctx: ResetContext = { removed: [], failed: [], emit, emitError };

	emit(header("Resetting Interlinked CLI"));

	// 1. Remove .interlinked/ directory
	const configDir = join(cwd, ".interlinked");
	if (existsSync(configDir)) {
		removeAndReport(configDir, ".interlinked/", ctx, { recursive: true, force: true });
	} else {
		emit(`  ${c.dim("skip")}    .interlinked/ (not found)`);
	}

	// 2. Remove legacy config
	const legacyConfig = join(cwd, ".claude", "interlinked-session.json");
	if (existsSync(legacyConfig)) {
		removeAndReport(legacyConfig, ".claude/interlinked-session.json", ctx);
	}

	// 3. Remove legacy hook script
	const legacyHook = join(cwd, ".claude", "hooks", "interlinked-activity.mjs");
	if (existsSync(legacyHook)) {
		removeAndReport(legacyHook, ".claude/hooks/interlinked-activity.mjs", ctx);
	}

	// 4. Remove hook entries from Claude Code settings (deletes emptied `hooks` key)
	cleanSettingsFile(join(cwd, ".claude", "settings.json"), ".claude/settings.json", true, ctx);

	// 5. Remove hook entries from Gemini settings (leaves emptied `hooks` key)
	cleanSettingsFile(join(cwd, ".gemini", "settings.json"), ".gemini/settings.json", false, ctx);

	// 6. Remove hook entries from Codex config
	cleanCodexConfig(join(cwd, ".codex", "config.toml"), ".codex/config.toml", ctx);

	// Summary
	if (jsonMode) {
		printJsonSummary(ctx.removed, ctx.failed);
	} else {
		printHumanSummary(ctx.removed, emit);
	}

	if (ctx.failed.length > 0) {
		process.exitCode = 1;
	}
}
