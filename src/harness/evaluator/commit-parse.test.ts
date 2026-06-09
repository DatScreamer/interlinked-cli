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

describe("parseGitCommit — effective working directory (finding 4)", () => {
	it("a plain `git commit` carries no cwd override", () => {
		expect(parseGitCommit("git commit -m x")?.cwd).toBeUndefined();
	});

	it("captures a `cd <dir> && git commit` redirect", () => {
		expect(parseGitCommit("cd packages/api && git commit -m x")?.cwd).toBe("packages/api");
	});

	it("captures a `git -C <dir> commit` redirect", () => {
		expect(parseGitCommit("git -C packages/api commit -m x")?.cwd).toBe("packages/api");
	});

	it("compounds a `cd` chain like the shell does", () => {
		expect(parseGitCommit("cd a && cd b && git commit -m x")?.cwd).toBe("a/b");
	});

	it("compounds `cd` with a relative `-C`", () => {
		expect(parseGitCommit("cd a && git -C b commit -m x")?.cwd).toBe("a/b");
	});

	it("compounds multiple `-C` flags (git semantics)", () => {
		expect(parseGitCommit("git -C a -C b commit -m x")?.cwd).toBe("a/b");
	});

	it("an absolute `-C` / `cd` replaces the accumulated prefix", () => {
		expect(parseGitCommit("cd a && git -C /srv/repo commit -m x")?.cwd).toBe("/srv/repo");
		expect(parseGitCommit("cd /srv/repo && git commit -m x")?.cwd).toBe("/srv/repo");
	});

	it("normalizes `..` in a `cd` redirect", () => {
		expect(parseGitCommit("cd a/b && cd ../c && git commit -m x")?.cwd).toBe("a/c");
	});

	it("leaves cwd undefined for an unresolvable redirect (variable / glob / `cd -` / `cd ~`)", () => {
		// Non-literal targets can't be resolved statically → fall back to the shell
		// cwd rather than treat `$SUBDIR` as a real directory.
		expect(parseGitCommit("cd $SUBDIR && git commit -m x")?.cwd).toBeUndefined();
		expect(parseGitCommit("git -C $SUBDIR commit -m x")?.cwd).toBeUndefined();
		expect(parseGitCommit("cd - && git commit -m x")?.cwd).toBeUndefined();
		expect(parseGitCommit("cd ~/repo && git commit -m x")?.cwd).toBeUndefined();
	});

	it("still recognizes the commit while capturing the redirect (isCommit unaffected)", () => {
		const parsed = parseGitCommit("cd sub && git commit --no-verify -m x");
		expect(parsed?.isCommit).toBe(true);
		expect(parsed?.noVerify).toBe(true);
		expect(parsed?.cwd).toBe("sub");
	});
});

describe("parseGitCommit — -a / --all detection (finding 3)", () => {
	it("a plain `git commit` is not `all`", () => {
		expect(parseGitCommit("git commit -m x")?.all).toBeUndefined();
	});

	it("detects `-a`, `--all`, and the `-am` short cluster", () => {
		expect(parseGitCommit("git commit -a -m x")?.all).toBe(true);
		expect(parseGitCommit("git commit --all -m x")?.all).toBe(true);
		expect(parseGitCommit('git commit -am "msg"')?.all).toBe(true);
	});

	it("does NOT treat `-m` or `--amend` as `all`", () => {
		expect(parseGitCommit("git commit -m x")?.all).toBeUndefined();
		expect(parseGitCommit("git commit --amend --no-edit")?.all).toBeUndefined();
	});
});

describe("parseGitCommit — constructsContent (finding 4: preceding add / pathspec)", () => {
	it("a plain or -a commit does NOT construct content", () => {
		expect(parseGitCommit("git commit -m x")?.constructsContent).toBeUndefined();
		expect(parseGitCommit("git commit -am x")?.constructsContent).toBeUndefined();
	});

	it("a preceding `git add` constructs content", () => {
		expect(parseGitCommit("git add -A && git commit -m x")?.constructsContent).toBe(true);
		expect(parseGitCommit("git add . && git commit")?.constructsContent).toBe(true);
		expect(parseGitCommit("git add src/x.ts && git commit -m x")?.constructsContent).toBe(true);
	});

	it("a pathspec commit constructs content", () => {
		expect(parseGitCommit("git commit src/x.ts -m x")?.constructsContent).toBe(true);
		expect(parseGitCommit("git commit -m x src/x.ts")?.constructsContent).toBe(true);
		expect(parseGitCommit("git commit -- src/x.ts")?.constructsContent).toBe(true);
	});

	it("does NOT mistake a -m / -am / -F message-or-file value for a pathspec", () => {
		expect(parseGitCommit('git commit -m "a message"')?.constructsContent).toBeUndefined();
		expect(parseGitCommit('git commit -am "a message"')?.constructsContent).toBeUndefined();
		expect(parseGitCommit("git commit -F msg.txt")?.constructsContent).toBeUndefined();
	});
});

describe("parseGitCommit — constructedPaths (finding 6: narrow vs broad) + pathspec-from-file (finding 7)", () => {
	it("a NARROW `git add <path>` restricts to that path", () => {
		expect(parseGitCommit("git add src/a.ts && git commit -m x")?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parseGitCommit("git add src/a.ts src/b.ts && git commit")?.constructedPaths).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("a commit PATHSPEC restricts to that path", () => {
		expect(parseGitCommit("git commit src/a.ts -m x")?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parseGitCommit("git commit -- src/a.ts src/b.ts")?.constructedPaths).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("a BROAD stage carries NO constructedPaths (the whole worktree is committed)", () => {
		expect(parseGitCommit("git add -A && git commit -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add . && git commit")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add -u && git commit -m x")?.constructedPaths).toBeUndefined();
	});

	it("`--pathspec-from-file` is a (broad) constructed-content commit, not a stale-index commit", () => {
		expect(parseGitCommit("git commit --pathspec-from-file=specs.txt")?.constructsContent).toBe(true);
		expect(parseGitCommit("git commit --pathspec-from-file specs.txt")?.constructsContent).toBe(true);
		// Broad → no specific paths (its pathspecs live in a file we don't read).
		expect(parseGitCommit("git commit --pathspec-from-file=specs.txt")?.constructedPaths).toBeUndefined();
	});

	// NON-LITERAL pathspecs are expanded by git/the shell at run time — an exact-match
	// filter would match NOTHING and the gate would silently evaluate no source. They
	// must therefore stay BROAD (constructedPaths absent ⇒ evaluate everything).
	it("a glob / variable / pathspec-magic spec is BROAD, never a literal filter", () => {
		expect(parseGitCommit("git add 'src/*.ts' && git commit -m x")?.constructsContent).toBe(true);
		expect(parseGitCommit("git add 'src/*.ts' && git commit -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit 'src/**' -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit src/file-?.ts -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add $FILES && git commit -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit ':(icase)readme' -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add ~/repo/a.ts && git commit -m x")?.constructedPaths).toBeUndefined();
	});

	// `-a` stages EVERY tracked modification — a preceding narrow add must not shrink
	// the evaluated set to just the added paths.
	it("`git add <path> && git commit -am x` is BROAD (the -a stages everything tracked)", () => {
		const parsed = parseGitCommit("git add src/a.ts && git commit -am x");
		expect(parsed?.constructsContent).toBe(true);
		expect(parsed?.all).toBe(true);
		expect(parsed?.constructedPaths).toBeUndefined(); // NOT narrowed to src/a.ts
	});

	it("a mixed literal+glob spec list is BROAD (one non-literal poisons the filter)", () => {
		expect(parseGitCommit("git add src/a.ts 'src/*.spec.ts' && git commit -m x")?.constructedPaths).toBeUndefined();
	});
});
