import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    agentIoLogPath,
    buildAgentIoRecord,
    emptyContent,
    prepareContent,
    recordAgentIo,
} from "./store.js";
import { INLINE_MAX_BYTES } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), "agent-io-store-"));
    tempDirs.push(cwd);
    return cwd;
}

function row(overrides: Partial<Parameters<typeof buildAgentIoRecord>[0]> = {}) {
    return {
        ts: "2026-08-20T00:00:00.000Z",
        runner: "test",
        direction: "output" as const,
        role: "assistant" as const,
        kind: "final_message" as const,
        source: "payload" as const,
        raw: "result",
        ...overrides,
    };
}

describe("agent-io store mutation contracts", () => {
    // test-contract: empty content is an unavailable placeholder without claiming truncation or scrubbing.
    it("preserves empty-content placeholder flags", () => {
        expect(emptyContent()).toMatchObject({
            content: null,
            content_ref: null,
            content_bytes: 0,
            truncated: false,
            scrubbed: false,
            redaction_passes: [],
        });
    });

    // test-contract: inline content remains captured and untruncated at the exact inline ceiling.
    it("keeps content at the inline boundary", () => {
        const cwd = makeCwd();
        const content = prepareContent("x".repeat(INLINE_MAX_BYTES), cwd);
        expect(content.content).toHaveLength(INLINE_MAX_BYTES);
        expect(content.content_ref).toBeNull();
        expect(content.truncated).toBe(false);
        expect(content.scrubbed).toBe(true);
        expect(content.content_bytes).toBe(INLINE_MAX_BYTES);
    });

    // test-contract: default record metadata reports capturability and an untruncated tool-id list accurately.
    it("uses honest defaults for a normal record", () => {
        const record = buildAgentIoRecord(row(), makeCwd());
        expect(record.input_capturable).toBe(true);
        expect(record.tool_use_ids).toBeNull();
        expect(record.tool_use_ids_truncated).toBe(false);
    });

    // test-contract: a list exactly at the configured cap is retained and is not marked truncated.
    it("does not truncate tool-use ids at the cap", () => {
        const ids = Array.from({ length: 2000 }, (_, index) => `tool-${index}`);
        const record = buildAgentIoRecord(row({ tool_use_ids: ids }), makeCwd());
        expect(record.tool_use_ids).toEqual(ids);
        expect(record.tool_use_ids_truncated).toBe(false);
    });

    // test-contract: dry-run capture returns zero and leaves no log or directory behind.
    it("refuses all dry-run persistence", () => {
        const cwd = makeCwd();
        expect(recordAgentIo([row()], { cwd, dryRun: true })).toBe(0);
        expect(existsSync(agentIoLogPath(cwd))).toBe(false);
        expect(existsSync(join(cwd, ".interlinked"))).toBe(false);
    });

    // test-contract: a normal capture appends exactly one serialized record to the public log path.
    it("persists a non-dry-run record", () => {
        const cwd = makeCwd();
        expect(recordAgentIo([row()], { cwd })).toBe(1);
        const lines = readFileSync(agentIoLogPath(cwd), "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!).content).toBe("result");
    });
});
