// Tests for `interlinked scratch init` / `status`: idempotent provisioning of
// the sanctioned session-script home (scratch/README.md + .gitignore carve-out
// + .ignore search negation) in any guarded repo.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initScratchDir, scratchStatus } from "../scratch.js";

function makeRepo(): string {
	return mkdtempSync(join(tmpdir(), "scratch-init-"));
}

function countMatches(haystack: string, needle: string): number {
	return haystack.split("\n").filter((line) => line === needle).length;
}

describe("initScratchDir", () => {
	it("provisions README, .gitignore carve-out, and .ignore negation", () => {
		const repo = makeRepo();
		const result = initScratchDir(repo);
		expect(existsSync(join(repo, "scratch", "README.md"))).toBe(true);
		const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
		expect(gitignore).toContain("scratch/*");
		expect(gitignore).toContain("!scratch/README.md");
		const ignore = readFileSync(join(repo, ".ignore"), "utf8");
		expect(ignore).toContain("!scratch/");
		expect(result.created.length).toBeGreaterThan(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("is idempotent — a second run changes nothing and duplicates no lines", () => {
		const repo = makeRepo();
		initScratchDir(repo);
		const second = initScratchDir(repo);
		expect(second.created).toHaveLength(0);
		expect(second.skipped.length).toBeGreaterThan(0);
		const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
		expect(countMatches(gitignore, "scratch/*")).toBe(1);
		const ignore = readFileSync(join(repo, ".ignore"), "utf8");
		expect(countMatches(ignore, "!scratch/")).toBe(1);
	});

	it("appends to an existing .gitignore without clobbering it", () => {
		const repo = makeRepo();
		writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
		initScratchDir(repo);
		const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
		expect(gitignore.startsWith("node_modules/\ndist/\n")).toBe(true);
		expect(gitignore).toContain("scratch/*");
	});

	it("does not overwrite an existing scratch/README.md", () => {
		const repo = makeRepo();
		initScratchDir(repo);
		writeFileSync(join(repo, "scratch", "README.md"), "custom notes\n");
		const second = initScratchDir(repo);
		expect(readFileSync(join(repo, "scratch", "README.md"), "utf8")).toBe("custom notes\n");
		expect(second.created).toHaveLength(0);
	});
});

describe("scratchStatus", () => {
	it("reports missing pieces before init and all-present after", () => {
		const repo = makeRepo();
		const before = scratchStatus(repo);
		expect(before.readme).toBe(false);
		expect(before.gitignoreEntry).toBe(false);
		expect(before.ignoreEntry).toBe(false);
		initScratchDir(repo);
		const after = scratchStatus(repo);
		expect(after).toEqual({
			dir: true,
			readme: true,
			gitignoreEntry: true,
			ignoreEntry: true,
		});
	});
});
