// test-contract: boundary — protocol-v3 overlay capture never trusts dirty worktree bytes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureMutationOverlaySource,
	type CapturedMutationOverlaySource,
} from "./mutation-cloud-v3-overlay-source.js";
import { MUTATION_ONBOARDING_ARCHIVE_PREFIX } from "./mutation-cloud-v3-onboarding-source.js";
import { MAX_TARGET_SOURCE_BYTES } from "./protocol-v3/field-checks.js";

const BASE_TARGET = "export const value = 'base';\n";
const PROPOSED_TARGET = Buffer.from("export const value = 'proposed';\n", "utf8");
const FIXED_GIT_ENV = {
	...process.env,
	GIT_AUTHOR_DATE: "946684800 +0000",
	GIT_COMMITTER_DATE: "946684800 +0000",
};
const repositories: string[] = [];

function git(root: string, args: readonly string[], input?: Uint8Array): Buffer {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "buffer",
		env: FIXED_GIT_ENV,
		...(input === undefined ? {} : { input: Buffer.from(input) }),
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
}

function write(root: string, path: string, contents: string | Uint8Array): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function commit(root: string, message: string): void {
	git(root, ["add", "--all"]);
	git(root, ["commit", "--quiet", "-m", message]);
}

function repository(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-overlay-test-"));
	repositories.push(root);
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.name", "Interlinked Test"]);
	git(root, ["config", "user.email", "test@interlinked.invalid"]);
	const initial = Object.keys(files).length > 0
		? files
		: {
			"src/target.ts": BASE_TARGET,
			"src/target.test.ts": "import { value } from './target.js';\nvoid value;\n",
			"src/unrelated.ts": "export const unrelated = 'head';\n",
		};
	for (const [path, contents] of Object.entries(initial)) write(root, path, contents);
	commit(root, "base");
	return root;
}

function capture(
	root: string,
	targetFile = "src/target.ts",
	proposedBytes: Uint8Array = PROPOSED_TARGET,
	selectTests: NonNullable<Parameters<typeof captureMutationOverlaySource>[1]>["selectTests"] = () => ({
		tests: ["src/target.test.ts"],
	}),
): CapturedMutationOverlaySource {
	return captureMutationOverlaySource(
		{ root, repository: "github.com/interlinked/test", targetFile, proposedBytes },
		{ selectTests },
	);
}

function archiveFile(captured: CapturedMutationOverlaySource, path: string): Buffer {
	return execFileSync(
		"tar",
		["-xOf", "-", `${MUTATION_ONBOARDING_ARCHIVE_PREFIX}${path}`],
		{ encoding: "buffer", input: Buffer.from(captured.sourceArtifactBytes) },
	);
}

function archiveEntries(captured: CapturedMutationOverlaySource): string[] {
	return execFileSync("tar", ["-tf", "-"], {
		encoding: "utf8",
		input: Buffer.from(captured.sourceArtifactBytes),
	}).trim().split("\n");
}

afterEach(() => {
	for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("captureMutationOverlaySource", () => {
	it("captures HEAD plus exactly the proposed target while excluding every dirty worktree byte", () => {
		const root = repository();
		write(root, "src/target.ts", "export const value = 'dirty target';\n");
		write(root, "src/unrelated.ts", "export const unrelated = 'dirty';\n");
		write(root, "src/untracked.ts", "export const untracked = true;\n");
		const statusBefore = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		const objectCensusBefore = git(root, ["count-objects", "-v"]);
		const indexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
			.toString("utf8").trim();
		const indexBefore = readFileSync(indexPath);

		const captured = capture(root, "src/target.ts", PROPOSED_TARGET, ({ projectRoot }) => {
			expect(readFileSync(join(projectRoot, "src/target.ts"))).toEqual(PROPOSED_TARGET);
			expect(readFileSync(join(projectRoot, "src/unrelated.ts"), "utf8")).toContain("'head'");
			expect(() => readFileSync(join(projectRoot, "src/untracked.ts"))).toThrow();
			return { tests: ["src/target.test.ts"] };
		});

		expect(archiveFile(captured, "src/target.ts")).toEqual(PROPOSED_TARGET);
		expect(archiveFile(captured, "src/unrelated.ts").toString("utf8")).toContain("'head'");
		expect(archiveEntries(captured)).not.toContain(`${MUTATION_ONBOARDING_ARCHIVE_PREFIX}src/untracked.ts`);
		expect(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toEqual(statusBefore);
		expect(git(root, ["count-objects", "-v"])).toEqual(objectCensusBefore);
		expect(readFileSync(indexPath)).toEqual(indexBefore);
	});

	it("returns request-ready bindings and embeds the synthetic request commit in the tar", () => {
		const root = repository();
		const captured = capture(root);
		const embedded = git(root, ["get-tar-commit-id"], captured.sourceArtifactBytes)
			.toString("utf8").trim();
		expect(captured).toMatchObject({
			format: "git-archive-tar-v1",
			archivePrefix: "interlinked-source-v1/",
			repository: "github.com/interlinked/test",
			commit: embedded,
			targetFile: "src/target.ts",
			scopeMode: "import_graph",
			testFiles: ["src/target.test.ts"],
			changesetTarget: {
				path: "src/target.ts",
				content_hash: captured.targetSha256,
			},
		});
		expect(captured.commit).not.toBe(captured.baseCommit);
		expect(captured.sourceArtifactId).toBe(`src_git_archive_v1_${captured.sourceArtifactSha256}`);
		expect(Buffer.from(captured.targetBytes)).toEqual(PROPOSED_TARGET);
	});

	it("supports a new regular target without adding it to the source worktree or index", () => {
		const root = repository();
		const sourceIndex = readFileSync(
			git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString("utf8").trim(),
		);
		const proposed = Buffer.from("export const newlyAdded = true;\n", "utf8");
		const captured = capture(root, "src/new-file.ts", proposed, ({ projectRoot }) => {
			expect(readFileSync(join(projectRoot, "src/new-file.ts"))).toEqual(proposed);
			return { tests: null, reason: "no_affected_tests" };
		});
		expect(archiveFile(captured, "src/new-file.ts")).toEqual(proposed);
		expect(() => readFileSync(join(root, "src/new-file.ts"))).toThrow();
		expect(() => git(root, ["ls-files", "--error-unmatch", "src/new-file.ts"])).toThrow();
		expect(readFileSync(
			git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString("utf8").trim(),
		)).toEqual(sourceIndex);
	});

	it("is byte-deterministic for the same HEAD and proposal", () => {
		const root = repository();
		const first = capture(root);
		const second = capture(root);
		expect(second.commit).toBe(first.commit);
		expect(second.sourceArtifactSha256).toBe(first.sourceArtifactSha256);
		expect(Buffer.from(second.sourceArtifactBytes)).toEqual(Buffer.from(first.sourceArtifactBytes));
	});

	it("changes both synthetic commit and artifact identity when proposed content changes", () => {
		const root = repository();
		const first = capture(root, "src/target.ts", Buffer.from("export const value = 1;\n"));
		const second = capture(root, "src/target.ts", Buffer.from("export const value = 2;\n"));
		expect(second.commit).not.toBe(first.commit);
		expect(second.targetSha256).not.toBe(first.targetSha256);
		expect(second.sourceArtifactSha256).not.toBe(first.sourceArtifactSha256);
	});

	it("rejects any symlink in immutable HEAD before constructing an archive", () => {
		const root = repository();
		symlinkSync("target.ts", join(root, "src/link.ts"));
		commit(root, "add symlink");
		expect(() => capture(root)).toThrow("HEAD contains a symlink: src/link.ts");
	});

	it("rejects any submodule entry in immutable HEAD", () => {
		const root = repository();
		const head = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
		git(root, ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`]);
		git(root, ["commit", "--quiet", "-m", "add gitlink"]);
		expect(() => capture(root)).toThrow("HEAD contains a submodule: vendor/module");
	});

	it.each([
		"../escape.ts",
		"/absolute.ts",
		"src//double.ts",
		"src/./dot.ts",
		"src\\windows.ts",
		".git/config",
		"src/line\nbreak.ts",
	])("rejects unsafe proposed target path %j", (targetFile) => {
		const root = repository();
		expect(() => capture(root, targetFile)).toThrow(/normalized|unsafe/);
	});

	it("rejects a new target whose path collides with a tracked regular file", () => {
		const root = repository({ "src": "tracked file named src\n" });
		expect(() => capture(root, "src/new.ts")).toThrow("conflicts with tracked path: src");
	});

	it("rejects oversized target and source artifacts", () => {
		const root = repository();
		expect(() => capture(root, "src/target.ts", Buffer.alloc(MAX_TARGET_SOURCE_BYTES + 1))).toThrow(
			`exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`,
		);
		expect(() => captureMutationOverlaySource(
			{
				root,
				repository: "github.com/interlinked/test",
				targetFile: "src/target.ts",
				proposedBytes: PROPOSED_TARGET,
			},
			{ sourceArtifactByteLimit: 512, selectTests: () => ({ tests: [] }) },
		)).toThrow(/synthetic archive failed|archive must contain/);
	});

	it("refuses a capture when HEAD changes while the materialized archive is being scoped", () => {
		const root = repository();
		expect(() => capture(root, "src/target.ts", PROPOSED_TARGET, () => {
			write(root, "README.md", "racing commit\n");
			commit(root, "race");
			return { tests: [] };
		})).toThrow("repository HEAD changed during capture");
	});
});
