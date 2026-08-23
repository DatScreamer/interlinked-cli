import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GUARD_CACHE_FILE,
	getGuardHookStatus,
	installGuardHook,
	uninstallGuardHook,
} from "./guard-hooks.js";

let gitRoot: string;

beforeEach(() => {
	gitRoot = mkdtempSync(join(tmpdir(), "guard-hooks-w55-"));
	execSync("git init -q", { cwd: gitRoot, stdio: ["pipe", "pipe", "pipe"] });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(gitRoot, { recursive: true, force: true });
});

describe("GUARD_CACHE_FILE constant", () => {
	it("is exactly guard-cache.json", () => {
		expect(GUARD_CACHE_FILE).toBe("guard-cache.json");
	});
});

describe("resolveHooksDir — core.hooksPath respected (kills string/block/array/method/object mutants)", () => {
	it("installs into the custom hooksPath directory, not .git/hooks", () => {
		execSync("git config core.hooksPath custom-hooks-dir", {
			cwd: gitRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const result = installGuardHook(gitRoot, "pre-commit");
		expect(result.installed).toBe(true);

		// The hook must land in the exact custom directory named by git config,
		// with no trailing whitespace/newline (proves .trim() ran) and proves
		// the execSync call actually executed and returned real output (proves
		// the command string, options object, encoding, and stdio array were
		// all intact — any of those being blanked/emptied causes execSync to
		// throw, which is caught and falls back to the .git/hooks default).
		const customHookPath = join(gitRoot, "custom-hooks-dir", "pre-commit");
		expect(existsSync(customHookPath)).toBe(true);

		// Falling back to default would place it here instead — must NOT happen.
		const defaultHookPath = join(gitRoot, ".git", "hooks", "pre-commit");
		expect(existsSync(defaultHookPath)).toBe(false);
	});

	it("getGuardHookStatus also resolves through the custom hooksPath", () => {
		execSync("git config core.hooksPath other-hooks", {
			cwd: gitRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
		installGuardHook(gitRoot, "pre-push");

		const status = getGuardHookStatus(gitRoot);
		expect(status.pre_push).toBe(true);
		expect(existsSync(join(gitRoot, "other-hooks", "pre-push"))).toBe(true);
	});
});

describe("generateGuardScript branch (via installGuardHook content) — kills conditional/equality/string mutants", () => {
	it("pre-commit hook script uses staged-files diff, not push diff", () => {
		installGuardHook(gitRoot, "pre-commit");
		const content = readFileSync(
			join(gitRoot, ".git", "hooks", "pre-commit"),
			"utf-8",
		);
		expect(content).toContain("git diff --cached --name-only");
		expect(content).not.toContain("@{push}");
	});

	it("pre-push hook script uses push diff, not staged-files diff", () => {
		installGuardHook(gitRoot, "pre-push");
		const content = readFileSync(
			join(gitRoot, ".git", "hooks", "pre-push"),
			"utf-8",
		);
		expect(content).toContain("@{push}");
		expect(content).not.toContain("git diff --cached --name-only");
	});
});

describe("installGuardHook — wrapper script generation when a foreign hook exists", () => {
	it("wraps the existing hook and embeds exactly one shebang line, in the right place", () => {
		const hooksDir = join(gitRoot, ".git", "hooks");
		const hookPath = join(hooksDir, "pre-commit");
		fs.writeFileSync(hookPath, "#!/bin/sh\necho existing-hook\n");
		fs.chmodSync(hookPath, 0o755);

		const result = installGuardHook(gitRoot, "pre-commit");
		expect(result.installed).toBe(true);
		expect(result.backed_up).toBeDefined();

		const content = readFileSync(hookPath, "utf-8");

		// Exactly one shebang line — proves .slice(1) dropped the guard
		// script's own leading "#!/bin/sh" before splicing it into the wrapper.
		const shebangCount = (content.match(/#!\/bin\/sh/g) ?? []).length;
		expect(shebangCount).toBe(1);
		expect(content.indexOf("#!/bin/sh")).toBe(0);

		// Proves the split("\n") / join("\n") pair stayed intact — if either
		// literal is blanked, multi-char tokens get shredded onto separate
		// lines and this substring no longer appears intact.
		expect(content).toContain("INTERLINKED_BIN");
		expect(content).toContain("Run Interlinked guard");

		// Original hook must still be reachable via the backup path.
		expect(existsSync(join(hooksDir, "pre-commit.interlinked-orig"))).toBe(
			true,
		);
	});
});

describe("uninstallGuardHook — backup-restore branch", () => {
	it("succeeds without throwing when there is no backup to restore", () => {
		installGuardHook(gitRoot, "pre-commit");

		const result = uninstallGuardHook(gitRoot, "pre-commit");
		expect(result.removed).toBe(true);
		expect(result.restored).toBeUndefined();
		expect(
			existsSync(join(gitRoot, ".git", "hooks", "pre-commit")),
		).toBe(false);
	});

	it("restores the original hook when a backup exists", () => {
		const hooksDir = join(gitRoot, ".git", "hooks");
		const hookPath = join(hooksDir, "pre-commit");
		fs.writeFileSync(hookPath, "#!/bin/sh\necho original\n");
		fs.chmodSync(hookPath, 0o755);
		installGuardHook(gitRoot, "pre-commit");

		const result = uninstallGuardHook(gitRoot, "pre-commit");
		expect(result.removed).toBe(true);
		expect(result.restored).toBe(hookPath);
		expect(readFileSync(hookPath, "utf-8")).toContain("echo original");
	});
});

describe("getGuardHookStatus — per-hook-type string literals", () => {
	it("reports pre_commit true only when a pre-commit guard hook is installed", () => {
		installGuardHook(gitRoot, "pre-commit");
		const status = getGuardHookStatus(gitRoot);
		expect(status.pre_commit).toBe(true);
		expect(status.pre_push).toBe(false);
	});

	it("reports pre_push true only when a pre-push guard hook is installed", () => {
		installGuardHook(gitRoot, "pre-push");
		const status = getGuardHookStatus(gitRoot);
		expect(status.pre_push).toBe(true);
		expect(status.pre_commit).toBe(false);
	});
});
