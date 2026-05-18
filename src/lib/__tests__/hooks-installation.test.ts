import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAllHooks, uninstallAllHooks } from "../hooks.js";

// `installAllHooks` routes through the adapter installer (the B refactor):
// hooks land in .gemini/settings.json in the adapter command shape
// (`node <binary> --runner gemini-cli --event ...`), and uninstall removes
// every Interlinked entry — including adapter-registered events the legacy
// per-client event lists omitted.

describe("hook installation", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-install-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("installs Gemini CLI hooks into .gemini/settings.json", () => {
		const results = installAllHooks(tmp, ["gemini"]);

		expect(results[0]?.installed).toBe(true);
		const settingsPath = join(tmp, ".gemini", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);

		const content = readFileSync(settingsPath, "utf-8");
		expect(content).toContain('"BeforeTool"');
		expect(content).toContain('"AfterTool"');
		// Adapter command shape: `node <binary> --runner gemini-cli --event ...`.
		expect(content).toContain("--runner");
		expect(content).toContain("gemini-cli");
	});

	it("removes Gemini CLI hooks, including events the legacy list omitted", () => {
		installAllHooks(tmp, ["gemini"]);
		const results = uninstallAllHooks(tmp, ["gemini"]);
		expect(results[0]?.events.length).toBeGreaterThan(0);

		// The cleaner iterates every event present, so adapter-only events
		// (e.g. AfterModel) are removed too — no Interlinked hook survives.
		const content = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
		expect(content).not.toContain("interlinked-activity");
		expect(content).not.toContain("hook-entry.js");
		expect(content).not.toContain("--runner");
	});
});
