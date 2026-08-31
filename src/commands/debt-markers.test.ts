import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    loadManualDebtMarkerSnapshotReceipts,
    manualDebtMarkerSnapshotsPath,
} from "../lib/manual-debt-marker-record.js";
import { debtMarkersCommand } from "./debt-markers.js";

let root = "";
let output: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "debt-markers-command-"));
    mkdirSync(join(root, "src"), { recursive: true });
    output = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
        output.push(String(value));
    });
});

afterEach(() => {
    logSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
});

describe("interlinked debt markers", () => {
    it("emits a structured read-only JSON report", async () => {
        writeFileSync(
            join(root, "src", "cache.ts"),
            '// interlinked-debt: {"decision":"one cache","ceiling":"10k keys","trigger":"keys >= 10000 items"}\n',
        );
        await debtMarkersCommand({ cwd: root, json: true });
        const parsed: unknown = JSON.parse(output.join("\n"));
        expect(parsed).toMatchObject({
            schema_version: 1,
            source: "source-comments",
            repository: { root },
            obligation_ledger: { consulted: false, mutated: false },
            read_only: true,
        });
        expect(existsSync(manualDebtMarkerSnapshotsPath(root))).toBe(false);
    });

    it("qualifies an empty result by its covered scope", async () => {
        await debtMarkersCommand({ cwd: root });
        const rendered = output.join("\n");
        expect(rendered).toContain("No markers found in the covered source scope");
        expect(rendered).toContain("Obligation ledger: not consulted; not modified");
    });

    it("records only when explicitly requested while preserving canonical JSON stdout", async () => {
        writeFileSync(
            join(root, "src", "cache.ts"),
            '// interlinked-debt: {"id":"cache","decision":"one cache","ceiling":"10k keys","trigger":"keys >= 10000 items"}\n',
        );
        await debtMarkersCommand({ cwd: root, json: true, record: true, reason: "baseline" });
        const parsed: unknown = JSON.parse(output.join("\n"));
        expect(parsed).toMatchObject({ source: "source-comments", read_only: true });
        const receipts = loadManualDebtMarkerSnapshotReceipts(root);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ reason: "baseline" });
        expect(receipts[0]?.transitions).toHaveLength(1);
    });

    it("rejects --reason without --record", async () => {
        await expect(debtMarkersCommand({ cwd: root, reason: "orphan reason" })).rejects.toThrow(
            "--reason requires --record",
        );
        expect(existsSync(manualDebtMarkerSnapshotsPath(root))).toBe(false);
    });
});
