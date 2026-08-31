import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryIdentity, resolveReviewScope } from "./simplify-scope.js";

let fixture: string;

function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: fixture,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function write(rel: string, content: string): void {
	const path = join(fixture, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function commit(message: string): string {
	git(["add", "-A"]);
	git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@invalid.local",
		"commit",
		"-q",
		"-m",
		message,
	]);
	return git(["rev-parse", "HEAD"]);
}

beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "interlinked-simplify-scope-"));
	git(["init", "-q"]);
	write("src/a.ts", "export const a = 1;\n");
	write("src/b.ts", "export const b = 1;\n");
	commit("initial");
});

afterEach(() => {
	rmSync(fixture, { recursive: true, force: true });
});

describe("resolveReviewScope", () => {
	// test-contract: public-api — changed scope includes both tracked edits and
	// untracked files without relying on shell parsing
	it("discovers changed and untracked paths", () => {
		write("src/a.ts", "export const a = 2;\n");
		write("src/new.ts", "export const fresh = true;\n");
		const scope = resolveReviewScope({ cwd: fixture, kind: "changed" });
		expect(scope.kind).toBe("changed");
		expect(scope.selected_paths).toEqual(["src/a.ts", "src/new.ts"]);
	});

	// test-contract: boundary — staged scope excludes an unstaged-only path
	it("isolates staged paths", () => {
		write("src/a.ts", "export const a = 2;\n");
		git(["add", "src/a.ts"]);
		write("src/b.ts", "export const b = 2;\n");
		const scope = resolveReviewScope({ cwd: fixture, kind: "staged" });
		expect(scope.selected_paths).toEqual(["src/a.ts"]);
	});

	it("refuses staged selection when selected bytes have unstaged drift", () => {
		write("src/a.ts", "export const a = 2;\n");
		git(["add", "src/a.ts"]);
		write("src/a.ts", "export const a = 3;\n");
		expect(() => resolveReviewScope({ cwd: fixture, kind: "staged" })).toThrow(
			/staged index selected path content differs/,
		);
	});

	// test-contract: public-api — an explicit two-dot range resolves both
	// endpoint commits and reports only paths in that range
	it("validates and resolves an explicit commit range", () => {
		const base = git(["rev-parse", "HEAD"]);
		write("src/b.ts", "export const b = 3;\n");
		const head = commit("change b");
		const scope = resolveReviewScope({ cwd: fixture, kind: "range", range: `${base}..${head}` });
		expect(scope.selected_paths).toEqual(["src/b.ts"]);
		expect(scope.base_sha).toBe(base);
		expect(scope.head_sha).toBe(head);
	});

	it("refuses a range when a selected path has drifted from its resolved head", () => {
		const base = git(["rev-parse", "HEAD"]);
		write("src/b.ts", "export const b = 3;\n");
		const head = commit("change b");
		write("src/b.ts", "export const b = 4;\n");
		expect(() =>
			resolveReviewScope({ cwd: fixture, kind: "range", range: `${base}..${head}` }),
		).toThrow(/range head .* selected path content differs/);
	});

	// test-contract: security — ambiguous or option-shaped range text is
	// rejected before being passed to git
	it("rejects a non-explicit range", () => {
		expect(() =>
			resolveReviewScope({ cwd: fixture, kind: "range", range: "--output=/tmp/x" }),
		).toThrow("--range must be an explicit");
	});
});

describe("repositoryIdentity", () => {
	// test-contract: invariant — committed identity stays fixed while the
	// current-content hash changes for an unstaged worktree edit
	it("separates HEAD tree identity from current worktree content", () => {
		const files = [join(fixture, "src/a.ts"), join(fixture, "src/b.ts")];
		const before = repositoryIdentity({ cwd: fixture, files });
		write("src/a.ts", "export const a = 99;\n");
		const after = repositoryIdentity({ cwd: fixture, files });
		expect(after.head_sha).toBe(before.head_sha);
		expect(after.tree_sha).toBe(before.tree_sha);
		expect(after.working_tree_sha256).not.toBe(before.working_tree_sha256);
	});
});
