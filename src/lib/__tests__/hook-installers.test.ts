import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLAUDE_HOOK_EVENTS,
	COPILOT_HOOK_EVENTS,
	GEMINI_HOOK_EVENTS,
	installCopilotHooks,
	installGeminiHooks,
	uninstallCopilotHooks,
	uninstallGeminiHooks,
} from "../hook-installers.js";

describe("hook event lists", () => {
	it("claude event list includes PostToolUse and SessionStart", () => {
		expect(CLAUDE_HOOK_EVENTS).toContain("SessionStart");
		expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUse");
		// PostToolUseFailure is intentionally omitted (see comment on CLAUDE_HOOK_EVENTS).
		expect(CLAUDE_HOOK_EVENTS).not.toContain("PostToolUseFailure");
	});

	it("copilot event list uses camelCase naming", () => {
		expect(COPILOT_HOOK_EVENTS).toContain("sessionStart");
		expect(COPILOT_HOOK_EVENTS).toContain("postToolUse");
	});

	it("gemini event list includes BeforeTool/AfterTool", () => {
		expect(GEMINI_HOOK_EVENTS).toContain("BeforeTool");
		expect(GEMINI_HOOK_EVENTS).toContain("AfterTool");
	});
});

describe("installCopilotHooks / uninstallCopilotHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "copilot-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes .github/hooks/hooks.json with Copilot event entries", () => {
		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".github", "hooks", "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);

		const content = readFileSync(hooksPath, "utf-8");
		expect(content).toContain('"sessionStart"');
		expect(content).toContain('"postToolUse"');
		expect(content).toContain("interlinked-activity");
		expect(content).toContain("INTERLINKED_CLIENT");
	});

	it("removes interlinked entries and deletes file when no hooks remain", () => {
		installCopilotHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const changed = uninstallCopilotHooks(tmp);
		expect(changed).toBe(true);

		const hooksPath = join(tmp, ".github", "hooks", "hooks.json");
		expect(existsSync(hooksPath)).toBe(false);
	});

	it("uninstall is a no-op when file is missing", () => {
		expect(uninstallCopilotHooks(tmp)).toBe(false);
	});
});

describe("installGeminiHooks / uninstallGeminiHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "gemini-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes .gemini/settings.json with Gemini event entries", () => {
		installGeminiHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const settingsPath = join(tmp, ".gemini", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);

		const content = readFileSync(settingsPath, "utf-8");
		expect(content).toContain('"BeforeTool"');
		expect(content).toContain('"AfterTool"');
		expect(content).toContain("interlinked-activity");
	});

	it("scopes AfterTool matcher to mutation tools only", () => {
		installGeminiHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const content = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
		// AfterTool entry must carry the mutation-only matcher.
		expect(content).toContain("Edit|Write|MultiEdit");
	});

	it("removes interlinked entries on uninstall", () => {
		installGeminiHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const changed = uninstallGeminiHooks(tmp);
		expect(changed).toBe(true);

		const content = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
		expect(content).not.toContain("interlinked-activity");
	});
});
