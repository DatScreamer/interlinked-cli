import { describe, expect, it } from "vitest";
import { type CoverageDebtInput, decideCoverageDebt, isRedBarBlock, isUncoveredBlock, relatedToDebt } from "./coverage-debt.js";
import { type Obligation, obligationId } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

const source = "src/luna.ts";
function debt(file = source, kind: "coverage" | "red_suite" = "coverage", sessionId = "session", failingTestFiles?: string[]): Obligation {
    return { id: obligationId(kind, file), kind, file, contentHash: "hash", status: "open", sessionId, openedAtMs: 10, ...(failingTestFiles === undefined ? {} : { failingTestFiles }) };
}
function uncovered(file = source): HarnessDecision {
    return { decision: "block", reason: `${file} is uncovered by the test suite`, rule_id: "coverage", severity: "medium", category: "coverage" };
}
function red(failingTestFiles?: string[]): HarnessDecision {
    return { decision: "block", reason: "this edit leaves the test suite RED", rule_id: "coverage", severity: "medium", category: "coverage", ...(failingTestFiles === undefined ? {} : { failing_test_files: failingTestFiles }) };
}
function run(overrides: Partial<CoverageDebtInput>): ReturnType<typeof decideCoverageDebt> {
    return decideCoverageDebt({ baseDecision: null, editedFile: source, openDebts: [], rechecks: new Map(), sessionId: "session", atMs: 99, ...overrides });
}

describe("coverage debt mutation boundaries", () => {
    // test-contract: public-api — only a blocked verdict with the exact uncovered marker enters coverage debt mode.
    it("distinguishes uncovered blocks from other verdict shapes", () => {
        expect(isUncoveredBlock(uncovered())).toBe(true);
        expect(isUncoveredBlock(null)).toBe(false);
        expect(isUncoveredBlock({ decision: "allow", reason: "uncovered by the test suite" })).toBe(false);
        expect(isUncoveredBlock(red())).toBe(false);
        expect(isUncoveredBlock({ decision: "block", reason: "uncovered elsewhere" })).toBe(false);
    });

    // test-contract: public-api — red debt requires a blocked decision and a string containing the red-bar marker.
    it("distinguishes red-bar blocks from allowed and malformed decisions", () => {
        expect(isRedBarBlock(red())).toBe(true);
        expect(isRedBarBlock(null)).toBe(false);
        expect(isRedBarBlock({ decision: "allow", reason: "leaves the test suite RED" })).toBe(false);
        expect(isRedBarBlock({ decision: "block", reason: "suite is red" })).toBe(false);
        // SAFETY: deliberately malformed runtime input exercises the public type guard.
        expect(isRedBarBlock({ decision: "block", reason: 42 as never })).toBe(false);
    });

    // test-contract: invariant — source and test openers must name opposite, role-correct pair guidance.
    it("uses role-correct coverage guidance in both pair directions", () => {
        const sourceOut = run({ baseDecision: uncovered(), editedFile: source });
        const testOut = run({ baseDecision: uncovered("src/luna.test.ts"), editedFile: "src/luna.test.ts" });
        expect(sourceOut.decision?.warnings?.[0]).toContain("write its test next");
        expect(sourceOut.decision?.warnings?.[0]).toContain("unrelated file until it's covered.");
        expect(testOut.decision?.warnings?.[0]).toContain("cover its source (src/luna.ts) next");
        expect(testOut.decision?.warnings?.[0]).not.toContain("luna.test.test");
    });

    // test-contract: invariant — coverage and red debt transitions expose distinct public kinds and allow metadata.
    it("opens coverage versus red debt with exact decision metadata", () => {
        const coverage = run({ baseDecision: uncovered() });
        const redOut = run({ baseDecision: red() });
        expect(coverage.decision).toMatchObject({ decision: "allow", warnings: [expect.stringContaining("Opened coverage debt")] });
        expect(redOut.decision).toMatchObject({ decision: "allow", warnings: [expect.stringContaining("red debt opened")] });
        expect(coverage.txns[0]).toMatchObject({ op: "open", kind: "coverage", contentHash: "", sessionId: "session", atMs: 99 });
        expect(redOut.txns[0]).toMatchObject({ op: "open", kind: "red_suite", contentHash: "", sessionId: "session", atMs: 99 });
    });

    // test-contract: boundary — the default one-debt limit blocks only an unrelated file, never the exact pair.
    it("blocks the first unrelated wander but permits the source/test pair", () => {
        const wander = run({ editedFile: "src/other.ts", openDebts: [debt()] });
        const pair = run({ editedFile: "src/luna.test.ts", openDebts: [debt()] });
        expect(wander.decision).toMatchObject({ decision: "block", rule_id: "per-edit-coverage-debt", severity: "medium", category: "coverage" });
        expect(wander.decision?.reason).toContain("src/luna.test.ts");
        expect(wander.decision?.reason).toContain("scoped, recorded, auditable.");
        expect(pair.decision).toBeNull();
    });

    // test-contract: invariant — red evidence compares exact sets: order is irrelevant, missing/extra members are not.
    it("refreshes red evidence only when the failing-test set changes", () => {
        const same = run({ baseDecision: red(["a.test.ts", "b.test.ts"]), openDebts: [debt(source, "red_suite", "session", ["b.test.ts", "a.test.ts"])] });
        const shorter = run({ baseDecision: red(["a.test.ts"]), openDebts: [debt(source, "red_suite", "session", ["a.test.ts", "b.test.ts"])] });
        const changed = run({ baseDecision: red(["a.test.ts", "c.test.ts"]), openDebts: [debt(source, "red_suite", "session", ["a.test.ts", "b.test.ts"])] });
        expect(same.txns).toHaveLength(0);
        expect(shorter.txns).toContainEqual(expect.objectContaining({ op: "open", failingTestFiles: ["a.test.ts"] }));
        expect(changed.txns).toContainEqual(expect.objectContaining({ op: "open", failingTestFiles: ["a.test.ts", "c.test.ts"] }));
    });

    // test-contract: boundary — one through three failing paths are shown, while the fourth is elided.
    it("renders singular, three-file, and four-file failing evidence precisely", () => {
        const one = run({ editedFile: "src/other.ts", openDebts: [debt(source, "red_suite", "session", ["one.test.ts"])] });
        const three = run({ editedFile: "src/other.ts", openDebts: [debt(source, "red_suite", "session", ["a.ts", "b.ts", "c.ts"])] });
        const four = run({ editedFile: "src/other.ts", openDebts: [debt(source, "red_suite", "session", ["a.ts", "b.ts", "c.ts", "d.ts"])] });
        expect(one.decision?.reason).toContain("the failing test(s): one.test.ts.");
        expect(three.decision?.reason).toContain("a.ts, b.ts, c.ts.");
        expect(four.decision?.reason).toContain("a.ts, b.ts, c.ts, ….");
        expect(four.decision?.reason).not.toContain("d.ts");
    });

    // test-contract: public-api — absent and empty optional evidence must use safe pair fallback guidance.
    it("handles empty and undefined red evidence without optional-field failures", () => {
        const absent = run({ baseDecision: red(), openDebts: [debt(source, "red_suite")] });
        const empty = run({ baseDecision: red([]), openDebts: [debt(source, "red_suite")] });
        expect(absent.decision?.warnings?.[0]).toContain("keep editing src/luna.ts or its test freely");
        expect(empty.decision?.warnings?.[0]).toContain("keep editing src/luna.ts or its test freely");
        expect(absent.txns[0]).toMatchObject({ op: "open", kind: "red_suite" });
    });

    // test-contract: invariant — direct failing paths, affected-test cones, and adjacent debt files widen relatedness independently.
    it("recognizes direct, affected, adjacent, and unrelated red work", () => {
        const d = debt(source, "red_suite", "session", ["integration/red.test.ts"]);
        expect(relatedToDebt("integration/red.test.ts", d)).toBe(true);
        expect(relatedToDebt("src/bridge.ts", d, new Set(["integration/red.test.ts"]))).toBe(true);
        expect(relatedToDebt("src/bridge.ts", d, new Set(["integration/other.test.ts"]))).toBe(false);
        expect(relatedToDebt("src/bridge.ts", d, undefined, new Set([source]))).toBe(true);
    });

    // test-contract: security — foreign ownership may annotate a wander but must never block it, and dedup suppression is honored.
    it("does not let foreign ownership block a wander", () => {
        const noted = run({ editedFile: "src/other.ts", openDebts: [debt(source, "coverage", "other")], shouldNoteForeignDebt: () => true });
        const suppressed = run({ editedFile: "src/other.ts", openDebts: [debt(source, "coverage", "other")], shouldNoteForeignDebt: () => false });
        expect(noted.decision?.decision).not.toBe("block");
        expect(noted.decision?.warnings?.[0]).toContain("another session");
        expect(suppressed.decision).toBeNull();
    });
});
