import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLAUDE_HOOK_EVENTS,
	CODEX_HOOK_EVENTS,
	COPILOT_HOOK_EVENTS,
	CURSOR_HOOK_EVENTS,
	GEMINI_HOOK_EVENTS,
	installCodexHooks,
	installCopilotHooks,
	installCursorHooks,
	installGeminiHooks,
	uninstallCodexHooks,
	uninstallCopilotHooks,
	uninstallCursorHooks,
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

	it("codex event list uses Claude-compatible PascalCase names", () => {
		// Codex CLI shipped its hook contract using Claude Code's
		// vocabulary, so we keep PascalCase event names. PermissionRequest
		// is its own event type, separate from PreToolUse.
		expect(CODEX_HOOK_EVENTS).toContain("SessionStart");
		expect(CODEX_HOOK_EVENTS).toContain("UserPromptSubmit");
		expect(CODEX_HOOK_EVENTS).toContain("PreToolUse");
		expect(CODEX_HOOK_EVENTS).toContain("PostToolUse");
		expect(CODEX_HOOK_EVENTS).toContain("PermissionRequest");
		expect(CODEX_HOOK_EVENTS).toContain("Stop");
	});

	it("cursor event list includes both MCP naming variants", () => {
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMCPExecution");
		expect(CURSOR_HOOK_EVENTS).toContain("beforeMcpToolExecution");
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

describe("installCodexHooks / uninstallCodexHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "codex-hooks-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes .codex/hooks.json with all six PascalCase events", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".codex", "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);

		const content = readFileSync(hooksPath, "utf-8");
		for (const ev of CODEX_HOOK_EVENTS) {
			expect(content).toContain(`"${ev}"`);
		}
	});

	it("tags installed commands with INTERLINKED_CLIENT=codex", () => {
		// Codex's hook payload mirrors Claude's so the .mjs needs an
		// out-of-band signal to know which client it's serving — that
		// signal is the env prefix on the installed command.
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const content = readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8");
		expect(content).toContain('INTERLINKED_CLIENT=\\"codex\\"');
		expect(content).toContain('INTERLINKED_RUNNER=\\"codex\\"');
	});

	it("walks up from subdirectories to find the hook script", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const content = readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8");
		expect(content).toContain('HOOK_DIR=\\"$PWD\\"');
		expect(content).toContain('dirname \\"$HOOK_DIR\\"');
		expect(content).toContain('.interlinked/hooks/interlinked-activity.mjs');
	});

	it("registers PostToolUse with empty matcher (all-tool capture)", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooks = JSON.parse(
			readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8"),
		);
		// Per-tool matcher is empty — every tool's result is captured;
		// the .mjs hook fast-paths non-mutation tools internally so the
		// harness round-trip only happens for Edit/Write/MultiEdit/apply_patch.
		const postToolUse = hooks.hooks?.PostToolUse;
		expect(Array.isArray(postToolUse)).toBe(true);
		// Some Codex builds emit a flat object instead of {matcher, hooks}.
		// Both shapes are acceptable as long as the matcher is empty.
		const reg = postToolUse[0];
		const matcher = "matcher" in reg ? reg.matcher : "";
		expect(matcher).toBe("");
	});

	it("creates .codex/config.toml with codex_hooks=true when absent", () => {
		// Codex requires the feature flag in `[features]` for hooks to
		// fire. The installer writes it idempotently so users don't have
		// to remember the gating step.
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const tomlPath = join(tmp, ".codex", "config.toml");
		expect(existsSync(tomlPath)).toBe(true);
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/\[features\]/);
		expect(toml).toMatch(/codex_hooks\s*=\s*true/);
	});

	it("preserves an existing config.toml that already enables codex_hooks", () => {
		// If the user (or another tool) already wrote the flag, we don't
		// rewrite the file — keeps user comments and section ordering.
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "# user-managed\n[features]\ncodex_hooks = true\nfoo = 42\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		expect(readFileSync(tomlPath, "utf-8")).toBe(existing);
	});

	it("appends [features] block to existing config.toml that lacks the flag", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing = "[model]\nname = \"synthetic-model-v5\"\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toContain("[model]");
		expect(toml).toMatch(/codex_hooks\s*=\s*true/);
	});

	it("reuses an existing [features] block when installing Codex hooks", () => {
		const tomlPath = join(tmp, ".codex", "config.toml");
		const existing =
			"[model]\nname = \"synthetic-model-v5\"\n\n[features]\nfoo = true\n[profiles.default]\napproval_policy = \"never\"\n";
		const fs = require("node:fs");
		fs.mkdirSync(join(tmp, ".codex"), { recursive: true });
		fs.writeFileSync(tomlPath, existing);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const toml = readFileSync(tomlPath, "utf-8");
		expect((toml.match(/\[features\]/g) || []).length).toBe(1);
		expect(toml).toContain("[features]\nfoo = true\ncodex_hooks = true\n[profiles.default]");
	});

	it("does not rewrite .codex/hooks.json when rerun with identical settings", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const hooksPath = join(tmp, ".codex", "hooks.json");
		const tomlPath = join(tmp, ".codex", "config.toml");
		const sentinel = new Date("2001-01-01T00:00:00.000Z");
		utimesSync(hooksPath, sentinel, sentinel);
		utimesSync(tomlPath, sentinel, sentinel);

		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		expect(statSync(hooksPath).mtimeMs).toBe(sentinel.getTime());
		expect(statSync(tomlPath).mtimeMs).toBe(sentinel.getTime());
	});

	it("removes interlinked entries on uninstall", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const changed = uninstallCodexHooks(tmp);
		expect(changed).toBe(true);

		// cleanJsonHookFile preserves the file but strips our entries —
		// so the file still exists, just without any reference to us.
		const hooksPath = join(tmp, ".codex", "hooks.json");
		const content = readFileSync(hooksPath, "utf-8");
		expect(content).not.toContain("interlinked-activity");
	});

	it("uninstall leaves config.toml untouched (avoid clobbering user config)", () => {
		installCodexHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const tomlBefore = readFileSync(join(tmp, ".codex", "config.toml"), "utf-8");
		uninstallCodexHooks(tmp);
		const tomlAfter = readFileSync(join(tmp, ".codex", "config.toml"), "utf-8");
		expect(tomlAfter).toBe(tomlBefore);
	});

	it("uninstall is a no-op when file is missing", () => {
		expect(uninstallCodexHooks(tmp)).toBe(false);
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
