// Coverage for git-session-scope-gate-resolution-helpers.ts leaf functions:
// the git status/diff shell-outs (real git repos in tmpdir(), same strategy
// as git-session-scope-gate.test.ts) and the pure flag-stripping helpers.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isCommitAllFlag,
	stagedPaths,
	statusPaths,
	statusPathsExcludingUntracked,
	stripCommitFlags,
	stripFlags,
} from "./git-session-scope-gate-resolution-helpers.js";

let repo: string;

function git(args: string[], cwd = repo): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function writeFile(rel: string, content: string): void {
	const full = join(repo, rel);
	mkdirSync(join(repo, rel, ".."), { recursive: true });
	writeFileSync(full, content);
}

function initRepo(): void {
	repo = mkdtempSync(join(tmpdir(), "git-scope-helpers-unit-"));
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	git(["commit", "--allow-empty", "-q", "-m", "initial"]);
}

beforeEach(() => {
	initRepo();
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("statusPaths — success + failure", () => {
	it("P1: returns untracked + modified paths for a real repo (must fire)", () => {
		writeFile("a.txt", "hello");
		const paths = statusPaths(repo, []);
		expect(paths).toEqual(["a.txt"]);
	});

	it("P2: scoped to a pathspec argument list (must fire)", () => {
		writeFile("a.txt", "hello");
		writeFile("b.txt", "world");
		const paths = statusPaths(repo, ["a.txt"]);
		expect(paths).toEqual(["a.txt"]);
	});

	it("N1: a non-git cwd returns [] rather than throwing (must not fire)", () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(statusPaths(nonGitDir, [])).toEqual([]);
		} finally {
			rmSync(nonGitDir, { recursive: true, force: true });
		}
	});

	it("P3: a rename shows up as a single path entry, skipping the old-path pair (must fire)", () => {
		writeFile("orig.txt", "content for rename detection padding to survive similarity index\n");
		git(["add", "orig.txt"]);
		git(["commit", "-q", "-m", "add orig"]);
		git(["mv", "orig.txt", "renamed.txt"]);
		const paths = statusPaths(repo, []);
		expect(paths).toEqual(["renamed.txt"]);
	});
});

describe("statusPathsExcludingUntracked", () => {
	it("P4: excludes untracked files but includes tracked modifications (must fire)", () => {
		writeFile("tracked.txt", "v1");
		git(["add", "tracked.txt"]);
		git(["commit", "-q", "-m", "add tracked"]);
		writeFile("tracked.txt", "v2");
		writeFile("untracked.txt", "new");
		const paths = statusPathsExcludingUntracked(repo);
		expect(paths).toEqual(["tracked.txt"]);
	});

	it("N2: a non-git cwd returns [] rather than throwing (must not fire)", () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "not-a-repo-2-"));
		try {
			expect(statusPathsExcludingUntracked(nonGitDir)).toEqual([]);
		} finally {
			rmSync(nonGitDir, { recursive: true, force: true });
		}
	});
});

describe("stagedPaths", () => {
	it("P5: returns staged file paths (must fire)", () => {
		writeFile("staged.txt", "content");
		git(["add", "staged.txt"]);
		const paths = stagedPaths(repo);
		expect(paths).toEqual(["staged.txt"]);
	});

	it("N3: a non-git cwd returns [] rather than throwing (must not fire)", () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "not-a-repo-3-"));
		try {
			expect(stagedPaths(nonGitDir)).toEqual([]);
		} finally {
			rmSync(nonGitDir, { recursive: true, force: true });
		}
	});
});

describe("isCommitAllFlag", () => {
	it("P6: -a and --all are recognized (must fire)", () => {
		expect(isCommitAllFlag("-a")).toBe(true);
		expect(isCommitAllFlag("--all")).toBe(true);
	});

	it("P7: a combined short flag containing 'a' is recognized (must fire)", () => {
		expect(isCommitAllFlag("-am")).toBe(true);
	});

	it("N4: a flag without 'a' is not recognized (must not fire)", () => {
		expect(isCommitAllFlag("-m")).toBe(false);
	});

	it("N5: a long option is never treated as combined-short (must not fire)", () => {
		expect(isCommitAllFlag("--message")).toBe(false);
	});
});

describe("stripCommitFlags", () => {
	it("P8: positional (non-flag) args pass through (must fire)", () => {
		expect(stripCommitFlags(["src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("P9: -- ends flag parsing; everything after is positional (must fire)", () => {
		expect(stripCommitFlags(["--", "-not-a-flag", "file.ts"])).toEqual([
			"-not-a-flag",
			"file.ts",
		]);
	});

	it("P10: a value-taking flag consumes its following token (must fire)", () => {
		expect(stripCommitFlags(["-m", "commit message", "file.ts"])).toEqual(["file.ts"]);
	});

	it("P11: a combined short flag with 'm' consumes the following message token (must fire)", () => {
		expect(stripCommitFlags(["-am", "commit message", "file.ts"])).toEqual(["file.ts"]);
	});

	it("N6: a self-contained --flag=value is dropped without consuming the next token (must not fire on next token)", () => {
		expect(stripCommitFlags(["--author=Test <t@example.com>", "file.ts"])).toEqual(["file.ts"]);
	});

	it("N7: an unmatched flag (not value-taking, no 'm') is dropped alone (must not fire)", () => {
		expect(stripCommitFlags(["--verbose", "file.ts"])).toEqual(["file.ts"]);
	});
});

describe("stripFlags", () => {
	it("P12: positional (non-flag) args pass through (must fire)", () => {
		expect(stripFlags(["src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("P13: -- ends flag parsing; everything after is positional (must fire)", () => {
		expect(stripFlags(["--", "-not-a-flag", "file.ts"])).toEqual(["-not-a-flag", "file.ts"]);
	});

	it("P14: a value-taking add flag consumes its following token (must fire)", () => {
		expect(stripFlags(["--chmod", "+x", "file.ts"])).toEqual(["file.ts"]);
	});

	it("N8: a self-contained --flag=value is dropped without consuming the next token (must not fire on next token)", () => {
		expect(stripFlags(["--ignore-errors=true", "file.ts"])).toEqual(["file.ts"]);
	});

	it("N9: an unmatched flag is dropped alone (must not fire)", () => {
		expect(stripFlags(["--verbose", "file.ts"])).toEqual(["file.ts"]);
	});
});
