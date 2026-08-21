import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
    execFileSync: mocks.execFileSync,
}));

import {
    deriveProjectIdentity,
    getCommitMessage,
    getCurrentBranch,
    getGitToplevel,
    getHeadSha,
    getStagedFiles,
    isGitRepo,
    parseInterlinkedTrailers,
} from "./git-utils.js";

const cwd = "/repo/worktree";
const gitOptions = {
    cwd,
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
};

beforeEach(() => {
    mocks.execFileSync.mockReset();
});

describe("git command boundary", () => {
    // test-contract: public-api — git-backed helpers trim stdout and preserve the exact subprocess contract.
    it("uses git argv, cwd, encoding, timeout, stdio, and trims output", () => {
        mocks.execFileSync.mockReturnValue("  feature/branch\n");

        expect(getCurrentBranch(cwd)).toBe("feature/branch");
        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "git",
            ["branch", "--show-current"],
            gitOptions,
        );
    });

    // test-contract: boundary — both supported wrapping quote styles are removed while an argument's interior remains one argv item.
    it("parses quoted commit refs without shell evaluation", () => {
        mocks.execFileSync.mockReturnValue("message\n");

        expect(getCommitMessage("'feature branch'", cwd)).toBe("message");
        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "git",
            ["log", "-1", "--format=%B", "feature branch"],
            gitOptions,
        );

        mocks.execFileSync.mockClear();
        expect(getCommitMessage('"release candidate"', cwd)).toBe("message");
        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "git",
            ["log", "-1", "--format=%B", "release candidate"],
            gitOptions,
        );
    });

    // test-contract: invariant — command failures normalize to the documented null/false/empty public fallbacks.
    it("normalizes subprocess failures for each git query", () => {
        mocks.execFileSync.mockImplementation(() => {
            throw new Error("not a repository");
        });

        expect(isGitRepo(cwd)).toBe(false);
        expect(getCurrentBranch(cwd)).toBeNull();
        expect(getHeadSha(cwd)).toBeNull();
        expect(getCommitMessage("HEAD", cwd)).toBeNull();
        expect(getGitToplevel(cwd)).toBeNull();
        expect(getStagedFiles(cwd)).toEqual([]);
    });
});

describe("git query contracts", () => {
    // test-contract: public-api — the default HEAD query must request the short form, while false requests the full form.
    it("requests short and full HEAD shas with distinct argv", () => {
        mocks.execFileSync.mockReturnValue("abc123\n");

        expect(getHeadSha(cwd)).toBe("abc123");
        expect(mocks.execFileSync).toHaveBeenLastCalledWith(
            "git",
            ["rev-parse", "--short", "HEAD"],
            gitOptions,
        );

        expect(getHeadSha(cwd, false)).toBe("abc123");
        expect(mocks.execFileSync).toHaveBeenLastCalledWith(
            "git",
            ["rev-parse", "HEAD"],
            gitOptions,
        );
    });

    // test-contract: boundary — staged output is split by newline and blank records are filtered after outer stdout trimming.
    it("splits staged paths and filters blank records", () => {
        mocks.execFileSync.mockReturnValue("  one.txt\n\n two.txt \n");

        expect(getStagedFiles(cwd)).toEqual(["one.txt", " two.txt"]);
        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "git",
            ["diff", "--cached", "--name-only"],
            gitOptions,
        );
    });

    // test-contract: public-api — repository detection is true only when the git-dir query succeeds.
    it("uses the git-dir query for repository detection", () => {
        mocks.execFileSync.mockReturnValue(".git\n");

        expect(isGitRepo(cwd)).toBe(true);
        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "git",
            ["rev-parse", "--git-dir"],
            gitOptions,
        );
    });
});

describe("project identity", () => {
    // test-contract: boundary — SSH remotes use the repository component and produce the stable main project key.
    it("derives a slug from an SSH origin URL", () => {
        mocks.execFileSync.mockReturnValue("git@github.com:team/my-project.git\n");

        expect(deriveProjectIdentity(cwd)).toEqual({
            workspaceKey: "my-project",
            projectKey: "main",
        });
        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "git",
            ["remote", "get-url", "origin"],
            gitOptions,
        );
    });

    // test-contract: boundary — HTTPS remotes, including a dotted repository suffix, map to the same repository-name semantics.
    it("derives a slug from an HTTPS origin URL", () => {
        mocks.execFileSync.mockReturnValue("https://github.com/team/Payments.API.git\n");

        expect(deriveProjectIdentity(cwd)).toEqual({
            workspaceKey: "payments-api",
            projectKey: "main",
        });
    });

    // test-contract: invariant — an absent or unparsable remote falls back to the git toplevel basename.
    it("falls back to the toplevel directory when origin is unavailable", () => {
        mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
            if (args[0] === "remote") throw new Error("no origin");
            return "/Users/dev/my---local_repo\n";
        });

        expect(deriveProjectIdentity(cwd)).toEqual({
            workspaceKey: "my-local-repo",
            projectKey: "main",
        });
        expect(mocks.execFileSync).toHaveBeenNthCalledWith(
            2,
            "git",
            ["rev-parse", "--show-toplevel"],
            gitOptions,
        );
    });

    // test-contract: boundary — no remote and no toplevel metadata yields an empty identity rather than fabricated keys.
    it("returns an empty identity when no repository name can be found", () => {
        mocks.execFileSync.mockImplementation(() => {
            throw new Error("no metadata");
        });

        expect(deriveProjectIdentity(cwd)).toEqual({});
    });
});

describe("Interlinked trailers", () => {
    // test-contract: public-api — valid keys accept word characters and hyphens, and values are trimmed while preserving internal spaces.
    it("parses valid trailers and trims their values", () => {
        expect(
            parseInterlinkedTrailers(
                "Subject\nInterlinked-Checkpoint:   42  \nInterlinked-Workspace-ID:\tteam alpha\n",
            ),
        ).toEqual({
            "Interlinked-Checkpoint": "42",
            "Interlinked-Workspace-ID": "team alpha",
        });
    });

    // test-contract: boundary — the trailer expression requires a line-start boundary and must not match embedded lookalikes.
    it("rejects trailer-looking text after a non-trailer prefix", () => {
        expect(parseInterlinkedTrailers("prefix Interlinked-Checkpoint: 42")).toEqual({});
    });

    // test-contract: boundary — trailer keys require a word character and values require at least one non-newline character.
    it("rejects malformed keys and empty values", () => {
        expect(
            parseInterlinkedTrailers("Interlinked-: value\nInterlinked-Checkpoint:   \n"),
        ).toEqual({});
    });

    // test-contract: invariant — optional whitespace after the colon is part of the public trailer format.
    it("accepts a value immediately after the colon", () => {
        expect(parseInterlinkedTrailers("Interlinked-Checkpoint:42")).toEqual({
            "Interlinked-Checkpoint": "42",
        });
    });
});
