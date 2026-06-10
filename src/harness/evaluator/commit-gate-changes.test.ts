// ===========================================
// commit-gate-changes — changed-set selection unit tests
// ===========================================
// Direct unit tests for the commit gate's changed-file selection helpers,
// extracted from `commit-gate.ts` (line cap). The END-TO-END behavior of these
// helpers under `checkCommitGate` stays pinned in `commit-gate.test.ts`; this
// file pins the pure per-function contracts, most importantly the
// command-cwd → repo-toplevel REBASE of constructed pathspecs (finding 2026-06:
// `cd packages/app && git add src/a.ts && git commit` filtered toplevel-relative
// changed paths against the raw `src/a.ts` spec, matched nothing, and the staged
// file bypassed the quality bar).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	changedSetForCommit,
	rebaseConstructedPaths,
	selectChangedSources,
} from "./commit-gate-changes.js";

describe("rebaseConstructedPaths — command-cwd specs onto the repo toplevel", () => {
	const ROOT = "/repo";

	it("prefixes specs parsed in a subdirectory with that subdirectory", () => {
		expect(rebaseConstructedPaths(["src/a.ts"], "/repo/packages/app", ROOT)).toEqual([
			"packages/app/src/a.ts",
		]);
	});

	it("leaves specs unchanged when the command runs at the toplevel", () => {
		expect(rebaseConstructedPaths(["src/a.ts"], "/repo", ROOT)).toEqual(["src/a.ts"]);
	});

	it("normalizes ./ prefixes and parent traversals that stay inside the repo", () => {
		expect(rebaseConstructedPaths(["./src/a.ts"], "/repo", ROOT)).toEqual(["src/a.ts"]);
		expect(rebaseConstructedPaths(["../lib/b.ts"], "/repo/packages/app", ROOT)).toEqual([
			"packages/lib/b.ts",
		]);
	});

	it("keeps an absolute spec that resolves inside the repo, repo-relative", () => {
		expect(rebaseConstructedPaths(["/repo/src/a.ts"], "/repo/packages/app", ROOT)).toEqual([
			"src/a.ts",
		]);
	});

	it("returns null (broad) when a spec names the repo root itself", () => {
		// `git commit .` at the toplevel stages the whole tree — a narrow filter
		// keyed on "." would match NOTHING and silently evaluate no source.
		expect(rebaseConstructedPaths(["."], "/repo", ROOT)).toBeNull();
	});

	it("rebases `.` in a subdirectory to that directory (a real narrow filter)", () => {
		expect(rebaseConstructedPaths(["."], "/repo/packages/app", ROOT)).toEqual(["packages/app"]);
	});

	it("returns null (broad) when any spec escapes the repo", () => {
		expect(rebaseConstructedPaths(["../../../outside.ts"], "/repo/packages/app", ROOT)).toBeNull();
		expect(rebaseConstructedPaths(["/etc/passwd"], "/repo", ROOT)).toBeNull();
		// One escaping spec degrades the WHOLE set — partial narrowing could still
		// drop the very file the unrebasable spec was meant to name.
		expect(rebaseConstructedPaths(["src/a.ts", "../../../x.ts"], "/repo/packages/app", ROOT)).toBeNull();
	});
});

describe("changedSetForCommit — narrow filter, index union, broad fallbacks", () => {
	const ALL = ["packages/app/src/a.ts", "docs/readme.md", "src/other.ts"];

	it("returns allChanged untouched for non-worktree modes", () => {
		expect(changedSetForCommit(ALL, { constructedPaths: ["src/other.ts"] }, "index", () => [])).toEqual(
			ALL,
		);
	});

	it("returns allChanged when there are no constructed paths (broad commit)", () => {
		expect(changedSetForCommit(ALL, {}, "worktree", () => [])).toEqual(ALL);
	});

	it("narrows to the constructed paths (exact file and directory prefix)", () => {
		const changed = changedSetForCommit(
			ALL,
			{ constructedPaths: ["packages/app"] },
			"worktree",
			() => [],
		);
		expect(changed).toEqual(["packages/app/src/a.ts"]);
	});

	it("unions the staged set back in when the commit also captures the index", () => {
		const changed = changedSetForCommit(
			ALL,
			{ constructedPaths: ["src/other.ts"], includesIndex: true },
			"worktree",
			() => ["packages/app/src/a.ts"],
		);
		expect(changed.sort()).toEqual(["packages/app/src/a.ts", "src/other.ts"]);
	});

	it("falls back to ALL changed files when the staged set cannot be read", () => {
		const changed = changedSetForCommit(
			ALL,
			{ constructedPaths: ["src/other.ts"], includesIndex: true },
			"worktree",
			() => null,
		);
		expect(changed).toEqual(ALL); // unknowable fails toward evaluating MORE
	});
});

describe("selectChangedSources — scan/deletion split and suite languages", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cg-changes-"));
		mkdirSync(join(root, "src"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const readFile = (abs: string): string | null => {
		try {
			return readFileSync(abs, "utf-8");
		} catch {
			return null;
		}
	};

	it("splits present gated files into sources and absent ones into deletions", () => {
		writeFileSync(join(root, "src/present.ts"), "export const x = 1;\n");
		const selected = selectChangedSources(
			["src/present.ts", "src/deleted.ts", "docs/readme.md"],
			root,
			["ts", "js", "python"],
			readFile,
		);
		expect(selected.sources.map((s) => s.relPath)).toEqual(["src/present.ts"]);
		expect(selected.deletedPaths).toEqual(["src/deleted.ts"]);
		expect(selected.suiteLanguages).toEqual(["ts"]);
	});

	it("a deletion in a second language adds that language to the suite set", () => {
		writeFileSync(join(root, "src/present.ts"), "export const x = 1;\n");
		const selected = selectChangedSources(
			["src/present.ts", "src/gone.py"],
			root,
			["ts", "js", "python"],
			readFile,
		);
		expect(selected.suiteLanguages.sort()).toEqual(["python", "ts"]);
	});

	it("skips languages outside the configured set entirely", () => {
		const selected = selectChangedSources(["src/gone.py"], root, ["ts"], readFile);
		expect(selected.sources).toEqual([]);
		expect(selected.deletedPaths).toEqual([]);
		expect(selected.suiteLanguages).toEqual([]);
	});
});
