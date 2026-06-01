import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_HOOK_EVENTS, installAllClaudeHooks } from "../hook-installers-claude.js";

describe("Claude hook event list", () => {
	it("includes PostToolUse and SessionStart", () => {
		expect(CLAUDE_HOOK_EVENTS).toContain("SessionStart");
		expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUse");
		// PostToolUseFailure is intentionally omitted (see comment on CLAUDE_HOOK_EVENTS).
		expect(CLAUDE_HOOK_EVENTS).not.toContain("PostToolUseFailure");
	});
});

// ===========================================
// Matcher Reconciliation — Claude Code
// ===========================================
// installHookEntry must update stale PostToolUse matchers to "" (all-tool
// capture) when re-running installation. Without this, non-edit tools
// (Read, Bash, Grep, WebFetch) never reach the hook at PostToolUse.

describe("matcher reconciliation — Claude Code", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "matcher-reconcile-"));
		execSync("git init", { cwd: tmp, stdio: "ignore" });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("rewrites stale PostToolUse matcher from Edit|Write|MultiEdit to empty", () => {
		const settingsDir = join(tmp, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		const staleMatcher = "Edit|Write|MultiEdit";
		const staleSettings = {
			hooks: {
				PostToolUse: [
					{
						matcher: staleMatcher,
						hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
					},
				],
			},
		};
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(staleSettings, null, 2));

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const updated = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf-8"));
		const postToolUse = updated.hooks.PostToolUse;
		expect(Array.isArray(postToolUse)).toBe(true);
		expect(postToolUse).toHaveLength(1);
		expect(postToolUse[0].matcher).toBe("");
	});

	it("leaves PreToolUse matcher as empty (no scoped restriction)", () => {
		const settingsDir = join(tmp, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "",
							hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
						},
					],
				},
			}),
		);

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");

		const updated = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf-8"));
		expect(updated.hooks.PreToolUse[0].matcher).toBe("");
	});

	it("does not regress PostToolUse matcher back to mutation-only", () => {
		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const first = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(first.hooks.PostToolUse[0].matcher).toBe("");

		installAllClaudeHooks(tmp, ".interlinked/hooks/interlinked-activity.mjs");
		const second = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(second.hooks.PostToolUse[0].matcher).toBe("");
	});
});
