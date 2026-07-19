// getTrackedFiles — file-discovery contract for TrigramIndex.build().
// Pins the two deliberate gitignored INCLUSIONS: .interlinked/hooks/ (the
// generated hook script must be searchable) and scratch/ (the sanctioned
// session-script home, 2026-07-07 — gitignored but gated + greppable).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTrackedFiles } from "./trigram-git.js";

let repo: string;

function git(args: string[]): void {
	execFileSync("git", args, {
		cwd: repo,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "trigram-git-"));
	git(["init", "-q"]);
	writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
	writeFileSync(join(repo, ".gitignore"), "scratch/*\n!scratch/README.md\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("getTrackedFiles", () => {
	it("lists tracked files", () => {
		expect(getTrackedFiles(repo)).toContain("tracked.ts");
	});

	it("includes gitignored scratch/ files (sanctioned session-script home)", () => {
		mkdirSync(join(repo, "scratch", "2026-07-07-probe"), { recursive: true });
		writeFileSync(join(repo, "scratch", "2026-07-07-probe", "bucketize.py"), "print('x')\n");
		const files = getTrackedFiles(repo);
		expect(files).toContain("scratch/2026-07-07-probe/bucketize.py");
	});

	it("does NOT include other gitignored/untracked temp dirs", () => {
		writeFileSync(join(repo, ".gitignore"), "scratch/*\ntmp-stuff/\n");
		git(["add", ".gitignore"]);
		git(["commit", "-q", "-m", "ignore tmp"]);
		mkdirSync(join(repo, "tmp-stuff"), { recursive: true });
		writeFileSync(join(repo, "tmp-stuff", "x.ts"), "export {};\n");
		const files = getTrackedFiles(repo);
		expect(files.some((f) => f.startsWith("tmp-stuff/"))).toBe(false);
	});
});
