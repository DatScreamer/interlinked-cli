import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    loadManualDebtMarkerSnapshotReceipts,
    manualDebtMarkerSnapshotFingerprint,
    manualDebtMarkerSnapshotsPath,
    parseManualDebtMarkerSnapshotReceipt,
    recordManualDebtMarkerSnapshot,
} from "./manual-debt-marker-record.js";
import { scanManualDebtMarkers } from "./manual-debt-markers.js";

let root = "";

function write(rel: string, content: string): void {
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
}

function marker(fields: { ceiling: string; trigger: string }): string {
    return `// interlinked-debt: ${JSON.stringify({
        id: "cache-bound",
        decision: "single-process cache",
        ceiling: fields.ceiling,
        trigger: fields.trigger,
    })}\n`;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "manual-debt-record-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("manual debt-marker snapshot recording", () => {
    it("opens a new marker without treating line movement as a content change", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        const first = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        expect(first).toMatchObject({ opened: 1, changed: 0, closed: 0 });

        write(
            "src/cache.ts",
            `const unrelated = true;\n${marker({ ceiling: "10k keys", trigger: "keys > 10000 items" })}`,
        );
        const movedLine = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T11:00:00.000Z" },
        );
        expect(movedLine).toMatchObject({ opened: 0, changed: 0, closed: 0 });
    });

    it("changes a stable explicit id when its semantic content changes", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        write("src/cache.ts", marker({ ceiling: "20k keys", trigger: "keys > 20000 items" }));
        const changed = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T12:00:00.000Z", reason: "capacity review" },
        );
        expect(changed).toMatchObject({ opened: 0, changed: 1, closed: 0 });
        expect(changed.receipt.transitions[0]).toMatchObject({
            action: "changed",
            before: { ceiling: "10k keys" },
            after: { ceiling: "20k keys" },
        });
    });

    it("closes a marker only after its source receipt is removed", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        const first = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        write("src/cache.ts", "export const cache = new Map();\n");
        const closed = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T13:00:00.000Z", reason: "distributed cache shipped" },
        );
        expect(closed).toMatchObject({ opened: 0, changed: 0, closed: 1 });
        expect(closed.receipt.reason).toBe("distributed cache shipped");
        expect(closed.receipt.scan.obligation_ledger).toEqual({ consulted: false, mutated: false });

        const history = loadManualDebtMarkerSnapshotReceipts(root);
        expect(history).toHaveLength(2);
        expect(history[1]?.previous_snapshot_fingerprint).toBe(first.receipt.snapshot_fingerprint);
    });

    it("does not close markers omitted by a narrower recording scope", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        write("other/unrelated.ts", "export const unrelated = true;\n");
        const narrow = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root, roots: ["other"] }),
            root,
            { now: "2026-08-30T11:00:00.000Z" },
        );
        expect(narrow).toMatchObject({ opened: 0, changed: 0, closed: 0 });
        expect(narrow.receipt.transitions).toEqual([]);
        expect(narrow.receipt.materialized_markers).toHaveLength(1);

        const full = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T12:00:00.000Z" },
        );
        expect(full).toMatchObject({ opened: 0, changed: 0, closed: 0 });
        expect(full.receipt.materialized_markers).toHaveLength(1);
    });

    it("retains valid history across tampered and torn rows", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        const first = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        appendFileSync(
            manualDebtMarkerSnapshotsPath(root),
            `${JSON.stringify({ ...first.receipt, snapshot_fingerprint: "tampered" })}\n{torn`,
        );
        const second = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T11:00:00.000Z" },
        );
        expect(loadManualDebtMarkerSnapshotReceipts(root)).toEqual([first.receipt, second.receipt]);
        expect(parseManualDebtMarkerSnapshotReceipt({
            ...first.receipt,
            snapshot_fingerprint: "tampered",
        })).toBeNull();
    });

    it("rejects a content-addressed row whose lifecycle is not derived from prior state", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        const first = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        const fabricated = structuredClone(first.receipt);
        fabricated.previous_snapshot_fingerprint = first.receipt.snapshot_fingerprint;
        fabricated.recorded_at = "2026-08-30T11:00:00.000Z";
        fabricated.materialized_markers = [];
        fabricated.transitions = [];
        fabricated.snapshot_fingerprint = manualDebtMarkerSnapshotFingerprint({
            previous_snapshot_fingerprint: fabricated.previous_snapshot_fingerprint,
            recorded_at: fabricated.recorded_at,
            reason: fabricated.reason,
            scan: fabricated.scan,
            materialized_markers: fabricated.materialized_markers,
            transitions: fabricated.transitions,
        });
        appendFileSync(manualDebtMarkerSnapshotsPath(root), `${JSON.stringify(fabricated)}\n`);
        expect(parseManualDebtMarkerSnapshotReceipt(fabricated)).not.toBeNull();
        expect(loadManualDebtMarkerSnapshotReceipts(root)).toEqual([first.receipt]);
    });

    it("rejects an empty reason and a scan from a different repository root", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        const scan = scanManualDebtMarkers({ cwd: root });
        expect(() => recordManualDebtMarkerSnapshot(scan, root, { reason: "   " })).toThrow(
            "record reason must not be empty",
        );
        expect(() => recordManualDebtMarkerSnapshot(scan, join(root, "other"))).toThrow(
            "repository does not match",
        );
    });

	it("rejects traversal paths and inconsistent coverage at the receipt boundary", () => {
        write("src/cache.ts", marker({ ceiling: "10k keys", trigger: "keys > 10000 items" }));
        const recorded = recordManualDebtMarkerSnapshot(
            scanManualDebtMarkers({ cwd: root }),
            root,
            { now: "2026-08-30T10:00:00.000Z" },
        );
        const traversal = structuredClone(recorded.receipt);
        traversal.scan.markers[0]!.file = "../outside.ts";
        expect(parseManualDebtMarkerSnapshotReceipt(traversal)).toBeNull();

        const mismatchedCoverage = structuredClone(recorded.receipt);
        mismatchedCoverage.scan.coverage.files_scanned++;
        expect(parseManualDebtMarkerSnapshotReceipt(mismatchedCoverage)).toBeNull();

        const duplicateMaterialized = structuredClone(recorded.receipt);
        duplicateMaterialized.materialized_markers.push(
            structuredClone(duplicateMaterialized.materialized_markers[0]!),
        );
		expect(parseManualDebtMarkerSnapshotReceipt(duplicateMaterialized)).toBeNull();

		const invalidTimestamp = structuredClone(recorded.receipt);
		invalidTimestamp.recorded_at = "not-a-timestamp";
		expect(parseManualDebtMarkerSnapshotReceipt(invalidTimestamp)).toBeNull();
	});
});
