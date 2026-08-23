// Mutation-kill suite (pass1_w41) for git-session-scope-gate.ts.
// Targets specific stryker survivors pre-extracted for this file. Same
// fixture strategy as the companion tests: real git repos in tmpdir(),
// real execFileSync calls — no mocking of node:child_process.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateGitScopeGateSync, parseGitVerb } from "./git-session-scope-gate.js";
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
	repo = mkdtempSync(join(tmpdir(), "git-scope-w41-"));
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
}): SessionTrajectory {
	const tracker = new SessionTracker();
	const event: HarnessEvent = {
		hook_event: "PreToolUse",
		session_id: "w41-session",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		cwd: repo,
	};
	const session = tracker.recordEvent(event);
	session.git_session_baseline = {
		head_sha: "abc",
		modified: new Set(opts?.baselineModified ?? []),
		staged: new Set(),
		untracked: new Set(),
	};
	for (const f of opts?.written ?? []) session.files_written.add(f);
	return session;
}

// ============================================================
// e5d650ae17602e6f — allowNote && files.length===0 → || (mutantId e5d650ae17602e6f)
// ============================================================

describe("evaluateGitScopeGateSync — allow-with-no-note path omits the reason key", () => {
	// test-contract: invariant — the true-allow return (no unauthorized files,
	// no allowNote) must not fabricate a `reason` property; toStrictEqual
	// distinguishes a present-but-undefined key from an absent one.
	it("returns no reason field for a bare commit with nothing staged", () => {
		const v = evaluateGitScopeGateSync("git commit -m wip", makeSession(), repo);
		expect(v).toStrictEqual({
			decision: "allow",
			resolved_files: [],
			unauthorized_files: [],
			baseline_files: [],
		});
	});
});

// ============================================================
// 4a2f61105fe9fa67 / 1b9b952cb4dfbfcd — ArrayDeclaration [] → ["Stryker was here"]
// on the unauthorized.length===0 allow branch
// ============================================================

describe("evaluateGitScopeGateSync — exact shape of the fully-authorized allow branch", () => {
	// test-contract: public-api — every array field on a real allow (all
	// op-files session-written) must be exactly empty, not seeded.
	it("returns empty unauthorized_files and baseline_files when everything was session-written", () => {
		writeFile("src/foo.ts", "1");
		const session = makeSession({ written: ["src/foo.ts"] });
		const v = evaluateGitScopeGateSync("git add src/foo.ts", session, repo);
		expect(v).toEqual({
			decision: "allow",
			resolved_files: ["src/foo.ts"],
			unauthorized_files: [],
			baseline_files: [],
		});
	});
});

// ============================================================
// df4b0df5e2249aa1 / c643c9d585b1a5f3 — startsWith → endsWith on the
// --git-dir=/--work-tree= equals-form global-option detector
// ============================================================

describe("skipGitGlobalOptions — startsWith, not endsWith, decides the equals-form flags", () => {
	// test-contract: boundary — a token that merely ENDS with the flag
	// spelling (not starting with it) must not be treated as a global
	// option; it must be rejected as the (invalid) subcommand.
	it("does not skip a token that only ends with --git-dir=", () => {
		expect(parseGitVerb("git path/--git-dir= add x")).toBeNull();
	});

	// test-contract: boundary — same exploit for the --work-tree= form.
	it("does not skip a token that only ends with --work-tree=", () => {
		expect(parseGitVerb("git path/--work-tree= add x")).toBeNull();
	});
});

// ============================================================
// 85e09ac35d2476ad — StringLiteral "push" → "" on the deferred force-push
// return object's `verb` field
// ============================================================

describe("parseGitVerb — force-push deferral preserves the push verb", () => {
	// test-contract: public-api — the deferred-to-force-push return still
	// reports verb "push", not an emptied literal.
	it("keeps verb: \"push\" on the force-push defer path", () => {
		expect(parseGitVerb("git push --force")).toEqual({
			verb: "push",
			args: ["--force"],
			deferToForcePush: true,
		});
	});
});

// ============================================================
// 94a1ea0559abfd97 — skipGitGlobalOptions loop bound i < tokens.length → i <= tokens.length
// ============================================================

describe("skipGitGlobalOptions — loop bound does not read past the token array", () => {
	// test-contract: boundary — when every token after "git" is consumed as
	// a global option (no subcommand at all), the scan must stop exactly at
	// tokens.length rather than indexing one past it (which would explode
	// via nonNull(undefined) inside the flag-shape checks).
	it("returns null without throwing when the command ends mid-global-option", () => {
		expect(parseGitVerb("git -c foo.bar=baz")).toBeNull();
	});
});

// ============================================================
// 54283673a8f8215f / 456681344a0e06b9 — shellSplit's `cur.length > 0` guard
// (both the in-loop flush and the trailing flush)
// ============================================================

describe("shellSplit — never emits an empty token", () => {
	// test-contract: invariant — repeated whitespace between tokens must
	// collapse, not insert an empty token that would misalign the parsed
	// subcommand.
	it("collapses repeated interior whitespace without an empty token", () => {
		expect(parseGitVerb("git  add   foo.ts")).toEqual({
			verb: "add",
			args: ["foo.ts"],
			deferToForcePush: false,
		});
	});

	// test-contract: invariant — trailing whitespace at end-of-command must
	// not leave a spurious empty trailing token in args.
	it("drops trailing whitespace without an empty trailing token", () => {
		expect(parseGitVerb("git add foo.ts ")).toEqual({
			verb: "add",
			args: ["foo.ts"],
			deferToForcePush: false,
		});
	});
});

// ============================================================
// e10ef262b6296a28 — resolveAddOpFiles StringLiteral "." → ""
// ============================================================

describe("resolveAddOpFiles — \".\" is recognized as the all-form pathspec", () => {
	// test-contract: public-api — `git add .` must resolve the UNSCOPED
	// status (all dirty repo files), not a pathspec-scoped subset. Run from
	// a subdirectory so an unscoped vs. "." -scoped status actually differ.
	it("includes a dirty file outside the cwd subdirectory when adding \".\"", () => {
		writeFile("outside.ts", "1");
		writeFile("sub/inside.ts", "1");
		const subCwd = join(repo, "sub");
		const v = evaluateGitScopeGateSync("git add .", makeSession(), subCwd);
		expect(v?.resolved_files).toContain("outside.ts");
		expect(v?.resolved_files).toContain("sub/inside.ts");
	});
});

// ============================================================
// 5e90c91a935175a7 — resolvePushOpFiles stdio ["pipe","pipe","pipe"] → []
// ============================================================

describe("resolvePushOpFiles — captures git log output ahead of upstream", () => {
	// test-contract: public-api — the push-file resolution must actually
	// capture the child process's stdout for the file list.
	it("resolves the file committed ahead of a configured upstream", () => {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		git(["branch", "upstream-track"]);
		git(["branch", "--set-upstream-to=upstream-track", branch]);
		writeFile("src/ahead.ts", "export const a = 1;");
		git(["add", "src/ahead.ts"]);
		git(["commit", "-q", "-m", "ahead"]);

		const v = evaluateGitScopeGateSync("git push", makeSession(), repo);
		expect(v?.resolved_files).toEqual(["src/ahead.ts"]);
	});
});

// ============================================================
// ecafa1acdc450e05 / acefaddcdf7b68d7 — non-upstream push failures fall
// back to the generic "git log failed" message
// ============================================================

describe("resolvePushOpFiles — a non-upstream git-log failure uses the generic fallback", () => {
	// test-contract: boundary — an error message that does NOT match the
	// upstream/unknown-revision/ambiguous-argument/no-such family must
	// produce the generic degraded-allow reason, not the no-upstream one.
	it("reports the generic fallback reason for a non-git cwd", () => {
		const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			const v = evaluateGitScopeGateSync("git push", makeSession(), notARepo);
			expect(v).toEqual({
				decision: "allow",
				reason: "git log failed; gate degraded to allow.",
				resolved_files: [],
				unauthorized_files: [],
				baseline_files: [],
			});
		} finally {
			rmSync(notARepo, { recursive: true, force: true });
		}
	});
});

// ============================================================
// ccd36057fd548c97 — formatReason baselineHits.slice(0, REASON_FILE_LIMIT)
// truncation removed
// ============================================================

describe("formatReason — baseline file list is truncated at REASON_FILE_LIMIT", () => {
	// test-contract: boundary — the 6th baseline file must not appear in
	// the reason text once the cap (5) is exceeded.
	it("omits the 6th pre-existing file from the reason text", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
		for (const n of names) writeFile(n, "1");
		git(["add", ...names]);
		git(["commit", "-q", "-m", "seed"]);
		for (const n of names) writeFile(n, "2");
		const session = makeSession({ baselineModified: names });
		const v = evaluateGitScopeGateSync("git commit -am wip", session, repo);
		expect(v?.reason).not.toContain("src/f.ts");
		expect(v?.reason).toContain("src/e.ts");
	});
});

// ============================================================
// 5321fc56b55915cc — formatReason ", " separator removed
// ============================================================

describe("formatReason — files in the reason are comma-space separated", () => {
	// test-contract: public-api — the exact ask-reason string for two
	// unauthorized files must join them with ", ".
	it("uses \", \" between two unauthorized file names", () => {
		writeFile("src/a.ts", "1");
		writeFile("src/b.ts", "1");
		const v = evaluateGitScopeGateSync("git add -A", makeSession(), repo);
		expect(v?.reason).toBe(
			"This git add would include 2 file(s) this session hasn't written (src/a.ts, src/b.ts). Confirm intent.",
		);
	});
});

// ============================================================
// 6cc2f6d1fe40a8e3 — formatReason baselineHits.length > REASON_FILE_LIMIT
// → >=
// ============================================================

describe("formatReason — no ellipsis at exactly REASON_FILE_LIMIT baseline files", () => {
	// test-contract: boundary — exactly 5 baseline files (the cap) must NOT
	// trigger the "…" truncation suffix.
	it("does not append an ellipsis for exactly 5 pre-existing files", () => {
		const names = ["a", "b", "c", "d", "e"].map((n) => `src/${n}.ts`);
		for (const n of names) writeFile(n, "1");
		git(["add", ...names]);
		git(["commit", "-q", "-m", "seed"]);
		for (const n of names) writeFile(n, "2");
		const session = makeSession({ baselineModified: names });
		const v = evaluateGitScopeGateSync("git commit -am wip", session, repo);
		expect(v?.reason).not.toContain("…");
		expect(v?.baseline_files.length).toBe(5);
	});
});
