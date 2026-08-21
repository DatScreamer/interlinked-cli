import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    classifyRow,
    enforcementLedgerPath,
    loadEnforcementLedger,
    updateEnforcementLedger,
} from "./enforcement-ledger.js";

const AT = "2026-08-20T00:00:00.000Z";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-mutant-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("loadEnforcementLedger", () => {
    // test-contract: a missing ledger returns the exact empty ledger shape.
    it("returns empty state when the ledger file is absent", () => {
        expect(loadEnforcementLedger(dir)).toEqual({
            version: 1,
            since: "",
            cursor: 0,
            blocked: 0,
            caught: 0,
            evaluated: 0,
        });
    });

    // test-contract: malformed field values are normalized without losing valid fields.
    it("normalizes invalid and fractional counters and preserves a valid timestamp", () => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            enforcementLedgerPath(dir),
            JSON.stringify({
                version: 99,
                since: 42,
                cursor: -1,
                blocked: 2.9,
                caught: "3",
                evaluated: 0,
            }),
        );
        expect(loadEnforcementLedger(dir)).toEqual({
            version: 1,
            since: "",
            cursor: 0,
            blocked: 2,
            caught: 0,
            evaluated: 0,
        });
    });

    // test-contract: valid JSON arrays are rejected as non-object ledger data.
    it("rejects a top-level array", () => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(enforcementLedgerPath(dir), "[1]");
        expect(loadEnforcementLedger(dir).cursor).toBe(0);
    });
});

describe("classifyRow", () => {
    // test-contract: primitive rows contribute no enforcement outcomes.
    it("ignores primitive input", () => {
        expect(classifyRow(7)).toEqual({ blocked: 0, caught: 0, evaluated: 0 });
    });
});

describe("updateEnforcementLedger", () => {
    // test-contract: a complete activity row is counted and persisted.
    it("counts a complete row and writes the resulting ledger", () => {
        writeFileSync(join(dir, "activity.jsonl"), '{"type":"guard_block"}\n');
        const result = updateEnforcementLedger(dir, AT);
        expect(result).toMatchObject({ blocked: 1, evaluated: 1, since: AT });
        expect(loadEnforcementLedger(dir).blocked).toBe(1);
    });

    // test-contract: appending after the cursor counts only the newly appended row.
    it("advances from the stored cursor without recounting", () => {
        writeFileSync(join(dir, "activity.jsonl"), '{"type":"guard_warn"}\n');
        const first = updateEnforcementLedger(dir, AT);
        appendFileSync(join(dir, "activity.jsonl"), '{"type":"guard_block"}\n');
        const second = updateEnforcementLedger(dir, AT);
        expect(first.caught).toBe(1);
        expect(second).toMatchObject({ blocked: 1, caught: 1, evaluated: 2 });
        expect(second.cursor).toBeGreaterThan(first.cursor);
    });
});
