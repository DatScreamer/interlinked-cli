import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installHooks,
	manifestPath,
	mergeSettings,
	readManifest,
	removeJsonPath,
	uninstallHooks,
} from "./installer.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-ins-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("installHooks — project scope", () => {
	it("writes Claude Code hook settings + manifest", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
			scope: "project",
		});
		expect(result.entries.length).toBe(1);
		expect(result.entries[0].runner).toBe("claude-code");

		const claudeSettings = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"),
		) as { hooks: Record<string, unknown[]> };
		expect(Array.isArray(claudeSettings.hooks.PreToolUse)).toBe(true);

		const manifest = readManifest(manifestPath(tmp));
		expect(manifest.length).toBe(1);
		expect(manifest[0].added_paths.length).toBeGreaterThan(0);
	});

	it("appends hooks rather than replacing user-owned entries", () => {
		// User already has a hook in place
		const settingsPath = join(tmp, ".claude", "settings.json");
		const userHook = {
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "user-script.sh" }] },
				],
			},
		};
		const { mkdirSync } = require("node:fs");
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify(userHook));

		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
		});

		const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: { PreToolUse: unknown[] };
		};
		expect(after.hooks.PreToolUse.length).toBe(2);
	});

	it("supports dry-run (does not write files)", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code"],
			dryRun: true,
		});
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
		expect(existsSync(manifestPath(tmp))).toBe(false);
	});
});

describe("installHooks — multi-runner", () => {
	it("installs claude-code + copilot-cli side by side", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code", "copilot-cli"],
		});
		expect(result.entries.length).toBe(2);
		const runners = result.entries.map((e) => e.runner).sort();
		expect(runners).toEqual(["claude-code", "copilot-cli"]);
	});

	it("codex install runs the postInstall feature-flag writer", () => {
		// Codex hooks are gated by `[features] codex_hooks = true` in
		// `.codex/config.toml`. The Codex adapter's `postInstall` writes
		// that flag after the JSON merger lands the hooks fragment;
		// without it, Codex would silently ignore the hooks.json we
		// just wrote.
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
		});
		expect(result.entries.length).toBe(1);
		expect(result.entries[0].runner).toBe("codex");

		const tomlPath = join(tmp, ".codex", "config.toml");
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(tomlPath)).toBe(true);
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/codex_hooks\s*=\s*true/);
	});

	it("codex dry-run does not write the feature flag", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
			dryRun: true,
		});
		const tomlPath = join(tmp, ".codex", "config.toml");
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(tomlPath)).toBe(false);
	});
});

describe("uninstallHooks — round-trip", () => {
	it("removes exactly what install added", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook-round",
			runners: ["claude-code"],
		});
		const settings = join(tmp, ".claude", "settings.json");
		const before = readFileSync(settings, "utf-8");
		expect(before).toContain("interlinked-hook-round");

		const removal = uninstallHooks({ cwd: tmp, runners: ["claude-code"] });
		expect(removal.removed.length).toBe(1);
		expect(removal.remaining.length).toBe(0);

		const after = readFileSync(settings, "utf-8");
		expect(after).not.toContain("interlinked-hook-round");
	});

	it("does not disturb other runners", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code", "copilot-cli"],
		});
		uninstallHooks({ cwd: tmp, runners: ["claude-code"] });

		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(join(tmp, ".github", "hooks", "hooks.json"))).toBe(true);
		const manifest = readManifest(manifestPath(tmp));
		expect(manifest.length).toBe(1);
		expect(manifest[0].runner).toBe("copilot-cli");
	});
});

describe("mergeSettings — merge engine", () => {
	it("appends array items and records their paths", () => {
		const target: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: "X" }] } };
		const added: string[] = [];
		mergeSettings(
			target,
			{ hooks: { PreToolUse: [{ matcher: "Y" }] } },
			"array-append",
			"",
			added,
		);
		const pre = (target as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse;
		expect(pre.length).toBe(2);
		expect(added[0]).toBe("hooks.PreToolUse[1]");
	});

	it("does not overwrite existing scalars", () => {
		const target: Record<string, unknown> = { log_level: "info" };
		const added: string[] = [];
		mergeSettings(target, { log_level: "debug", extra: 1 }, "deep-merge", "", added);
		expect(target.log_level).toBe("info");
		expect(target.extra).toBe(1);
		expect(added).toEqual(["extra"]);
	});
});

describe("removeJsonPath — targeted removal", () => {
	it("removes an array element by index", () => {
		const obj = { a: { b: [10, 20, 30] } };
		expect(removeJsonPath(obj, "a.b[1]")).toBe(true);
		expect(obj.a.b).toEqual([10, 30]);
	});

	it("removes an object key", () => {
		const obj: { a: { b?: number; c: number } } = { a: { b: 1, c: 2 } };
		expect(removeJsonPath(obj, "a.b")).toBe(true);
		expect(obj.a).toEqual({ c: 2 });
	});

	it("returns false for missing paths", () => {
		expect(removeJsonPath({ a: 1 }, "b.c")).toBe(false);
	});
});
