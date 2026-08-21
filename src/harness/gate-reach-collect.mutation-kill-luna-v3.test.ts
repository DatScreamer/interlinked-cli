import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    buildGateReachStopWarning,
    enumerateEligibleFiles,
    GATE_REACH_LEDGER_REL,
    readLatestGateReachSnapshot,
    shouldCollectGateReach,
} from "./gate-reach-collect.js";
import { buildGateReachSnapshot } from "./gate-reach.js";

let repo: string;

function write(rel: string, value: string): void {
    const path = join(repo, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, value, "utf-8");
}

function snapshot(sessionId: string, at: number) {
    return buildGateReachSnapshot({
        sessionId,
        at,
        inputs: [{ gate: "g", eligible: 1, measured: 1 }],
    });
}

beforeEach(() => {
    repo = join(tmpdir(), `gate-reach-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repo, { recursive: true });
});

afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
});

describe("gate reach survivor contracts", () => {
    // test-contract: candidate headers are read and closed, while unreadable candidates are excluded.
    it("fails soft for an unreadable candidate", () => {
        write("src/a.ts", "export const a = 1;\n");
        write("src/locked.ts", "export const locked = 1;\n");
        const locked = join(repo, "src/locked.ts");
        chmodSync(locked, 0o000);
        try {
            expect(enumerateEligibleFiles(repo)).toEqual(["src/a.ts"]);
        } finally {
            chmodSync(locked, 0o644);
        }
    });

    // test-contract: the supported JavaScript and TypeScript suffixes are accepted and unrelated suffixes are ignored.
    it("applies the complete code extension filter", () => {
        for (const name of ["a.js", "b.jsx", "c.ts", "d.tsx", "e.mjs", "f.mjsx", "g.mts", "h.mtsx"]) {
            write(`src/${name}`, "export const value = 1;\n");
        }
        write("src/no.py", "value = 1;\n");
        expect(enumerateEligibleFiles(repo)).toHaveLength(8);
    });

    // test-contract: an exactly 64KiB ledger remains readable without tail truncation.
    it("handles the exact tail boundary", () => {
        const base = snapshot("x", 1000);
        const sessionId = "x".repeat(65535 - JSON.stringify(base).length + 1);
        const row = snapshot(sessionId, 1000);
        const line = JSON.stringify(row) + "\n";
        expect(Buffer.byteLength(line)).toBe(65536);
        mkdirSync(join(repo, ".interlinked"), { recursive: true });
        writeFileSync(join(repo, GATE_REACH_LEDGER_REL), line, "utf-8");
        expect(readLatestGateReachSnapshot(repo)?.session_id).toBe(sessionId);
    });

    // test-contract: a larger ledger uses only its tail and returns the newest valid row.
    it("handles a ledger larger than the tail bound", () => {
        write(".interlinked/gate-reach.jsonl", ("x".repeat(2000) + "\n").repeat(40) + JSON.stringify(snapshot("tail", 1)) + "\n");
        expect(readLatestGateReachSnapshot(repo)?.session_id).toBe("tail");
    });

    // test-contract: absent, directory, blank, malformed, primitive, and null rows produce no snapshot while valid rows remain discoverable.
    it("fails soft across ledger shape failures", () => {
        expect(readLatestGateReachSnapshot(repo)).toBeNull();
        mkdirSync(join(repo, GATE_REACH_LEDGER_REL), { recursive: true });
        expect(readLatestGateReachSnapshot(repo)).toBeNull();
        rmSync(join(repo, GATE_REACH_LEDGER_REL), { recursive: true });
        write(".interlinked/gate-reach.jsonl", "\n   \n42\nnull\n");
        expect(readLatestGateReachSnapshot(repo)).toBeNull();
        write(".interlinked/gate-reach.jsonl", JSON.stringify(snapshot("good", 1)) + "\n\n");
        expect(readLatestGateReachSnapshot(repo)?.session_id).toBe("good");
    });

    // test-contract: zero and positive interval boundaries use subtraction and the nullish default correctly.
    it("honors throttle boundaries", () => {
        write(".interlinked/gate-reach.jsonl", JSON.stringify(snapshot("s", 1000)) + "\n");
        expect(shouldCollectGateReach({ cwd: repo, sessionId: "s", now: 1000, intervalMs: 0 })).toBe(true);
        expect(shouldCollectGateReach({ cwd: repo, sessionId: "s", now: 1999, intervalMs: 1000 })).toBe(false);
        expect(shouldCollectGateReach({ cwd: repo, sessionId: "s", now: 2000, intervalMs: 1000 })).toBe(true);
    });

    // test-contract: omitted and explicit Stop options have distinct observable gate selection and throttle behavior.
    it("preserves Stop option semantics", () => {
        write("src/a.ts", "export const a = 1;\n");
        const all = buildGateReachStopWarning({
            cwd: repo,
            sessionId: "all",
            perEditCoverageEnabled: false,
            now: 1000,
        });
        expect(all).toContain("gate=coverage_ratchet");
        expect(all).toContain("gate=per_edit_coverage");
        const selected = buildGateReachStopWarning({
            cwd: repo,
            sessionId: "selected",
            perEditCoverageEnabled: false,
            now: 1000,
            intervalMs: 0,
            gates: ["coverage_ratchet"],
        });
        expect(selected).not.toContain("gate=per_edit_coverage");
        expect(selected).toContain("gate=coverage_ratchet");
    });
});
