import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleTrace, loadTrace } from "./trace-assembler.js";

const cleanups: string[] = [];
afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "mutation-session";

function tempFixture(): string {
    const cwd = mkdtempSync(join(tmpdir(), "trace-mutation-"));
    cleanups.push(cwd);
    mkdirSync(join(cwd, ".interlinked", "replay", "snapshots"), { recursive: true });
    return cwd;
}

function collection(cwd: string, rows: object[]): void {
    appendFileSync(
        join(cwd, ".interlinked", "collection.jsonl"),
        rows.map((row) => JSON.stringify({
            schema: "collection.v1",
            kind: "tool_event",
            session_id: SESSION,
            ...row,
        })).join("\n") + "\n",
    );
}

function snapshot(cwd: string, row: object): void {
    appendFileSync(
        join(cwd, ".interlinked", "replay", "snapshots", "index.jsonl"),
        JSON.stringify({
            schema: "tree-snapshot.v1",
            session_id: SESSION,
            backend: "git",
            commit: "commit",
            ts: "t",
            ...row,
        }) + "\n",
    );
}

describe("assembleTrace mutation contracts", () => {
    // test-contract: no matched envelope must report zero stamped envelopes and must not create the optional output file.
    it("does not create a per-session envelope file when no envelope was joined", () => {
        const cwd = tempFixture();
        collection(cwd, [{
            phase: "pre",
            seq: 1,
            tool_use_id: "toolu-no-envelope",
            ts: "t1",
            provider_tool: "Bash",
            action: { command: "echo" },
        }]);

        const summary = assembleTrace(cwd, SESSION);

        expect(summary).toEqual({ steps: 1, steps_with_envelope: 0 });
        expect(() => readFileSync(join(
            cwd,
            ".interlinked",
            "replay",
            "inference",
            SESSION + ".jsonl",
        ), "utf-8")).toThrow();
    });

    // test-contract: collection and snapshot joins are session-scoped, so foreign rows cannot create steps or annotate local steps.
    it("keeps collection rows and snapshots scoped to the requested session", () => {
        const cwd = tempFixture();
        collection(cwd, [
            {
                phase: "pre",
                seq: 1,
                tool_use_id: "toolu-right",
                ts: "t1",
                provider_tool: "Read",
                action: { path: "right" },
            },
            {
                session_id: "other-session",
                phase: "pre",
                seq: 2,
                tool_use_id: "toolu-other",
                ts: "t2",
                provider_tool: "Write",
                action: { path: "other" },
            },
        ]);
        snapshot(cwd, { session_id: "other-session", tool_use_id: "toolu-right", phase: "pre", tree: "wrong-tree" });

        const summary = assembleTrace(cwd, SESSION);
        const steps = loadTrace(cwd, SESSION);

        expect(summary.steps).toBe(1);
        expect(steps).toHaveLength(1);
        expect(steps[0]?.pre_tree).toBeNull();
    });

    // test-contract: non-string tool ids and sequences are normalized to null rather than being treated as valid join and ordering keys.
    it("rejects malformed tool ids and preserves numeric sequence semantics", () => {
        const cwd = tempFixture();
        collection(cwd, [
            {
                phase: "pre",
                seq: "10",
                tool_use_id: 42,
                ts: "t-10",
                provider_tool: "Bash",
                action: { command: "ten" },
            },
            {
                phase: "pre",
                seq: 2,
                tool_use_id: "toolu-two",
                ts: "t-2",
                provider_tool: "Bash",
                action: { command: "two" },
            },
        ]);

        const summary = assembleTrace(cwd, SESSION);
        const assembled = loadTrace(cwd, SESSION);

        expect(summary.steps).toBe(2);
        expect(assembled.map((step) => step.key)).toEqual([
            { session_id: SESSION, seq: 2, tool_use_id: "toolu-two", ts: "t-2" },
            { session_id: SESSION, seq: null, tool_use_id: null, ts: "t-10" },
        ]);
    });

    // test-contract: a present post row with a non-string outcome must use the documented "ok" fallback while retaining its observation.
    it("uses the first valid post row and defaults only a non-string outcome to ok", () => {
        const cwd = tempFixture();
        collection(cwd, [
            {
                phase: "pre",
                seq: 1,
                tool_use_id: "toolu-post",
                ts: "t1",
                provider_tool: "Bash",
                action: { command: "run" },
            },
            {
                phase: "post",
                seq: 2,
                tool_use_id: "toolu-post",
                ts: "t2",
                outcome: 7,
                observation: { output: "x" },
            },
        ]);

        assembleTrace(cwd, SESSION);
        expect(loadTrace(cwd, SESSION)[0]?.result).toEqual({
            outcome: "ok",
            observation: { output: "x" },
        });
    });

    // test-contract: numeric sequence ordering must precede timestamp fallback, placing missing-sequence rows after all numeric rows.
    it("sorts numeric sequence values before timestamp fallback for missing sequences", () => {
        const cwd = tempFixture();
        collection(cwd, [
            {
                phase: "pre",
                seq: 2,
                tool_use_id: "toolu-two",
                ts: "z",
                provider_tool: "Bash",
                action: { command: "two" },
            },
            {
                phase: "pre",
                ts: "a",
                tool_use_id: "toolu-missing",
                provider_tool: "Bash",
                action: { command: "missing" },
            },
            {
                phase: "pre",
                seq: 1,
                tool_use_id: "toolu-one",
                ts: "y",
                provider_tool: "Bash",
                action: { command: "one" },
            },
        ]);

        assembleTrace(cwd, SESSION);
        expect(loadTrace(cwd, SESSION).map((step) => step.key.tool_use_id)).toEqual([
            "toolu-one",
            "toolu-two",
            "toolu-missing",
        ]);
    });
});
