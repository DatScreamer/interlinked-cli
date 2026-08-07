import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
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
		expect(nonNull(result.entries[0]).runner).toBe("claude-code");

		const claudeSettings = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"),
		) as { hooks: Record<string, unknown[]> };
		expect(Array.isArray(claudeSettings.hooks.PreToolUse)).toBe(true);

		const manifest = readManifest(manifestPath(tmp));
		expect(manifest.length).toBe(1);
		expect(nonNull(manifest[0]).added_paths.length).toBeGreaterThan(0);
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
		// Codex hooks are gated by `[features] hooks = true` in
		// `.codex/config.toml` (legacy `codex_hooks` key still recognized
		// but emits a deprecation warning). The Codex adapter's
		// `postInstall` writes the canonical flag after the JSON merger
		// lands the hooks fragment; without it, Codex would silently
		// ignore the hooks.json we just wrote.
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
		});
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("codex");

		const tomlPath = join(tmp, ".codex", "config.toml");
		const { existsSync } = require("node:fs") as { existsSync(p: string): boolean };
		expect(existsSync(tomlPath)).toBe(true);
		const toml = readFileSync(tomlPath, "utf-8");
		expect(toml).toMatch(/(?<![\w$])hooks\s*=\s*true/);
		expect(toml).not.toMatch(/\bcodex_hooks\s*=\s*true/);
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
		expect(nonNull(manifest[0]).runner).toBe("copilot-cli");
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

describe("installHooks — skips a runner whose settings file is malformed JSON", () => {
	it("reports the runner as skipped instead of clobbering the file", () => {
		const settingsPath = join(tmp, ".claude", "settings.json");
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(settingsPath, "{ not valid json");

		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
		});

		expect(result.entries).toEqual([]);
		expect(result.skipped.length).toBe(1);
		expect(nonNull(result.skipped[0]).runner).toBe("claude-code");
		expect(nonNull(result.skipped[0]).reason).toContain("malformed JSON");
		// The unreadable file is left untouched, not overwritten.
		expect(readFileSync(settingsPath, "utf-8")).toBe("{ not valid json");
	});
});

describe("installHooks — postInstall failure does not fail the install", () => {
	it("codex postInstall error is caught and the JSON-fragment entry still lands", () => {
		// `.codex/config.toml` exists as a DIRECTORY (not a file), so
		// `ensureCodexFeatureFlag`'s `readFileSync(tomlPath, ...)` throws
		// EISDIR — exercising the postInstall try/catch. `.codex/hooks.json`
		// (a different filename in the same, real, directory) still writes
		// fine, so the JSON-fragment install itself succeeds.
		mkdirSync(join(tmp, ".codex", "config.toml"), { recursive: true });

		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["codex"],
		});

		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("codex");
	});
});

describe("installHooks — cross-scope stale cleanup keeps unrelated entries", () => {
	let homeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("removes only this project's user-scope entry, leaving a third-party hook in the array", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		const projectOwnedCommand =
			`if test -f '${binaryPath}' ; then node '${binaryPath}' --runner 'claude-code' --event 'UserPromptSubmit' ; fi`;
		const userClaudeSettings = join(homeDir, ".claude", "settings.json");
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		writeFileSync(
			userClaudeSettings,
			JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{ matcher: "", hooks: [{ type: "command", command: projectOwnedCommand }] },
						{ matcher: "", hooks: [{ type: "command", command: "echo third-party-hook" }] },
					],
				},
			}),
		);

		// A project-scope install triggers the unconditional cross-scope
		// cleanup (scope !== "user") against the shared user-scope file.
		installHooks({ cwd: tmp, binaryPath, runners: ["claude-code"] });

		const after = JSON.parse(readFileSync(userClaudeSettings, "utf-8")) as {
			hooks: { UserPromptSubmit: Array<{ hooks?: Array<{ command?: string }> }> };
		};
		expect(after.hooks.UserPromptSubmit.length).toBe(1);
		expect(after.hooks.UserPromptSubmit[0]?.hooks?.[0]?.command).toBe("echo third-party-hook");
	});
});

describe("installHooks — scope switch cleans the stale manifest entry", () => {
	let homeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home2-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("project→user switch purges the manifest-recorded project file via the stale-install loop", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		installHooks({ cwd: tmp, binaryPath, runners: ["claude-code"], scope: "project" });
		const projectSettings = join(tmp, ".claude", "settings.json");
		expect(readFileSync(projectSettings, "utf-8")).toContain("hook-entry.js");

		const result = installHooks({
			cwd: tmp,
			binaryPath,
			runners: ["claude-code"],
			scope: "user",
		});

		// The manifest-driven stale-install loop (selectedIds has the runner,
		// newFiles does NOT contain the old project file) purged it.
		expect(result.orphans_cleaned).toContain(projectSettings);
		const after = JSON.parse(readFileSync(projectSettings, "utf-8")) as {
			hooks?: Record<string, unknown[]>;
		};
		expect(after.hooks ?? {}).toEqual({});
	});

	it("codex postInstall runs against homedir at user scope (ternary true branch)", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		const result = installHooks({
			cwd: tmp,
			binaryPath,
			runners: ["codex"],
			scope: "user",
		});
		expect(result.entries.length).toBe(1);
		const tomlPath = join(homeDir, ".codex", "config.toml");
		expect(readFileSync(tomlPath, "utf-8")).toMatch(/hooks\s*=\s*true/);
	});
});

describe("installHooks — selectAdapters skips an unrecognized runner id", () => {
	it("installs the known runner and silently drops the unmatched one (getAdapter returns null)", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			// "unknown" is a real RunnerId value but has no registered adapter —
			// exercises selectAdapters' `if (a) out.push(a)` false arm.
			runners: ["claude-code", "unknown"],
		});
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("claude-code");
		expect(result.skipped).toEqual([]);
	});
});

describe("installHooks — stale-install loop: mixed selected/non-selected prior runners", () => {
	it("cleans the reinstalled runner's old file but leaves the non-reinstalled runner's manifest entry untouched", () => {
		// Round 1: install both runners at project scope. Binary path must
		// contain an Interlinked marker (see hook-ownership.ts) so the
		// orphan-cleanup verdict recognizes these entries as ours.
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code", "copilot-cli"],
			scope: "project",
		});

		// Round 2: reinstall ONLY claude-code, switching its scope so its old
		// project-scope file becomes stale (newFiles won't contain it).
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home3-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			// claude-code's old project file was selected + orphaned => cleaned
			// (L135 false arm: selectedIds.has("claude-code") === true).
			const oldClaudeSettings = join(tmp, ".claude", "settings.json");
			expect(result.orphans_cleaned).toContain(oldClaudeSettings);

			// copilot-cli was NOT selected this round, so the stale-install loop
			// skips it entirely (L135 true arm: `continue`) — its manifest entry
			// survives untouched.
			const manifest = readManifest(manifestPath(tmp));
			const copilot = manifest.find((e) => e.runner === "copilot-cli");
			expect(copilot).toBeDefined();
			expect(nonNull(copilot).settings_path).toBe(join(tmp, ".github", "hooks", "hooks.json"));
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("does not record an orphan when the stale prior settings file was already deleted", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home4-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			// Manually delete the settings file the prior install wrote, so the
			// orphan-cleanup pass for it finds nothing to remove.
			rmSync(join(tmp, ".claude", "settings.json"));

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			// cleanProjectOwnedHooks returns 0 (existsSync false) => `removed > 0`
			// is false => orphans_cleaned must NOT contain the vanished path.
			expect(result.orphans_cleaned).toEqual([]);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("skips (does not throw on) a stale settings file containing malformed JSON", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home5-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			const staleSettings = join(tmp, ".claude", "settings.json");
			writeFileSync(staleSettings, "{ not valid json");

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			// cleanProjectOwnedHooks's `readJson` returns null for malformed JSON
			// => early `return 0` => left untouched, not counted as an orphan.
			expect(result.orphans_cleaned).toEqual([]);
			expect(readFileSync(staleSettings, "utf-8")).toBe("{ not valid json");
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("skips a non-array value under a hook event key without crashing", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home6-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			const staleSettings = join(tmp, ".claude", "settings.json");
			const before = JSON.parse(readFileSync(staleSettings, "utf-8")) as {
				hooks: Record<string, unknown>;
			};
			// Inject a malformed sibling key alongside the real (array) hook
			// arrays — exercises the `!Array.isArray(arr)` continue branch.
			before.hooks.SomeMalformedKey = "not-an-array";
			writeFileSync(staleSettings, JSON.stringify(before));

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
			});
			expect(result.orphans_cleaned).toContain(staleSettings);
			const after = JSON.parse(readFileSync(staleSettings, "utf-8")) as {
				hooks?: Record<string, unknown>;
			};
			// The malformed key survives (never touched); the real hook arrays
			// were emptied and their event keys dropped, leaving only the junk
			// key — this pins that the malformed-value branch doesn't crash or
			// silently drop unrelated keys.
			expect(after.hooks).toEqual({ SomeMalformedKey: "not-an-array" });
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("dry-run scope switch computes orphans but does not write the stale file", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "interlinked-ins-home7-"));
		const originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		try {
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "project",
			});
			const staleSettings = join(tmp, ".claude", "settings.json");
			const before = readFileSync(staleSettings, "utf-8");

			const result = installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
				scope: "user",
				dryRun: true,
			});
			// removed > 0 is still computed (in-memory), so it's reported...
			expect(result.orphans_cleaned).toContain(staleSettings);
			// ...but dryRun suppresses the actual write.
			expect(readFileSync(staleSettings, "utf-8")).toBe(before);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});

describe("uninstallHooks — settings file already gone", () => {
	it("removeEntry no-ops instead of throwing when the settings file no longer exists", () => {
		installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/hook",
			runners: ["claude-code"],
		});
		rmSync(join(tmp, ".claude", "settings.json"));

		const result = uninstallHooks({ cwd: tmp, runners: ["claude-code"] });
		// Still reported as removed (manifest entry dropped) even though the
		// underlying file write was a no-op.
		expect(result.removed.length).toBe(1);
		expect(result.remaining.length).toBe(0);
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});
});

describe("readManifest — malformed manifest content", () => {
	it("returns [] for a manifest file containing invalid JSON", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "installer-manifest.json"), "{ not json");
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	it("returns [] when the manifest's top level parses to a non-object (e.g. a bare number)", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "installer-manifest.json"), "42");
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	it("returns [] when `entries` is missing or not an array", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "installer-manifest.json"),
			JSON.stringify({ schema_version: "1" }),
		);
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	it("filters out malformed rows and coerces missing optional fields to defaults", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "installer-manifest.json"),
			JSON.stringify({
				schema_version: "1",
				entries: [
					null, // not an object => dropped
					"a string row", // not an object => dropped
					{ runner: "claude-code" }, // missing settings_path => dropped
					{ runner: "claude-code", settings_path: "/x" }, // missing added_paths array => dropped
					{
						// valid minimal row: binary_path/installed_at omitted => defaulted to ""
						runner: "claude-code",
						settings_path: "/valid/settings.json",
						added_paths: ["hooks.PreToolUse[0]"],
					},
				],
			}),
		);
		const manifest = readManifest(manifestPath(tmp));
		expect(manifest).toEqual([
			{
				runner: "claude-code",
				scope: "project",
				settings_path: "/valid/settings.json",
				added_paths: ["hooks.PreToolUse[0]"],
				binary_path: "",
				installed_at: "",
				schema_version: "1",
			},
		]);
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
