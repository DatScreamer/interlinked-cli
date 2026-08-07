// Companion unit test for git-session-scope-gate.ts targeting coverage gaps
// not exercised by the broader integration test
// (__tests__/git-session-scope-gate.integration.test.ts). Same strategy:
// real git repos in tmpdir(), real execFileSync calls.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateGitScopeGateSync,
	parseGitVerb,
} from "./git-session-scope-gate.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";

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
	repo = mkdtempSync(join(tmpdir(), "git-scope-unit-"));
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

function makeSession(opts?: {
	written?: string[];
	baselineModified?: string[];
	baselineStaged?: string[];
	noBaseline?: boolean;
}): SessionTrajectory {
	const tracker = new SessionTracker();
	const event: HarnessEvent = {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		cwd: repo,
	};
	const session = tracker.recordEvent(event);
	if (opts?.noBaseline) {
		session.git_session_baseline = undefined;
	} else {
		session.git_session_baseline = {
			head_sha: "abc",
			modified: new Set(opts?.baselineModified ?? []),
			staged: new Set(opts?.baselineStaged ?? []),
			untracked: new Set(),
		};
	}
	for (const f of opts?.written ?? []) session.files_written.add(f);
	return session;
}

// ============================================================
// evaluateGitScopeGateSync — early exits (line 106)
// ============================================================

describe("evaluateGitScopeGateSync — non-git command short-circuit", () => {
	it("returns null immediately for a non-git bash command", () => {
		const session = makeSession();
		expect(evaluateGitScopeGateSync("ls -la", session, repo)).toBeNull();
	});
});

// ============================================================
// evaluateGitScopeGateSync — missing baseline (line 147 false branch)
// ============================================================

describe("evaluateGitScopeGateSync — no git_session_baseline captured", () => {
	it("still asks about an unauthorized file with no baseline set", () => {
		writeFile("src/unknown.ts", "1");
		const session = makeSession({ written: [], noBaseline: true });
		expect(session.git_session_baseline).toBeUndefined();
		const v = evaluateGitScopeGateSync("git add src/unknown.ts", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.baseline_files).toEqual([]);
		expect(v?.unauthorized_files).toEqual(["src/unknown.ts"]);
	});
});

// ============================================================
// parseGitVerb — empty token list after split (line 225)
// ============================================================

describe("parseGitVerb — empty first segment", () => {
	it("returns null when the command starts with a compound separator", () => {
		// firstSegment splits to "" before the "&&", tokens end up empty.
		expect(parseGitVerb("&&git add x")).toBeNull();
	});
});

// ============================================================
// parseGitVerb — first-token git-likeness check (line 232)
// ============================================================

describe("parseGitVerb — first token is not git-like", () => {
	it("returns null when 'git' appears later but not as the first token", () => {
		expect(parseGitVerb("npm run git add x")).toBeNull();
	});

	it("accepts an absolute path ending in /git as the first token", () => {
		const p = parseGitVerb("/usr/bin/git add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});
});

// ============================================================
// skipGitGlobalOptions — --git-dir= / --work-tree= / other flags
// (lines 268-270, 272-275)
// ============================================================

describe("parseGitVerb — global option skipping", () => {
	it("skips a --git-dir=<path> style flag", () => {
		const p = parseGitVerb("git --git-dir=/tmp/x.git add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});

	it("skips a --work-tree=<path> style flag", () => {
		const p = parseGitVerb("git --work-tree=/tmp/x add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});

	it("skips an unrecognized single-dash global flag", () => {
		const p = parseGitVerb("git -p add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});
});

// ============================================================
// shellSplit — escapes, quotes, whitespace collapsing
// (lines 295-298, 300-302, 309, 317)
// ============================================================

describe("parseGitVerb — shell-aware tokenizing", () => {
	it("keeps a backslash-escaped space as part of one token", () => {
		const p = parseGitVerb("git add foo\\ bar.ts");
		expect(p?.args).toEqual(["foo bar.ts"]);
	});

	it("keeps a single-quoted path with a space as one token", () => {
		const p = parseGitVerb("git add 'foo bar.ts'");
		expect(p?.args).toEqual(["foo bar.ts"]);
	});

	it("collapses repeated whitespace between tokens", () => {
		const p = parseGitVerb("git  add   foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});

	it("ignores trailing whitespace at the end of the command", () => {
		const p = parseGitVerb("git add foo.ts ");
		expect(p?.args).toEqual(["foo.ts"]);
	});
});

// ============================================================
// resolvePushOpFiles — success path with a real upstream configured
// (lines 416-420, 446, formatReason "hasn't written" branch)
// ============================================================

describe("evaluateGitScopeGateSync — git push with a configured upstream", () => {
	it("resolves the commits ahead of upstream and asks about an unwritten file", () => {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		// A second local branch acts as the upstream baseline.
		git(["branch", "upstream-track"]);
		git(["branch", `--set-upstream-to=upstream-track`, branch]);

		writeFile("src/ahead.ts", "export const a = 1;");
		git(["add", "src/ahead.ts"]);
		git(["commit", "-q", "-m", "ahead of upstream"]);

		const session = makeSession({ written: [] });
		const v = evaluateGitScopeGateSync("git push", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.resolved_files).toEqual(["src/ahead.ts"]);
		expect(v?.reason).toMatch(/push/);
		expect(v?.reason).toMatch(/hasn't written/);
	});
});

// ============================================================
// formatReason — REASON_FILE_LIMIT overflow (">, …" truncation)
// (branches 455, 459)
// ============================================================

describe("evaluateGitScopeGateSync — reason truncation past REASON_FILE_LIMIT", () => {
	it("appends an ellipsis when more than 5 unauthorized files are unknown", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
		for (const n of names) writeFile(n, "x");
		const session = makeSession({ written: [] });
		const v = evaluateGitScopeGateSync("git add -A", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.unauthorized_files.length).toBe(6);
		expect(v?.reason).toMatch(/, …/);
	});

	it("appends an ellipsis when more than 5 baseline files are pre-existing", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
		for (const n of names) {
			writeFile(n, "1");
		}
		git(["add", ...names]);
		git(["commit", "-q", "-m", "add all"]);
		for (const n of names) writeFile(n, "2");
		const session = makeSession({ written: [], baselineModified: names });
		const v = evaluateGitScopeGateSync("git commit -am wip", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.baseline_files.length).toBe(6);
		expect(v?.reason).toMatch(/, …/);
		expect(v?.reason).toMatch(/before this session started/);
	});
});
