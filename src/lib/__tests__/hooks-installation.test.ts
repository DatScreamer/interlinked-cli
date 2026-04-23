import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAllHooks, uninstallAllHooks } from "../hooks.js";

describe("hook installation", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-install-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("installs Gemini CLI hooks into .gemini/settings.json", () => {
		const results = installAllHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs", [
			"gemini",
		]);

		expect(results[0]?.installed).toBe(true);
		const settingsPath = join(tmp, ".gemini", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);

		const content = readFileSync(settingsPath, "utf-8");
		expect(content).toContain('"BeforeTool"');
		expect(content).toContain('"AfterTool"');
		expect(content).toContain("INTERLINKED_CLIENT");
		expect(content).toContain("interlinked-activity");
	});

	it("removes Gemini CLI hooks without touching the settings file shape", () => {
		installAllHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs", ["gemini"]);
		const results = uninstallAllHooks(tmp, ["gemini"]);
		expect(results[0]?.events.length).toBeGreaterThan(0);

		const content = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
		expect(content).not.toContain("interlinked-activity");
	});
});
