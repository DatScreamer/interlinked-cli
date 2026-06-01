import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_HOOK_EVENTS,
	installCursorHooks,
	uninstallCursorHooks,
} from "../hook-installers-cursor.js";

describe("Cursor hook event list", () => {
	it("includes both MCP naming variants", () => {
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMCPExecution");
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMcpToolExecution");
	});
});

describe("installCursorHooks / uninstallCursorHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cursor-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes both Cursor MCP hook event variants", () => {
		installCursorHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".cursor", "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);
		const content = readFileSync(hooksPath, "utf-8");
		expect(content).toContain('"beforeMCPExecution"');
		expect(content).toContain('"beforeMcpToolExecution"');
	});

	it("removes Interlinked entries and deletes hooks.json when empty", () => {
		installCursorHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		expect(uninstallCursorHooks(tmp)).toBe(true);
		expect(existsSync(join(tmp, ".cursor", "hooks.json"))).toBe(false);
	});
});
