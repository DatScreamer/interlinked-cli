import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGitBaseline } from "../session-git-baseline.js";

// `captureGitBaseline` was extracted verbatim out of session-state.ts. These
// tests pin its contract directly against the new module: non-git tolerance,
// HEAD-sha capture, and porcelain classification into modified / staged /
// untracked sets.

describe("captureGitBaseline (non-git cwd)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ilk-gitbase-nongit-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an empty baseline outside a git repo", () => {
		const b = captureGitBaseline(dir);
		expect(b.head_sha).toBe("");
		expect(b.modified.size).toBe(0);
		expect(b.staged.size).toBe(0);
		expect(b.untracked.size).toBe(0);
	});
});

describe("captureGitBaseline (real git repo)", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "ilk-gitbase-repo-"));
		const run = (args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
		run(["init", "-q"]);
		run(["config", "user.email", "test@example.com"]);
		run(["config", "user.name", "Test"]);
		writeFileSync(join(repo, "committed.ts"), "export const a = 1;\n");
		run(["add", "committed.ts"]);
		run(["commit", "-q", "-m", "initial"]);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("captures a non-empty HEAD sha on a repo with a commit", () => {
		const b = captureGitBaseline(repo);
		expect(b.head_sha).toMatch(/^[0-9a-f]{7,}$/);
	});

	it("classifies an untracked file", () => {
		writeFileSync(join(repo, "new.ts"), "export const b = 2;\n");
		const b = captureGitBaseline(repo);
		expect(b.untracked.has("new.ts")).toBe(true);
		expect(b.modified.has("new.ts")).toBe(false);
		expect(b.staged.has("new.ts")).toBe(false);
	});

	it("classifies a worktree-modified tracked file", () => {
		writeFileSync(join(repo, "committed.ts"), "export const a = 99;\n");
		const b = captureGitBaseline(repo);
		expect(b.modified.has("committed.ts")).toBe(true);
		expect(b.staged.has("committed.ts")).toBe(false);
	});

	it("classifies a staged file", () => {
		writeFileSync(join(repo, "staged.ts"), "export const c = 3;\n");
		execFileSync("git", ["add", "staged.ts"], {
			cwd: repo,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const b = captureGitBaseline(repo);
		expect(b.staged.has("staged.ts")).toBe(true);
		expect(b.untracked.has("staged.ts")).toBe(false);
	});
});

describe("captureGitBaseline (linked worktree isolation)", () => {
	let root: string;
	let main: string;
	let linked: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ilk-gitbase-worktree-"));
		main = join(root, "main");
		linked = join(root, "linked");
		mkdirSync(main);
		const runMain = (args: string[]) =>
			execFileSync("git", args, { cwd: main, stdio: ["pipe", "pipe", "pipe"] });
		runMain(["init", "-q"]);
		runMain(["config", "user.email", "test@example.com"]);
		runMain(["config", "user.name", "Test"]);
		writeFileSync(join(main, "committed.ts"), "export const value = 1;\n");
		runMain(["add", "committed.ts"]);
		runMain(["commit", "-q", "-m", "initial"]);
		runMain(["worktree", "add", "-q", "-b", "linked-test", linked]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reports only the linked checkout's HEAD and dirty files", () => {
		writeFileSync(join(main, "committed.ts"), "export const value = 2;\n");
		writeFileSync(join(main, "main-only.ts"), "export const mainOnly = true;\n");
		writeFileSync(join(linked, "committed.ts"), "export const value = 3;\n");
		writeFileSync(join(linked, "linked-only.ts"), "export const linkedOnly = true;\n");

		const baseline = captureGitBaseline(linked);
		const linkedHead = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: linked,
			encoding: "utf8",
		}).trim();

		expect(baseline.head_sha).toBe(linkedHead);
		expect([...baseline.modified]).toEqual(["committed.ts"]);
		expect([...baseline.untracked]).toEqual(["linked-only.ts"]);
		expect(baseline.staged.size).toBe(0);
		expect(baseline.modified.has("main-only.ts")).toBe(false);
		expect(baseline.untracked.has("main-only.ts")).toBe(false);
	});
});
