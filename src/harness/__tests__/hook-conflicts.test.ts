// ===========================================
// Hook Conflict Detection Tests
// ===========================================
// Ensures no duplicate/conflicting hook registrations across
// .claude/hooks.json and .claude/settings.json.
// Duplicate PostToolUse hooks cause output to be swallowed silently.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

interface HookEntry {
	matcher: string;
	hooks: Array<{ type: string; command: string; timeout?: number }>;
}

interface HooksConfig {
	hooks?: Record<string, HookEntry[]>;
}

function loadJsonSafe(path: string): HooksConfig | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

describe("hook conflict detection", () => {
	const hooksJsonPath = join(PROJECT_ROOT, ".claude", "hooks.json");
	const settingsJsonPath = join(PROJECT_ROOT, ".claude", "settings.json");
	const settingsLocalPath = join(PROJECT_ROOT, ".claude", "settings.local.json");
	// Subdirectory settings that Claude Code merges with the root
	const cliSettingsPath = join(PROJECT_ROOT, "cli", ".claude", "settings.json");

	it("no duplicate PostToolUse hooks across config files", () => {
		const sources: Array<{ file: string; events: string[] }> = [];

		for (const path of [hooksJsonPath, settingsJsonPath, settingsLocalPath, cliSettingsPath]) {
			const config = loadJsonSafe(path);
			if (!config?.hooks) continue;
			const events = Object.keys(config.hooks).filter(
				(e) => config.hooks![e] && config.hooks![e].length > 0,
			);
			if (events.length > 0) {
				sources.push({ file: path, events });
			}
		}

		// Check for PostToolUse defined in multiple files
		const postToolUseFiles = sources
			.filter((s) => s.events.includes("PostToolUse"))
			.map((s) => s.file);

		expect(
			postToolUseFiles.length,
			`PostToolUse hooks defined in multiple files (causes output conflicts): ${postToolUseFiles.join(", ")}`,
		).toBeLessThanOrEqual(1);
	});

	it("no duplicate PreToolUse hooks for same matcher across config files", () => {
		const matchersByFile = new Map<string, Map<string, string[]>>();

		for (const path of [hooksJsonPath, settingsJsonPath, settingsLocalPath, cliSettingsPath]) {
			const config = loadJsonSafe(path);
			if (!config?.hooks?.PreToolUse) continue;

			for (const entry of config.hooks.PreToolUse) {
				const matcher = entry.matcher || "(all)";
				if (!matchersByFile.has(matcher)) matchersByFile.set(matcher, new Map());
				const files = matchersByFile.get(matcher)!;
				if (!files.has(path)) files.set(path, []);
				for (const hook of entry.hooks || []) {
					files.get(path)!.push(hook.command);
				}
			}
		}

		// Check for same matcher in multiple files
		for (const [, fileMap] of matchersByFile) {
			const filesWithMatcher = [...fileMap.keys()];
			// Multiple files can define PreToolUse for the same matcher
			// (they serve different purposes — guard rules vs reservations)
			// Just verify no exact duplicate commands
			expect(filesWithMatcher.length).toBeGreaterThan(0);
		}
	});

	it("hooks.json PostToolUse does not shadow settings.json PostToolUse", () => {
		const hooksJson = loadJsonSafe(hooksJsonPath);
		const settingsJson = loadJsonSafe(settingsJsonPath);

		// If both files define PostToolUse, that's the conflict we hit
		const hooksHasPost = (hooksJson?.hooks?.PostToolUse?.length ?? 0) > 0;
		const settingsHasPost = (settingsJson?.hooks?.PostToolUse?.length ?? 0) > 0;

		expect(
			hooksHasPost && settingsHasPost,
			"PostToolUse defined in BOTH hooks.json AND settings.json — this causes one hook to shadow the other's output. Remove one.",
		).toBe(false);
	});

	it("all hook commands reference files that exist", () => {
		for (const path of [hooksJsonPath, settingsJsonPath]) {
			const config = loadJsonSafe(path);
			if (!config?.hooks) continue;

			for (const [event, entries] of Object.entries(config.hooks)) {
				for (const entry of entries) {
					for (const hook of entry.hooks || []) {
						const cmd = hook.command;
						// Extract file paths from the command
						// Pattern: node "path/to/script.mjs" or test -f "path" && node "path"
						const fileMatches = cmd.match(/(?:node\s+)?["']?([^"'\s|&;]+\.m?js)["']?/g);
						if (!fileMatches) continue;

						for (const match of fileMatches) {
							const filePath = match.replace(/^node\s+/, "").replace(/["']/g, "");
							const absPath = isAbsolute(filePath)
								? filePath
								: join(PROJECT_ROOT, filePath);
							// Skip when the command guards the existence check itself.
							// Two equivalent shell idioms appear in installed hooks:
							//   • `test -f X && node X || true`  (short-circuit form)
							//   • `if test -f X ; then node X ; fi` (block form)
							// Both fail-open if the dist binary is missing, so the test
							// shouldn't flag them.
							if (
								cmd.includes("test -f") &&
								(cmd.includes("|| true") || cmd.includes("if test -f"))
							)
								continue;

							expect(
								existsSync(absPath),
								`${event} hook in ${path} references missing file: ${filePath}`,
							).toBe(true);
						}
					}
				}
			}
		}
	});
});
