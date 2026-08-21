import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "../lib/checkpoints.js";

vi.mock("../lib/checkpoints.js", () => ({
    compareCheckpoints: vi.fn(),
    getCheckpoint: vi.fn(),
    listCheckpoints: vi.fn(),
}));

import { compareCheckpoints, getCheckpoint, listCheckpoints } from "../lib/checkpoints.js";
import {
    checkpointCompareCommand,
    checkpointListCommand,
    checkpointShowCommand,
} from "./checkpoint.js";

const mocked = {
    compare: vi.mocked(compareCheckpoints),
    get: vi.mocked(getCheckpoint),
    list: vi.mocked(listCheckpoints),
};

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
    return {
        id: "cp-1",
        session_id: "session-1",
        agent: "agent-1",
        message: "message",
        timestamp: "2099-01-01T00:00:00.000Z",
        base_commit: "0123456789abcdef",
        trigger: "manual",
        files_changed: ["src/file.ts"],
        restorable: true,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
});

describe("checkpoint list rendering", () => {
    // test-contract: a 30-character message remains untruncated and the table retains its headers.
    it("keeps the exact truncation boundary and renders table headers", () => {
        const message = "x".repeat(30);
        mocked.list.mockReturnValue([checkpoint({ message })]);

        checkpointListCommand({});

        const output = String(log.mock.calls[0]?.[0]);
        expect(output).toContain("ID");
        expect(output).toContain("Message");
        expect(output).toContain(message);
        expect(output).not.toContain("...");
    });

    // test-contract: omitted filters are not forwarded as properties to the data-layer request.
    it("forwards only filters that were supplied", () => {
        mocked.list.mockReturnValue([]);

        checkpointListCommand({});

        expect(mocked.list).toHaveBeenCalledWith({});
    });
});

describe("checkpoint show rendering", () => {
    // test-contract: exactly 30 changed files are all displayed without an overflow line.
    it("keeps the exact file-list boundary", () => {
        const files = Array.from({ length: 30 }, (_, index) => `file-${index}.ts`);
        mocked.get.mockReturnValue(checkpoint({ files_changed: files }));

        checkpointShowCommand("cp-1", {});

        const output = String(log.mock.calls[0]?.[0]);
        expect(output).toContain("Files changed (30)");
        expect(output).toContain("file-29.ts");
        expect(output).not.toContain("more");
    });
});

describe("checkpoint compare rendering", () => {
    // test-contract: an empty diff summary produces no summary line in normal output.
    it("omits an empty diff summary", () => {
        mocked.compare.mockReturnValue({
            files_added: [],
            files_modified: [],
            files_deleted: [],
            diff_summary: "",
        });

        checkpointCompareCommand("cp-1", "cp-2", {});

        const output = String(log.mock.calls[0]?.[0]);
        expect(output).toContain("Compare cp-1 → cp-2");
        expect(output).toContain("Added");
        expect(output).toContain("Modified");
        expect(output).toContain("Deleted");
        expect(output).not.toContain("Stryker was here");
        expect(error).not.toHaveBeenCalled();
    });
});
