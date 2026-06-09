import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeIndexSnapshot } from "./staged-snapshot.js";

let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

function writeRepo(rel: string, content: string): void {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "staged-snap-"));
	git("init", "-q");
	git("config", "user.email", "t@t.t");
	git("config", "user.name", "t");
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("materializeIndexSnapshot", () => {
	it("materializes the STAGED index content, not the dirty worktree (finding 3)", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");
		// Stage v2, then dirty the worktree to v3 (UNSTAGED). The commit would
		// capture v2; the worktree holds v3. The snapshot must reflect v2.
		writeRepo("src/m.ts", "export const v = 2;\n");
		git("add", "src/m.ts");
		writeRepo("src/m.ts", "export const v = 3;\n");

		const snap = materializeIndexSnapshot(repo);
		expect(snap).not.toBeNull();
		const materialized = readFileSync(join(snap?.root ?? "", "src/m.ts"), "utf-8");
		expect(materialized).toBe("export const v = 2;\n"); // the INDEX, not worktree v3
		snap?.cleanup();
		expect(existsSync(snap?.root ?? "")).toBe(false); // cleanup removes the tree
	});

	it("excludes an unstaged new file (not part of the commit)", () => {
		writeRepo("src/a.ts", "export const a = 1;\n");
		git("add", "src/a.ts");
		git("commit", "-qm", "init");
		// b.ts exists in the worktree but is NOT staged → not in the commit.
		writeRepo("src/b.ts", "export const b = 1;\n");

		const snap = materializeIndexSnapshot(repo);
		expect(snap).not.toBeNull();
		expect(existsSync(join(snap?.root ?? "", "src/a.ts"))).toBe(true);
		expect(existsSync(join(snap?.root ?? "", "src/b.ts"))).toBe(false); // untracked → absent
		snap?.cleanup();
	});

	it("symlinks node_modules so a suite can still resolve dependencies", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");

		const snap = materializeIndexSnapshot(repo);
		expect(snap).not.toBeNull();
		expect(existsSync(join(snap?.root ?? "", "node_modules", "dep", "index.js"))).toBe(true);
		snap?.cleanup();
	});

	it("returns null outside a git repo (fail-open)", () => {
		const notRepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(materializeIndexSnapshot(notRepo)).toBeNull();
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});

	// UNTRACKED-EXCLUSION CONTRACT (finding 3). `git commit -a` stages tracked
	// modifications but NEVER untracked files, so the -a snapshot must include the
	// former and exclude the latter — otherwise an untracked test masks a tracked
	// source change and an uncovered/red commit slips through.
	it("the -a snapshot includes tracked worktree mods but EXCLUDES untracked files", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");
		writeRepo("src/m.ts", "export const v = 2;\n"); // tracked, unstaged — -a WILL stage this
		writeRepo("src/m.test.ts", "test('x', () => {});\n"); // untracked — -a will NOT stage this

		const snap = materializeIndexSnapshot(repo, true); // the -a mode
		expect(snap).not.toBeNull();
		expect(readFileSync(join(snap?.root ?? "", "src/m.ts"), "utf-8")).toBe("export const v = 2;\n");
		expect(existsSync(join(snap?.root ?? "", "src/m.test.ts"))).toBe(false); // untracked → absent
		snap?.cleanup();
	});

	it("a plain (non--a) snapshot ignores tracked worktree mods (the INDEX exactly)", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");
		writeRepo("src/m.ts", "export const v = 2;\n"); // unstaged — a plain commit ignores it
		const snap = materializeIndexSnapshot(repo);
		expect(readFileSync(join(snap?.root ?? "", "src/m.ts"), "utf-8")).toBe("export const v = 1;\n");
		snap?.cleanup();
	});
});
