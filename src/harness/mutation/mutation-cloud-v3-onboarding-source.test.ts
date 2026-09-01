// test-contract: unit — onboarding captures one clean immutable HEAD only.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	captureMutationOnboardingSource,
	MUTATION_ONBOARDING_ARCHIVE_FORMAT_CONTRACT,
	MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	MUTATION_ONBOARDING_SOURCE_FORMAT,
	type MutationOnboardingGitRunner,
} from "./mutation-cloud-v3-onboarding-source.js";
import { MAX_SOURCE_ARTIFACT_BYTES, MAX_TARGET_SOURCE_BYTES } from "./protocol-v3/field-checks.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT_HEAD = "1123456789abcdef0123456789abcdef01234567";
const TARGET_OID = "a".repeat(40);
const TARGET = Buffer.from("export const answer = 42;\n", "utf8");
const ARCHIVE = Buffer.from("exact deterministic tar fixture", "utf8");

function bytes(value: string): Uint8Array {
	return Buffer.from(value, "utf8");
}

function digest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function missingMaterializedTarget(): never {
	throw new Error("missing");
}

function foreignMaterializedTarget(): Uint8Array {
	return bytes("foreign target");
}

function regularTree(path = "src/answer.ts"): string {
	return `100644 blob ${TARGET_OID}\t${path}\0`;
}

interface GitFixtureOptions {
	top?: string;
	statuses?: Uint8Array[];
	heads?: string[];
	tree?: string;
	targetSize?: string;
	targetBytes?: Uint8Array;
	archiveBytes?: Uint8Array;
}

function gitFixture(options: GitFixtureOptions = {}): {
	runGit: MutationOnboardingGitRunner;
	calls: Array<{ args: string[]; maxBytes: number }>;
} {
	const calls: Array<{ args: string[]; maxBytes: number }> = [];
	const statuses = [...(options.statuses ?? [new Uint8Array(), new Uint8Array()])];
	const heads = [...(options.heads ?? [HEAD, HEAD])];
	const runGit: MutationOnboardingGitRunner = (_root, rawArgs, maxBytes) => {
		const args = [...rawArgs];
		calls.push({ args, maxBytes });
		if (args.join(" ") === "rev-parse --show-toplevel") return bytes(`${options.top ?? "/repo"}\n`);
		if (args[0] === "status") return statuses.shift() ?? new Uint8Array();
		if (args.join(" ") === "rev-parse --verify HEAD^{commit}") {
			return bytes(`${heads.shift() ?? HEAD}\n`);
		}
		if (args[0] === "ls-tree") return bytes(options.tree ?? regularTree());
		if (args[0] === "cat-file" && args[1] === "-s") {
			return bytes(`${options.targetSize ?? String((options.targetBytes ?? TARGET).byteLength)}\n`);
		}
		if (args[0] === "cat-file" && args[1] === "blob") {
			return Uint8Array.from(options.targetBytes ?? TARGET);
		}
		if (args[0] === "archive") return Uint8Array.from(options.archiveBytes ?? ARCHIVE);
		throw new Error(`unexpected git argv: ${args.join(" ")}`);
	};
	return { runGit, calls };
}

function captureWith(options: GitFixtureOptions = {}) {
	const git = gitFixture(options);
	const cleanup = vi.fn();
	const readMaterializedTarget = vi.fn(() => TARGET);
	const selectTests = vi.fn(() => ({ tests: ["src/z.test.ts", "src/a.test.ts"] }));
	const captured = captureMutationOnboardingSource(
		{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
		{
			runGit: git.runGit,
			realpath: (path) => path,
			materialize: (archiveBytes) => {
				expect(Buffer.from(archiveBytes)).toEqual(ARCHIVE);
				return { root: "/materialized-head", cleanup };
			},
			readMaterializedTarget,
			selectTests,
		},
	);
	return { captured, calls: git.calls, cleanup, readMaterializedTarget, selectTests };
}

describe("captureMutationOnboardingSource", () => {
	it("captures exact HEAD bytes under the explicit versioned archive contract", () => {
		const { captured, calls, cleanup, readMaterializedTarget, selectTests } = captureWith();
		expect(captured).toMatchObject({
			format: "git-archive-tar-v1",
			archivePrefix: "interlinked-source-v1/",
			repository: "github.com/example/repo",
			commit: HEAD,
			targetFile: "src/answer.ts",
			targetSha256: digest(TARGET),
			sourceArtifactId: `src_git_archive_v1_${digest(ARCHIVE)}`,
			sourceArtifactSha256: digest(ARCHIVE),
			scopeMode: "import_graph",
			testFiles: ["src/a.test.ts", "src/z.test.ts"],
		});
		expect(Buffer.from(captured.targetBytes)).toEqual(TARGET);
		expect(Buffer.from(captured.sourceArtifactBytes)).toEqual(ARCHIVE);
		expect(selectTests).toHaveBeenCalledWith({
			editedRelPath: "src/answer.ts",
			projectRoot: "/materialized-head",
		});
		expect(selectTests).not.toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/repo" }));
		expect(readMaterializedTarget).toHaveBeenCalledWith("/materialized-head", "src/answer.ts");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(calls.map(({ args }) => args)).toEqual([
			["rev-parse", "--show-toplevel"],
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			["rev-parse", "--verify", "HEAD^{commit}"],
			["ls-tree", "-rz", "--full-tree", HEAD],
			["cat-file", "-s", TARGET_OID],
			["cat-file", "blob", TARGET_OID],
			["archive", "--format=tar", `--prefix=${MUTATION_ONBOARDING_ARCHIVE_PREFIX}`, HEAD],
			["rev-parse", "--verify", "HEAD^{commit}"],
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		]);
		expect(calls.find(({ args }) => args[0] === "archive")?.maxBytes).toBe(MAX_SOURCE_ARTIFACT_BYTES);
		expect(MUTATION_ONBOARDING_SOURCE_FORMAT).toBe("git-archive-tar-v1");
		expect(MUTATION_ONBOARDING_ARCHIVE_FORMAT_CONTRACT).toEqual({
			format: "git-archive-tar-v1",
			command: "git archive --format=tar --prefix=interlinked-source-v1/ <full-HEAD>",
			prefix: "interlinked-source-v1/",
			compression: "none",
		});
	});

	it.each([
		["staged", "M  src/answer.ts\0"],
		["unstaged", " M src/answer.ts\0"],
		["untracked", "?? scratch.ts\0"],
	])("rejects a %s worktree before reading HEAD or artifact bytes", (_kind, status) => {
		const git = gitFixture({ statuses: [bytes(status)] });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("requires a clean staged, unstaged, and untracked worktree");
		expect(git.calls.map(({ args }) => args[0])).toEqual(["rev-parse", "status"]);
	});

	it("rejects a target absent from immutable HEAD", () => {
		const git = gitFixture({ tree: regularTree("src/other.ts") });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("not a tracked file at immutable HEAD");
	});

	it.each([
		["symlink", `120000 blob ${TARGET_OID}\tsrc/answer.ts\0`],
		["submodule", `160000 commit ${TARGET_OID}\tsrc/answer.ts\0`],
		["non-regular", `100600 blob ${TARGET_OID}\tsrc/answer.ts\0`],
	])("rejects a %s entry before materialization", (kind, tree) => {
		const git = gitFixture({ tree });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow(kind);
		expect(git.calls.some(({ args }) => args[0] === "archive")).toBe(false);
	});

	it("rejects an oversized target before reading its blob", () => {
		const git = gitFixture({ targetSize: String(MAX_TARGET_SOURCE_BYTES + 1) });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow(`exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`);
		expect(git.calls.some(({ args }) => args[0] === "archive")).toBe(false);
	});

	it("rejects a foreign repository root before inspecting status", () => {
		const git = gitFixture({ top: "/other-repo" });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("not the root of the captured Git repository");
		expect(git.calls).toHaveLength(1);
	});

	it.each([
		["HEAD", { heads: [HEAD, NEXT_HEAD] }],
		["status", { statuses: [new Uint8Array(), bytes("?? raced.ts\0")] }],
	] satisfies Array<[string, GitFixtureOptions]>)
		("rejects a %s race after materialized-snapshot test selection", (_kind, options) => {
			expect.hasAssertions();
			const git = gitFixture(options);
			const cleanup = vi.fn();
			expect(() => captureMutationOnboardingSource(
				{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
				{
					runGit: git.runGit,
					realpath: (path) => path,
					materialize: () => ({ root: "/materialized-head", cleanup }),
					readMaterializedTarget: () => TARGET,
					selectTests: () => ({ tests: [] }),
				},
			)).toThrow("HEAD or status changed");
			expect(cleanup).toHaveBeenCalledOnce();
	});

	it.each([
		["missing", missingMaterializedTarget, "missing"],
		["foreign", foreignMaterializedTarget, "differs"],
	] as const)("rejects a %s target in the materialized archive", (_kind, readTarget, reason) => {
		expect.hasAssertions();
		const git = gitFixture();
		const cleanup = vi.fn();
		const selectTests = vi.fn(() => ({ tests: [] }));
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{
				runGit: git.runGit,
				realpath: (path) => path,
				materialize: () => ({ root: "/materialized-head", cleanup }),
				readMaterializedTarget: readTarget,
				selectTests,
			},
		)).toThrow(reason);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(selectTests).not.toHaveBeenCalled();
	});

	it("cleans the materialized snapshot when test selection fails", () => {
		const git = gitFixture();
		const cleanup = vi.fn();
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{
				runGit: git.runGit,
				realpath: (path) => path,
				materialize: () => ({ root: "/materialized-head", cleanup }),
				readMaterializedTarget: () => TARGET,
				selectTests: () => {
					throw new Error("snapshot graph failed");
				},
			},
		)).toThrow("snapshot graph failed");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(git.calls.filter(({ args }) => args[0] === "status")).toHaveLength(1);
	});
});
