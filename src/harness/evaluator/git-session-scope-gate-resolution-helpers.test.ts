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

	// test-contract: public-api — git-status(1) documents indexStatus "C"
	// (copied) as reachable when status.renames=copies; parsePorcelainPaths'
	// rename/copy branch must recognize it and skip the stub old-path entry
	// that follows, exactly as it does for plain renames.
	it("P15: a git-detected copy (status.renames=copies) is treated like a rename, skipping the stub old-path entry (must fire)", () => {
		const longContent =
			"padding padding padding padding padding padding padding padding to pass the similarity threshold\n";
		writeFile("orig.txt", longContent);
		git(["add", "orig.txt"]);
		git(["commit", "-q", "-m", "add orig"]);
		git(["config", "status.renames", "copies"]);
		writeFile("copy.txt", longContent);
		writeFile("orig.txt", `${longContent}extra trailing line\n`);
		git(["add", "orig.txt", "copy.txt"]);
		const paths = statusPaths(repo, []);
		expect(paths).toEqual(["copy.txt", "orig.txt"]);
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

	// test-contract: public-api — stagedPaths trims each `git diff --cached
	// --name-only` line before returning it; a path with incidental leading
	// whitespace (git prints filenames byte-for-byte, untrimmed) must come
	// back trimmed.
	it("P16: a staged path with incidental surrounding whitespace is trimmed (must fire)", () => {
		writeFile(" leading-space.txt", "content");
		git(["add", " leading-space.txt"]);
		const paths = stagedPaths(repo);
		expect(paths).toEqual(["leading-space.txt"]);
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

	// test-contract: boundary — the empty string starts with no dash and must
	// never satisfy either isCommitAllFlag branch.
	it("N10: an empty string is never treated as the commit-all flag (must not fire)", () => {
		expect(isCommitAllFlag("")).toBe(false);
	});

	// test-contract: boundary — the combined-short-flag regex must anchor to
	// the end of the token; a trailing non-letter character must reject it.
	it("N11: a combined-flag-shaped token with a trailing non-letter is rejected (must not fire)", () => {
		expect(isCommitAllFlag("-a9")).toBe(false);
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

	// test-contract: public-api — every value-taking `git commit` flag other
	// than "-m" (which the combined-short-flag fallback below also
	// recognizes, independent of set membership) must consume exactly its
	// following token; git-commit(1) defines this set of value-taking forms.
	it("P17: each value-taking commit flag (other than -m) consumes its following token (must fire)", () => {
		const valueTakingFlags = [
			"--message",
			"-F",
			"--file",
			"-c",
			"--reedit-message",
			"-C",
			"--reuse-message",
			"--fixup",
			"--squash",
			"--author",
			"--date",
			"-t",
			"--template",
			"--cleanup",
			"--gpg-sign",
			"-S",
			"--trailer",
		];
		for (const flag of valueTakingFlags) {
			expect(stripCommitFlags([flag, "VALUE_TOKEN", "file.ts"])).toEqual(["file.ts"]);
		}
	});

	// test-contract: boundary — the combined-short-flag fallback only fires
	// for tokens containing 'm'; a short flag without 'm' must not consume
	// the next token even though it matches the combined-short-flag shape.
	it("N12: a short flag without 'm' does not consume the next token (must not fire)", () => {
		expect(stripCommitFlags(["-x", "next", "file.ts"])).toEqual(["next", "file.ts"]);
	});

	// test-contract: boundary — the combined-short-flag regex must anchor to
	// the start of the token; an interior dash-letter run must not qualify.
	it("N13: a token with an interior dash-letter run is not treated as a combined short flag (must not fire)", () => {
		expect(stripCommitFlags(["-a-bm", "next", "file.ts"])).toEqual(["next", "file.ts"]);
	});

	// test-contract: boundary — the combined-short-flag regex must anchor to
	// the end of the token; a trailing non-letter character must reject it.
	it("N14: a token with a trailing non-letter is not treated as a combined short flag (must not fire)", () => {
		expect(stripCommitFlags(["-am1", "next", "file.ts"])).toEqual(["next", "file.ts"]);
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

	// test-contract: public-api — `git add --pathspec-from-file <file>` takes
	// a value; stripFlags must drop both the flag and its file argument.
	it("P18: --pathspec-from-file (a value-taking add flag) consumes its following token (must fire)", () => {
		expect(stripFlags(["--pathspec-from-file", "list.txt", "file.ts"])).toEqual(["file.ts"]);
	});
});
