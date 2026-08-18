// Tests for the shared git I/O helpers used by the commit-time PreToolUse
// gates (commit-baseline-gate.ts, commit-registry-parity-gate.ts).

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";

let root: string;

function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

beforeEach(() => {
	// realpathSync: on macOS, os.tmpdir() is under a /var symlink that
	// resolves to /private/var — `git rev-parse --show-toplevel` returns the
	// resolved form, so comparing against the raw mkdtempSync path fails
	// spuriously (same fix commit-gate.integration.test.ts already applies
	// at its two mkdtempSync(tmpdir())+git call sites).
	root = realpathSync(mkdtempSync(join(tmpdir(), "commit-git-io-")));
	git("init", "-q");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveRepoRoot", () => {
	it("P1: resolves the toplevel of a real git repo", () => {
		expect(resolveRepoRoot(root)).toBe(root);
	});

	it("N1: returns null outside any git repo", () => {
		const bare = mkdtempSync(join(tmpdir(), "commit-git-io-nogit-"));
		try {
			expect(resolveRepoRoot(bare)).toBeNull();
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

describe("gitShow", () => {
	it("P1: reads the STAGED (index) blob via the ':<path>' ref", () => {
		writeFileSync(join(root, "a.txt"), "staged content");
		git("add", "-A");
		expect(gitShow(root, ":a.txt")).toBe("staged content");
	});

	it("P2: reads a committed blob via 'HEAD:<path>'", () => {
		writeFileSync(join(root, "a.txt"), "committed content");
		git("add", "-A");
		git("commit", "-q", "-m", "seed");
		expect(gitShow(root, "HEAD:a.txt")).toBe("committed content");
	});

	it("N1: returns null for a path that was never staged/committed", () => {
		expect(gitShow(root, ":never-existed.txt")).toBeNull();
	});

	it("N2: returns null for HEAD: before any commit exists", () => {
		writeFileSync(join(root, "a.txt"), "x");
		git("add", "-A");
		expect(gitShow(root, "HEAD:a.txt")).toBeNull();
	});
});
