import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COPILOT_HOOK_EVENTS,
	installCopilotHooks,
	uninstallCopilotHooks,
} from "../hook-installers-copilot.js";

describe("Copilot hook event list", () => {
	it("uses camelCase naming", () => {
		expect(COPILOT_HOOK_EVENTS).toContain("sessionStart");
		expect(COPILOT_HOOK_EVENTS).toContain("postToolUse");
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
