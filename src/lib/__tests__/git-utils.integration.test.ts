import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
	deriveProjectIdentity,
	getCommitMessage,
	getCurrentBranch,
	getGitToplevel,
	getHeadSha,
	getStagedFiles,
	isGitRepo,
	parseInterlinkedTrailers,
} from "../git-utils.js";

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
	vi.restoreAllMocks();
	mockExecFileSync.mockImplementation(() => "");
});

function setupGitMock(responses: (string | Error)[]) {
	let callIndex = 0;
	mockExecFileSync.mockImplementation(() => {
		const response = responses[callIndex] || "";
		callIndex++;
		if (response instanceof Error) throw response;
		return response;
	});
}

describe("isGitRepo", () => {
	it("returns true in a git repo", () => {
		setupGitMock([".git"]);
		expect(isGitRepo("/test/cwd")).toBe(true);
	});

	it("returns false outside a git repo", () => {
		setupGitMock([new Error("not a git repo")]);
		expect(isGitRepo("/test/cwd")).toBe(false);
	});
});

describe("getCurrentBranch", () => {
	it("returns branch name", () => {
		setupGitMock(["main"]);
		expect(getCurrentBranch("/test/cwd")).toBe("main");
	});

	it("returns null for detached HEAD", () => {
		setupGitMock([""]);
		expect(getCurrentBranch("/test/cwd")).toBeNull();
	});

	it("returns null on error", () => {
		setupGitMock([new Error("error")]);
		expect(getCurrentBranch("/test/cwd")).toBeNull();
	});
});

describe("getHeadSha", () => {
	it("returns short SHA by default", () => {
		setupGitMock(["abc123f"]);
		expect(getHeadSha("/test/cwd")).toBe("abc123f");
	});

	it("returns full SHA when short=false", () => {
		setupGitMock(["abc123f456789abcdef012345678901234567890"]);
		expect(getHeadSha("/test/cwd", false)).toBe("abc123f456789abcdef012345678901234567890");
	});

	it("returns null on error", () => {
		setupGitMock([new Error("error")]);
		expect(getHeadSha("/test/cwd")).toBeNull();
	});
});

describe("getCommitMessage", () => {
	it("returns commit message", () => {
		setupGitMock(["Fix bug in auth flow"]);
		expect(getCommitMessage("HEAD", "/test/cwd")).toBe("Fix bug in auth flow");
	});

	it("returns null on error", () => {
		setupGitMock([new Error("bad ref")]);
		expect(getCommitMessage("badref", "/test/cwd")).toBeNull();
	});
});

describe("getStagedFiles", () => {
	it("returns list of staged files", () => {
		setupGitMock(["src/index.ts\nsrc/lib/config.ts"]);
		expect(getStagedFiles("/test/cwd")).toEqual(["src/index.ts", "src/lib/config.ts"]);
	});

	it("returns empty array when nothing staged", () => {
		setupGitMock([""]);
		expect(getStagedFiles("/test/cwd")).toEqual([]);
	});

	it("returns empty array on error", () => {
		setupGitMock([new Error("error")]);
		expect(getStagedFiles("/test/cwd")).toEqual([]);
	});
});

describe("getGitToplevel", () => {
	it("returns toplevel path", () => {
		setupGitMock(["/Users/test/my-project"]);
		expect(getGitToplevel("/test/cwd")).toBe("/Users/test/my-project");
	});

	it("returns null on error", () => {
		setupGitMock([new Error("error")]);
		expect(getGitToplevel("/test/cwd")).toBeNull();
	});
});

describe("parseInterlinkedTrailers", () => {
	it("parses Interlinked trailers from commit message", () => {
		const msg = `Fix auth flow

Some body text.

Interlinked-Checkpoint: 42
Interlinked-Agent: Worker-Alpha
Interlinked-Tasks: #7,#8`;

		const trailers = parseInterlinkedTrailers(msg);
		expect(trailers["Interlinked-Checkpoint"]).toBe("42");
		expect(trailers["Interlinked-Agent"]).toBe("Worker-Alpha");
		expect(trailers["Interlinked-Tasks"]).toBe("#7,#8");
	});

	it("returns empty object for no trailers", () => {
		expect(parseInterlinkedTrailers("Simple commit message")).toEqual({});
	});

	it("ignores non-Interlinked trailers", () => {
		const msg = `Fix auth flow

Co-Authored-By: Claude <claude@anthropic.com>
Interlinked-Agent: Worker-Alpha
Signed-off-by: User <user@example.com>`;

		const trailers = parseInterlinkedTrailers(msg);
		expect(Object.keys(trailers)).toEqual(["Interlinked-Agent"]);
	});
});

describe("deriveProjectIdentity", () => {
	it("derives from SSH remote URL", () => {
		setupGitMock(["git@github.com:user/my-project.git"]);
		const result = deriveProjectIdentity("/test/cwd");
		expect(result.workspaceKey).toBe("my-project");
		expect(result.projectKey).toBe("main");
	});

	it("derives from HTTPS remote URL", () => {
		setupGitMock(["https://github.com/user/my-project.git"]);
		const result = deriveProjectIdentity("/test/cwd");
		expect(result.workspaceKey).toBe("my-project");
		expect(result.projectKey).toBe("main");
	});

	it("derives from HTTPS remote URL without .git", () => {
		setupGitMock(["https://github.com/user/my-project"]);
		const result = deriveProjectIdentity("/test/cwd");
		expect(result.workspaceKey).toBe("my-project");
	});

	it("falls back to toplevel directory name when no remote", () => {
		setupGitMock([
			new Error("fatal: No such remote 'origin'"), // remote get-url
			"/Users/user/my-cool-project", // show-toplevel
		]);
		const result = deriveProjectIdentity("/test/cwd");
		expect(result.workspaceKey).toBe("my-cool-project");
		expect(result.projectKey).toBe("main");
	});

	it("sanitizes special characters", () => {
		setupGitMock(["https://github.com/user/My_Cool Project!.git"]);
		const result = deriveProjectIdentity("/test/cwd");
		expect(result.workspaceKey).toBe("my-cool-project");
	});

	it("returns empty when no git info available", () => {
		setupGitMock([new Error("not a git repo"), new Error("not a git repo")]);
		const result = deriveProjectIdentity("/test/cwd");
		expect(result).toEqual({});
	});
});
