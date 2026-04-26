// Tests for the review/decision file lifecycle that backs the WebFetch
// 3-way human-in-the-loop interception. The contract that matters most:
//   - Same (url, prompt) always produces the same cache key (proxy can find
//     the user's prior decision after a re-invoke).
//   - listPendingReviews surfaces only reviews without a sibling decision.
//   - consumeDecision removes BOTH files so the next call doesn't silently
//     re-apply the old verdict.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cacheKey,
	consumeDecision,
	countPendingReviews,
	listPendingReviews,
	readDecision,
	readReview,
	writeDecision,
	writeReview,
} from "../review-files.js";
import type { ScanFinding } from "../types.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "review-files-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function fakeFinding(label: string, text: string): ScanFinding {
	return { label, start: 0, end: text.length, text, source: "WebFetch.response" };
}

describe("cacheKey", () => {
	it("returns 16 hex chars", () => {
		const k = cacheKey("https://example.com", "summarise");
		expect(k).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is stable for the same (url, prompt)", () => {
		const a = cacheKey("https://example.com", "p");
		const b = cacheKey("https://example.com", "p");
		expect(a).toBe(b);
	});

	it("changes when prompt changes", () => {
		expect(cacheKey("https://example.com", "a")).not.toBe(
			cacheKey("https://example.com", "b"),
		);
	});

	it("treats undefined prompt as empty string", () => {
		const a = cacheKey("https://example.com", undefined);
		const b = cacheKey("https://example.com", "");
		expect(a).toBe(b);
	});
});

describe("writeReview / readReview", () => {
	it("round-trips a payload", () => {
		const key = cacheKey("https://example.com/foo", "p");
		const findings = [fakeFinding("private_email", "alice@example.com")];
		writeReview({
			cwd,
			key,
			url: "https://example.com/foo",
			prompt: "p",
			toolName: "WebFetch",
			body: "Contact: alice@example.com",
			redactedBody: "Contact: <PRIVATE_EMAIL>",
			findings,
		});
		const got = readReview(cwd, key);
		expect(got?.url).toBe("https://example.com/foo");
		expect(got?.body).toBe("Contact: alice@example.com");
		expect(got?.redacted_body).toBe("Contact: <PRIVATE_EMAIL>");
		expect(got?.findings).toHaveLength(1);
		expect(got?.findings[0]?.label).toBe("private_email");
	});

	it("returns undefined when the review does not exist", () => {
		expect(readReview(cwd, "nope_no_such_key_")).toBeUndefined();
	});

	it("creates the pending dir on first write", () => {
		expect(existsSync(join(cwd, ".interlinked/scanner/pending"))).toBe(false);
		writeReview({
			cwd,
			key: "k1",
			url: "u",
			prompt: "p",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		expect(existsSync(join(cwd, ".interlinked/scanner/pending"))).toBe(true);
	});
});

describe("writeDecision / readDecision", () => {
	const actor = { user: "u", host: "h", tty: null };

	it.each(["allow", "redact", "block"] as const)("round-trips %s", (decision) => {
		writeDecision({ cwd, key: "k", decision, actor });
		const got = readDecision(cwd, "k");
		expect(got?.decision).toBe(decision);
		expect(got?.actor.user).toBe("u");
	});

	it("returns undefined when no decision recorded yet (steady state, not an error)", () => {
		expect(readDecision(cwd, "no_such_key")).toBeUndefined();
	});

	it("survives a corrupt decision file by returning undefined", () => {
		mkdirSync(join(cwd, ".interlinked/scanner/pending"), { recursive: true });
		writeFileSync(
			join(cwd, ".interlinked/scanner/pending/k.decision.json"),
			"this is not json",
		);
		expect(readDecision(cwd, "k")).toBeUndefined();
	});
});

describe("listPendingReviews / countPendingReviews", () => {
	const actor = { user: "u", host: "h", tty: null };

	it("returns empty when the pending dir doesn't exist", () => {
		expect(listPendingReviews(cwd)).toEqual([]);
		expect(countPendingReviews(cwd)).toBe(0);
	});

	it("includes reviews without a decision sibling", () => {
		writeReview({
			cwd,
			key: "k1",
			url: "u1",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [fakeFinding("private_email", "a@b.c")],
		});
		const list = listPendingReviews(cwd);
		expect(list).toHaveLength(1);
		expect(list[0]?.url).toBe("u1");
		expect(list[0]?.finding_count).toBe(1);
		expect(countPendingReviews(cwd)).toBe(1);
	});

	it("excludes reviews that already have a decision sibling", () => {
		writeReview({
			cwd,
			key: "k1",
			url: "u1",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		writeDecision({ cwd, key: "k1", decision: "allow", actor });
		expect(listPendingReviews(cwd)).toEqual([]);
		expect(countPendingReviews(cwd)).toBe(0);
	});

	it("sorts newest-first", async () => {
		writeReview({
			cwd,
			key: "k1",
			url: "older",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		// Force a different timestamp by sleeping briefly between writes.
		await new Promise((r) => setTimeout(r, 10));
		writeReview({
			cwd,
			key: "k2",
			url: "newer",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		const list = listPendingReviews(cwd);
		expect(list.map((r: { url: string }) => r.url)).toEqual(["newer", "older"]);
	});
});

describe("consumeDecision", () => {
	const actor = { user: "u", host: "h", tty: null };

	it("removes both review and decision files", () => {
		writeReview({
			cwd,
			key: "k",
			url: "u",
			prompt: "",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});
		writeDecision({ cwd, key: "k", decision: "allow", actor });
		consumeDecision(cwd, "k");
		expect(existsSync(join(cwd, ".interlinked/scanner/pending/k.review.json"))).toBe(false);
		expect(existsSync(join(cwd, ".interlinked/scanner/pending/k.decision.json"))).toBe(false);
	});

	it("is idempotent — second call is a no-op", () => {
		consumeDecision(cwd, "no_such_key");
		expect(() => consumeDecision(cwd, "no_such_key")).not.toThrow();
	});
});
