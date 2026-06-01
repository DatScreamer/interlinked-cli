import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GEMINI_HOOK_EVENTS,
	installGeminiHooks,
	uninstallGeminiHooks,
} from "../hook-installers-gemini.js";

describe("Gemini hook event list", () => {
	it("includes BeforeTool/AfterTool", () => {
		expect(GEMINI_HOOK_EVENTS).toContain("BeforeTool");
		expect(GEMINI_HOOK_EVENTS).toContain("AfterTool");
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

	it("registers AfterTool with empty matcher (all-tool capture)", () => {
		installGeminiHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const settings = JSON.parse(
			readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8"),
		);
		// Per-tool matcher is empty — every tool's result is captured;
		// the .mjs hook fast-paths non-mutation tools internally.
		const afterTool = settings.hooks?.AfterTool;
		expect(Array.isArray(afterTool)).toBe(true);
		expect(afterTool[0].matcher).toBe("");
	});

	it("removes interlinked entries on uninstall", () => {
		installGeminiHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const changed = uninstallGeminiHooks(tmp);
		expect(changed).toBe(true);

		const content = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
		expect(content).not.toContain("interlinked-activity");
	});
});
