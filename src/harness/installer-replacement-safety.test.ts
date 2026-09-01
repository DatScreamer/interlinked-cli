import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHooks, manifestPath, readManifest } from "./installer.js";

describe("installHooks — failed replacement preserves a working prior install", () => {
	let cwd = "";
	let home = "";

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "interlinked-installer-replacement-"));
		home = mkdtempSync(join(tmpdir(), "interlinked-installer-home-"));
		vi.stubEnv("HOME", home);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	// test-contract: bug — a selected project install that cannot parse its
	// target did not replace anything, so it must not run the cross-scope purge
	// against the working user install or discard that install's manifest row.
	it("preserves a user Claude hook and manifest when project settings are malformed", () => {
		const binaryPath = join(cwd, "dist", "hook-entry.js");
		const initial = installHooks({
			cwd,
			binaryPath,
			runners: ["claude-code"],
			scope: "user",
		});
		expect(initial.ok).toBe(true);

		const userSettings = join(home, ".claude", "settings.json");
		const userBefore = readFileSync(userSettings, "utf-8");
		const manifestBefore = readFileSync(manifestPath(cwd), "utf-8");
		const projectSettings = join(cwd, ".claude", "settings.json");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		writeFileSync(projectSettings, "{ malformed project settings");

		const attempted = installHooks({
			cwd,
			binaryPath,
			runners: ["claude-code"],
			scope: "project",
		});

		expect(attempted.entries).toEqual([]);
		expect(attempted.skipped[0]?.reason).toContain("malformed JSON");
		expect(attempted.orphans_cleaned).toEqual([]);
		expect(readFileSync(userSettings, "utf-8")).toBe(userBefore);
		expect(readFileSync(manifestPath(cwd), "utf-8")).toBe(manifestBefore);
		expect(readFileSync(projectSettings, "utf-8")).toBe("{ malformed project settings");
	});

	// test-contract: invariant — a semantically failed Codex replacement must
	// report the attempted failure while restoring its just-written fragment;
	// the one-row-per-runner manifest continues to own the prior working hook.
	it("restores a failed Codex replacement and retains the functional user install", () => {
		const priorBinary = join(cwd, "dist", "hook-entry.js");
		const initial = installHooks({
			cwd,
			binaryPath: priorBinary,
			runners: ["codex"],
			scope: "user",
		});
		expect(initial.ok).toBe(true);

		const userHooks = join(home, ".codex", "hooks.json");
		const userConfig = join(home, ".codex", "config.toml");
		const hooksBefore = readFileSync(userHooks, "utf-8");
		const configBefore = readFileSync(userConfig, "utf-8");
		const manifestBefore = readFileSync(manifestPath(cwd), "utf-8");
		const projectConfig = join(cwd, ".codex", "config.toml");
		mkdirSync(join(cwd, ".codex"), { recursive: true });
		const poisoned = "[features]\nhooks = false\n\n[features]\nother = true\n";
		writeFileSync(projectConfig, poisoned);
		const projectHooks = join(cwd, ".codex", "hooks.json");
		const unrelatedProjectHooks = '{"hooks":{"Notification":[{"command":"user-hook"}]}}\n';
		writeFileSync(projectHooks, unrelatedProjectHooks);
		chmodSync(projectHooks, 0o600);

		const attempted = installHooks({
			cwd,
			binaryPath: join(cwd, "next", "hook-entry.js"),
			runners: ["codex"],
			scope: "project",
		});

		expect({
			ok: attempted.ok,
			failureRunner: attempted.post_install_failures[0]?.runner,
			failureReason: attempted.post_install_failures[0]?.reason,
			orphansCleaned: attempted.orphans_cleaned,
		}).toEqual({
			ok: false,
			failureRunner: "codex",
			failureReason: expect.stringContaining("duplicate [features]"),
			orphansCleaned: [],
		});
		expect({
			projectHooks: readFileSync(projectHooks, "utf-8"),
			projectHooksMode: statSync(projectHooks).mode & 0o777,
			projectConfig: readFileSync(projectConfig, "utf-8"),
			userHooks: readFileSync(userHooks, "utf-8"),
			userConfig: readFileSync(userConfig, "utf-8"),
			manifest: readFileSync(manifestPath(cwd), "utf-8"),
		}).toEqual({
			projectHooks: unrelatedProjectHooks,
			projectHooksMode: 0o600,
			projectConfig: poisoned,
			userHooks: hooksBefore,
			userConfig: configBefore,
			manifest: manifestBefore,
		});
		expect(readManifest(manifestPath(cwd))).toMatchObject([
			{ runner: "codex", scope: "user", post_install: "ok", binary_path: priorBinary },
		]);
	});
});
