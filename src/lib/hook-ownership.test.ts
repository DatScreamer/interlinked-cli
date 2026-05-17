import { describe, expect, it } from "vitest";
import {
	hookEntryCommands,
	isInterlinkedHookCommand,
	isInterlinkedHookEntry,
} from "./hook-ownership.js";

// The real command shapes the two install systems write.
const LEGACY_MJS =
	`HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; HOOK_DIR="$PWD"; ` +
	`while :; do if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then node "$HOOK_DIR/$HOOK_SCRIPT_REL"; break; fi; done`;
const ADAPTER_CMD =
	`if test -f '/repo/dist/hook-entry.js' ; then node '/repo/dist/hook-entry.js' ` +
	`--runner 'claude-code' --event 'PostToolUse' ; fi`;
const ADAPTER_BIN_CMD = `node '/usr/local/bin/interlinked-hook' --runner 'codex' --event 'PreToolUse'`;

describe("isInterlinkedHookCommand", () => {
	it("recognizes the legacy .mjs hook command", () => {
		expect(isInterlinkedHookCommand(LEGACY_MJS)).toBe(true);
	});
	it("recognizes the adapter hook-entry.js command", () => {
		expect(isInterlinkedHookCommand(ADAPTER_CMD)).toBe(true);
	});
	it("recognizes the adapter interlinked-hook bin command", () => {
		expect(isInterlinkedHookCommand(ADAPTER_BIN_CMD)).toBe(true);
	});
	it("does not match an unrelated hook command", () => {
		expect(isInterlinkedHookCommand("npx prettier --write .")).toBe(false);
		expect(isInterlinkedHookCommand("node ./scripts/my-hook.js")).toBe(false);
	});
	it("does not match an empty command", () => {
		expect(isInterlinkedHookCommand("")).toBe(false);
	});
});

describe("hookEntryCommands", () => {
	it("extracts from the Claude Code nested shape", () => {
		const entry = { matcher: "", hooks: [{ type: "command", command: ADAPTER_CMD }] };
		expect(hookEntryCommands(entry)).toEqual([ADAPTER_CMD]);
	});
	it("extracts from a flat command entry", () => {
		expect(hookEntryCommands({ command: LEGACY_MJS })).toEqual([LEGACY_MJS]);
	});
	it("extracts from a Copilot-style bash entry", () => {
		expect(hookEntryCommands({ type: "command", bash: ADAPTER_CMD })).toEqual([ADAPTER_CMD]);
	});
	it("yields nothing for junk", () => {
		expect(hookEntryCommands(null)).toEqual([]);
		expect(hookEntryCommands({ matcher: "" })).toEqual([]);
	});
});

describe("isInterlinkedHookEntry", () => {
	it("recognizes a Claude Code legacy hook entry", () => {
		const entry = { matcher: "", hooks: [{ type: "command", command: LEGACY_MJS }] };
		expect(isInterlinkedHookEntry(entry)).toBe(true);
	});
	it("recognizes a Claude Code adapter hook entry", () => {
		const entry = { matcher: "Edit|Write", hooks: [{ type: "command", command: ADAPTER_CMD }] };
		expect(isInterlinkedHookEntry(entry)).toBe(true);
	});
	it("recognizes a Copilot-style adapter entry", () => {
		expect(isInterlinkedHookEntry({ type: "command", bash: ADAPTER_BIN_CMD })).toBe(true);
	});
	it("does not match a foreign hook entry", () => {
		const entry = { matcher: "", hooks: [{ type: "command", command: "npx lint-staged" }] };
		expect(isInterlinkedHookEntry(entry)).toBe(false);
	});
});
