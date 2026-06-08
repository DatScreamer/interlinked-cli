import { describe, expect, it } from "vitest";
import { parseGitCommit } from "./commit-parse.js";

describe("parseGitCommit", () => {
	it("detects `git commit -m x`", () => {
		expect(parseGitCommit('git commit -m "fix"')).toEqual({ isCommit: true, noVerify: false });
	});

	it("detects `git commit -am x` and `git commit --amend`", () => {
		expect(parseGitCommit('git commit -am "wip"')?.isCommit).toBe(true);
		expect(parseGitCommit("git commit --amend")?.isCommit).toBe(true);
	});

	it("detects `git commit` with no flags (bare staged commit)", () => {
		expect(parseGitCommit("git commit")?.isCommit).toBe(true);
	});

	it("detects a commit in a compound command (cd x && git commit -m y)", () => {
		expect(parseGitCommit('cd repo && git commit -m "x"')?.isCommit).toBe(true);
	});

	it("detects a commit piped/sequenced after another command", () => {
		expect(parseGitCommit('git add -A; git commit -m "x"')?.isCommit).toBe(true);
		expect(parseGitCommit('echo hi || git commit -m "x"')?.isCommit).toBe(true);
	});

	it("detects commit after a `git -C dir` / `-c key=val` global flag run", () => {
		expect(parseGitCommit("git -C /repo commit -m x")?.isCommit).toBe(true);
		expect(parseGitCommit("git -c user.name=x commit -m y")?.isCommit).toBe(true);
		expect(parseGitCommit("git --no-pager commit -m y")?.isCommit).toBe(true);
	});

	it("detects commit through a leading sudo / env / VAR= prefix", () => {
		expect(parseGitCommit("sudo git commit -m x")?.isCommit).toBe(true);
		expect(parseGitCommit("GIT_AUTHOR_NAME=x git commit -m y")?.isCommit).toBe(true);
		expect(parseGitCommit("env FOO=bar git commit -m z")?.isCommit).toBe(true);
	});

	it("detects commit via an absolute git path (/usr/bin/git)", () => {
		expect(parseGitCommit("/usr/bin/git commit -m x")?.isCommit).toBe(true);
	});

	it("flags --no-verify (and -n) as a bypass", () => {
		expect(parseGitCommit("git commit -m x --no-verify")).toEqual({
			isCommit: true,
			noVerify: true,
		});
		expect(parseGitCommit("git commit -n -m x")?.noVerify).toBe(true);
	});

	it("does NOT treat the message text as a bypass when it contains --no-verify", () => {
		// The `--no-verify` lives inside the quoted message, not as a flag.
		expect(parseGitCommit('git commit -m "mention --no-verify in msg"')?.noVerify).toBe(false);
	});

	it("does NOT split on a `&&` inside the quoted commit message", () => {
		// If the splitter naively broke on `&&`, the segment after it would be
		// `b"` (not a git commit) — but the whole `git commit -m "a && b"` is one.
		const parsed = parseGitCommit('git commit -m "feat: a && b"');
		expect(parsed?.isCommit).toBe(true);
		expect(parsed?.noVerify).toBe(false);
	});

	it("ignores non-commit git verbs (status / log / diff / show)", () => {
		expect(parseGitCommit("git status")).toBeNull();
		expect(parseGitCommit("git log --oneline")).toBeNull();
		expect(parseGitCommit("git diff HEAD")).toBeNull();
		expect(parseGitCommit("git show")).toBeNull();
	});

	it("ignores a `# git commit` comment and non-git binaries", () => {
		expect(parseGitCommit("# git commit -m x")).toBeNull();
		expect(parseGitCommit("echo git commit")).toBeNull();
	});

	it("does not false-positive on `git commit-graph` (exact subcommand match)", () => {
		expect(parseGitCommit("git commit-graph write")).toBeNull();
	});

	it("returns null for empty / non-string input", () => {
		expect(parseGitCommit("")).toBeNull();
		expect(parseGitCommit("   ")).toBeNull();
	});
});
