import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeDecision, listPendingReviews, parseDecisionPayload, parseReviewPayload, readDecision, readReview, writeDecision, writeReview } from "./review-files.js";

let cwd = "";

afterEach(() => {
    if (cwd) {
        rmSync(cwd, { recursive: true, force: true });
        cwd = "";
    }
    vi.useRealTimers();
});

function validReview() {
    return {
        timestamp: "2026-01-01T00:00:00.000Z",
        url: "u",
        prompt: "p",
        tool_name: "WebFetch",
        body: "b",
        redacted_body: "r",
        findings: [{ label: "email", start: 1, end: 3, text: "x", source: "s" }],
        cache_key: "k",
    };
}

function validDecision() {
    return {
        decision: "allow",
        timestamp: "2026-01-01T00:00:00.000Z",
        cache_key: "k",
        actor: { user: "u", host: "h", tty: null },
    };
}

describe("payload validation", () => {
    // test-contract: non-object JSON cannot satisfy a decision payload contract.
    it("rejects a non-object decision", () => {
        expect(parseDecisionPayload([])).toBeNull();
    });

    // test-contract: every required review scalar is required to be a string.
    it.each(["timestamp", "prompt", "tool_name", "body", "redacted_body", "cache_key"] as const)("rejects a non-string review field", (field) => {
        expect(parseReviewPayload({ ...validReview(), [field]: 9 })).toBeNull();
    });

    // test-contract: every finding requires an object, numeric span, and string text/source.
    it("rejects malformed findings", () => {
        const malformed = [
            {},
            { label: 1, start: 1, end: 2, text: "x", source: "s" },
            { label: "x", start: "1", end: 2, text: "x", source: "s" },
            { label: "x", start: 1, end: "2", text: "x", source: "s" },
            { label: "x", start: 1, end: 2, text: 1, source: "s" },
            { label: "x", start: 1, end: 2, text: "x", source: 1 },
        ];
        for (const finding of malformed) {
            expect(parseReviewPayload({ ...validReview(), findings: [finding] })).toBeNull();
        }
    });

    // test-contract: findings must be an array and only numeric optional scores are retained.
    it("validates the findings collection and optional score", () => {
        expect(parseReviewPayload({ ...validReview(), findings: "no" })).toBeNull();
        expect(parseReviewPayload({ ...validReview(), findings: [{ ...validReview().findings[0], score: 0.8 }] })?.findings[0]?.score).toBe(0.8);
        expect(parseReviewPayload({ ...validReview(), findings: [{ ...validReview().findings[0], score: "high" }] })?.findings[0]?.score).toBeUndefined();
    });
});

describe("filesystem lifecycle", () => {
    // test-contract: an absent review file is reported as undefined.
    it("returns undefined for a missing review", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        expect(readReview(cwd, "missing")).toBeUndefined();
    });

    // test-contract: malformed review JSON is rejected.
    it("rejects malformed review JSON", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        const dir = join(cwd, ".interlinked", "scanner", "pending");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "k.review.json"), "{");
        expect(readReview(cwd, "k")).toBeUndefined();
    });

    // test-contract: malformed decision JSON is rejected and does not pin a decision.
    it("rejects malformed decision JSON", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        const dir = join(cwd, ".interlinked", "scanner", "pending");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "k.decision.json"), "{");
        expect(readDecision(cwd, "k")).toBeUndefined();
    });

    // test-contract: review writes return the exact relative filename and use private permissions.
    it("writes a private review file at the documented path", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        const path = writeReview({ cwd, key: "k", url: "u", prompt: "p", toolName: "WebFetch", body: "b", redactedBody: "r", findings: [] });
        expect(path).toBe(".interlinked/scanner/pending/k.review.json");
        expect(statSync(join(cwd, path!)).mode & 0o777).toBe(0o600);
    });

    // test-contract: decision writes return an absolute path and use private permissions.
    it("writes a private decision file at its absolute path", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        const path = writeDecision({ cwd, key: "k", decision: "block", actor: { user: "u", host: "h", tty: null } });
        expect(path).toBe(join(cwd, ".interlinked", "scanner", "pending", "k.decision.json"));
        expect(statSync(path!).mode & 0o777).toBe(0o600);
    });

    // test-contract: only review-suffixed files enter the pending queue.
    it("ignores unrelated and decision filenames", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        const dir = join(cwd, ".interlinked", "scanner", "pending");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "notes.txt"), "x");
        writeFileSync(join(dir, "k.decision.json"), JSON.stringify(validDecision()));
        expect(listPendingReviews(cwd)).toEqual([]);
    });

    // test-contract: consuming an unknown key is safe and idempotent.
    it("safely consumes an unknown key", () => {
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        expect(() => consumeDecision(cwd, "missing")).not.toThrow();
        expect(() => consumeDecision(cwd, "missing")).not.toThrow();
    });
});

describe("pruning", () => {
    // test-contract: a review exactly at the one-hour boundary remains retained.
    it("retains a boundary-age review", () => {
        vi.useFakeTimers();
        const now = new Date("2026-01-01T01:00:00.000Z");
        vi.setSystemTime(now);
        cwd = mkdtempSync(join(tmpdir(), "review-mutation-"));
        const dir = join(cwd, ".interlinked", "scanner", "pending");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "boundary.review.json"), JSON.stringify(validReview()));
        vi.setSystemTime(new Date(now.getTime() - 60 * 60 * 1000));
        writeReview({ cwd, key: "new", url: "u", prompt: "p", toolName: "WebFetch", body: "b", redactedBody: "r", findings: [] });
        expect(readReview(cwd, "boundary")).toBeDefined();
    });
});
