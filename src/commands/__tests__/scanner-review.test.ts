// Tests for `interlinked scanner review`. The command is the second half
// of the WebFetch 3-way review loop: it reads a pending `*.review.json`,
// surfaces it to the user (rendered locally — never to the model), and
// writes a `*.decision.json` the harness consumes on the next call.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheKey,
	readDecision,
	writeReview,
} from "../../harness/content-scanner/review-files.js";
import type { ScanFinding } from "../../harness/content-scanner/types.js";
import { scannerReviewCommand } from "../scanner.js";

let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. scannerReviewCommand reads
// `process.cwd()` explicitly, so the spy exercises the same path.
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "scanner-review-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	cwdSpy.mockRestore();
	rmSync(cwd, { recursive: true, force: true });
	logSpy.mockRestore();
	vi.restoreAllMocks();
});

function finding(label: string, text: string, start: number): ScanFinding {
	return { label, start, end: start + text.length, text, source: "WebFetch.response" };
}

function seedReview(url: string, body: string, findings: ScanFinding[]): string {
	const key = cacheKey(url, "");
	writeReview({
		cwd,
		key,
		url,
		prompt: "",
		toolName: "WebFetch",
		body,
		redactedBody: body.replace(/[a-z]+@[a-z.]+/g, "<PRIVATE_EMAIL>"),
		findings,
	});
	return key;
}

describe("scannerReviewCommand — no pending", () => {
	it("reports zero pending reviews and exits cleanly in normal mode", async () => {
		await scannerReviewCommand({});
		const allOutput = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(allOutput).toMatch(/no pending reviews/i);
	});

	it("returns zero-pending payload in JSON mode", async () => {
		await scannerReviewCommand({ json: true });
		const allOutput = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		const parsed = JSON.parse(allOutput);
		expect(parsed).toMatchObject({ pending: 0, action: "none" });
	});
});

describe("scannerReviewCommand — non-interactive flags", () => {
	it("--allow writes a decision=allow file", async () => {
		const key = seedReview(
			"https://example.com/a",
			"Email: alice@example.com",
			[finding("private_email", "alice@example.com", 7)],
		);
		await scannerReviewCommand({ allow: true });
		const decision = readDecision(cwd, key);
		expect(decision?.decision).toBe("allow");
	});

	it("--redact writes a decision=redact file", async () => {
		const key = seedReview(
			"https://example.com/r",
			"Email: bob@example.com",
			[finding("private_email", "bob@example.com", 7)],
		);
		await scannerReviewCommand({ redact: true });
		const decision = readDecision(cwd, key);
		expect(decision?.decision).toBe("redact");
	});

	it("--block writes a decision=block file", async () => {
		const key = seedReview(
			"https://example.com/b",
			"Email: carol@example.com",
			[finding("private_email", "carol@example.com", 7)],
		);
		await scannerReviewCommand({ block: true });
		const decision = readDecision(cwd, key);
		expect(decision?.decision).toBe("block");
	});

	it("appends an audit-log entry with the chosen action", async () => {
		seedReview(
			"https://example.com/a",
			"Email: alice@example.com",
			[finding("private_email", "alice@example.com", 7)],
		);
		await scannerReviewCommand({ allow: true });
		const auditPath = join(cwd, ".interlinked", "content-scanner.audit.jsonl");
		expect(existsSync(auditPath)).toBe(true);
		const entries = readFileSync(auditPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(entries.at(-1)).toMatchObject({ action: "review_allow" });
	});

	it("rejects two conflicting decision flags", async () => {
		seedReview(
			"https://example.com/a",
			"Email: alice@example.com",
			[finding("private_email", "alice@example.com", 7)],
		);
		process.exitCode = 0;
		await scannerReviewCommand({ allow: true, block: true });
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});
});

describe("scannerReviewCommand — --key targets a specific review", () => {
	it("picks the review for the supplied cache key", async () => {
		const keyA = seedReview(
			"https://example.com/a",
			"alice@example.com",
			[finding("private_email", "alice@example.com", 0)],
		);
		const keyB = seedReview(
			"https://example.com/b",
			"bob@example.com",
			[finding("private_email", "bob@example.com", 0)],
		);
		await scannerReviewCommand({ key: keyB, allow: true });
		expect(readDecision(cwd, keyB)?.decision).toBe("allow");
		expect(readDecision(cwd, keyA)).toBeUndefined();
	});

	it("errors when the supplied key has no review", async () => {
		// Seed at least one pending review so the no-pending early return
		// doesn't fire — we want the --key mismatch path specifically.
		seedReview(
			"https://example.com/seed",
			"alice@example.com",
			[finding("private_email", "alice@example.com", 0)],
		);
		process.exitCode = 0;
		await scannerReviewCommand({ key: "deadbeefdeadbeef", allow: true });
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});
});

describe("scannerReviewCommand — JSON output", () => {
	it("emits a structured payload with the recorded decision", async () => {
		const key = seedReview(
			"https://example.com/json",
			"Email: alice@example.com",
			[finding("private_email", "alice@example.com", 7)],
		);
		await scannerReviewCommand({ allow: true, json: true });
		const allOutput = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		const parsed = JSON.parse(allOutput);
		expect(parsed).toMatchObject({
			action: "review_allow",
			cache_key: key,
			decision: "allow",
		});
	});

	it("rejects --json without a decision flag instead of prompting on stdin", async () => {
		seedReview(
			"https://example.com/json-no-flag",
			"Email: alice@example.com",
			[finding("private_email", "alice@example.com", 7)],
		);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		process.exitCode = 0;
		// No --allow/--redact/--block — must NOT render the ANSI UI
		// (would contaminate the JSON document) and must NOT block on stdin.
		await scannerReviewCommand({ json: true });
		expect(process.exitCode).toBe(1);

		// All error output should be valid JSON, not a prompt.
		const errBody = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		const parsed = JSON.parse(errBody);
		expect(parsed.error).toMatch(/non-interactive/i);
		expect(parsed.details).toMatchObject({ url: "https://example.com/json-no-flag" });

		// Importantly: stdout (where the JSON document would land) was not
		// polluted by the ANSI review UI.
		const stdoutBody = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		expect(stdoutBody).not.toMatch(/Privacy Filter — Review/);

		errSpy.mockRestore();
		process.exitCode = 0;
	});
});
