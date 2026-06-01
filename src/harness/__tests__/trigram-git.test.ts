import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChangedFilesSince, getHeadCommit, getTrackedFiles } from "../trigram-git.js";

// Companion tests for the git/file-discovery helpers, importing the SUT
// directly. These exercise the real `git` CLI against throwaway repos and the
// non-git fallback path.

function git(cwd: string, args: string): void {
	execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

function initRepo(cwd: string): void {
	git(cwd, "init -q");
	git(cwd, "config user.email test@example.com");
	git(cwd, "config user.name Test");
	git(cwd, "config commit.gpgsign false");
}

describe("getTrackedFiles", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trigram-git-tracked-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists git-tracked files", () => {
		initRepo(dir);
		writeFileSync(join(dir, "a.ts"), "export const a = 1;");
		writeFileSync(join(dir, "b.ts"), "export const b = 2;");
		git(dir, "add -A");
		git(dir, "commit -q -m init");

		const files = getTrackedFiles(dir).sort();
		expect(files).toContain("a.ts");
		expect(files).toContain("b.ts");
	});

	it("includes untracked .interlinked/hooks/ files", () => {
		initRepo(dir);
		writeFileSync(join(dir, "src.ts"), "export const x = 1;");
		git(dir, "add -A");
		git(dir, "commit -q -m init");

		// Create an untracked hooks file (gitignored in real repos, but here it's
		// simply not added — git ls-files --others should surface it).
		execSync("mkdir -p .interlinked/hooks", { cwd: dir });
		writeFileSync(join(dir, ".interlinked/hooks/interlinked-activity.mjs"), "// hook");

		const files = getTrackedFiles(dir);
		expect(files).toContain(".interlinked/hooks/interlinked-activity.mjs");
	});

	it("falls back to a filesystem walk when not a git repo", () => {
		// No `git init` — getTrackedFiles must walk the directory tree instead.
		writeFileSync(join(dir, "loose.ts"), "export const loose = 1;");
		const files = getTrackedFiles(dir);
		expect(files).toContain("loose.ts");
	});

	it("fallback walk skips dotfiles and node_modules", () => {
		writeFileSync(join(dir, "keep.ts"), "keep");
		writeFileSync(join(dir, ".hidden"), "hidden");
		execSync("mkdir -p node_modules/pkg", { cwd: dir });
		writeFileSync(join(dir, "node_modules/pkg/index.js"), "ignored");

		const files = getTrackedFiles(dir);
		expect(files).toContain("keep.ts");
		expect(files).not.toContain(".hidden");
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
	});
});

describe("getHeadCommit", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trigram-git-head-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the current HEAD sha", () => {
		initRepo(dir);
		writeFileSync(join(dir, "f.ts"), "1");
		git(dir, "add -A");
		git(dir, "commit -q -m init");

		const head = getHeadCommit(dir);
		const expected = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		expect(head).toBe(expected);
		expect(head).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns 'unknown' outside a git repo", () => {
		expect(getHeadCommit(dir)).toBe("unknown");
	});
});

describe("getChangedFilesSince", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trigram-git-diff-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists files changed between a base commit and HEAD", () => {
		initRepo(dir);
		writeFileSync(join(dir, "a.ts"), "1");
		writeFileSync(join(dir, "b.ts"), "1");
		git(dir, "add -A");
		git(dir, "commit -q -m init");
		const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();

		writeFileSync(join(dir, "a.ts"), "2"); // modify
		writeFileSync(join(dir, "c.ts"), "1"); // add
		git(dir, "add -A");
		git(dir, "commit -q -m change");

		const changed = getChangedFilesSince(dir, base)?.sort();
		expect(changed).toEqual(["a.ts", "c.ts"]);
	});

	it("returns an empty array when nothing changed since base", () => {
		initRepo(dir);
		writeFileSync(join(dir, "a.ts"), "1");
		git(dir, "add -A");
		git(dir, "commit -q -m init");
		const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();

		expect(getChangedFilesSince(dir, base)).toEqual([]);
	});

	it("returns null when the diff fails (e.g., unknown base commit)", () => {
		initRepo(dir);
		writeFileSync(join(dir, "a.ts"), "1");
		git(dir, "add -A");
		git(dir, "commit -q -m init");

		// A bogus base sha makes `git diff` fail → null (caller does a full rebuild).
		expect(getChangedFilesSince(dir, "0".repeat(40))).toBeNull();
	});
});
