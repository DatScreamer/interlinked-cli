import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    detectBreakGlass,
    logBreakGlass,
    logPath,
    readBreakGlassLog,
    summarizeBreakGlass,
} from "./break-glass.js";

let cwd = "";
afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("break-glass mutation contracts", () => {
    // test-contract: logging creates the nested log directory when it does not exist.
    it("creates the log path from a bare working directory", () => {
        cwd = mkdtempSync(join(tmpdir(), "break-glass-"));
        logBreakGlass(cwd, {
            ts: "2026-01-01T00:00:00.000Z",
            user: "u",
            session_id: "s",
            tool: "t",
            reason: null,
            commit_sha: null,
        });
        expect(readBreakGlassLog(cwd)).toEqual([
            {
                ts: "2026-01-01T00:00:00.000Z",
                user: "u",
                session_id: "s",
                tool: "t",
                reason: null,
                commit_sha: null,
            },
        ]);
    });

    // test-contract: an empty same-line reason is represented as null.
    it("does not turn an empty reason into an empty string", () => {
        expect(detectBreakGlass("break glass:").reason).toBeNull();
        expect(detectBreakGlass("break glass -   ").reason).toBeNull();
    });

    // test-contract: parsed non-string optional fields are normalized to null.
    it("normalizes invalid optional log fields", () => {
        cwd = mkdtempSync(join(tmpdir(), "break-glass-"));
        mkdirSync(join(cwd, ".interlinked"));
        writeFileSync(
            logPath(cwd),
            JSON.stringify({
                ts: "2026-01-01T00:00:00.000Z",
                user: "u",
                session_id: "s",
                tool: "t",
                reason: 7,
                commit_sha: false,
            }) + "\n",
        );
        expect(readBreakGlassLog(cwd)).toEqual([
            {
                ts: "2026-01-01T00:00:00.000Z",
                user: "u",
                session_id: "s",
                tool: "t",
                reason: null,
                commit_sha: null,
            },
        ]);
    });

    // test-contract: timestamps exactly at the cutoff remain inside the requested window.
    it("includes the cutoff timestamp", () => {
        cwd = mkdtempSync(join(tmpdir(), "break-glass-"));
        const now = 1_000_000;
        const cutoff = new Date(now - 1_000).toISOString();
        logBreakGlass(cwd, {
            ts: cutoff,
            user: "u",
            session_id: "s",
            tool: "t",
            reason: null,
            commit_sha: null,
        });
        expect(summarizeBreakGlass(cwd, 1_000, () => now)).toEqual({
            recent_count: 1,
            since: cutoff,
            distinct_days: 1,
        });
    });
});
