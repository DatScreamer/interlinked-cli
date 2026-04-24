import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAskReason,
	buildRedactedPreview,
	writePendingPrompt,
} from "../redact-preview.js";
import type { ContentScanRequest, ScanFinding } from "../types.js";

interface FindingArgs {
	label: string;
	start: number;
	text: string;
	source?: string;
}

function finding(args: FindingArgs): ScanFinding {
	return {
		label: args.label,
		start: args.start,
		end: args.start + args.text.length,
		text: args.text,
		source: args.source ?? "Test.field",
	};
}

describe("buildRedactedPreview", () => {
	it("replaces each span with a <LABEL> placeholder", () => {
		const text = "Contact Alice at alice@example.com please";
		const spans = [
			finding({ label: "private_person", start: 8, text: "Alice" }),
			finding({ label: "private_email", start: 17, text: "alice@example.com" }),
		];
		const preview = buildRedactedPreview(text, spans);
		expect(preview).toBe("Contact <PRIVATE_PERSON> at <PRIVATE_EMAIL> please");
	});

	it("never contains any matched-span substring (no leakage contract)", () => {
		const text = "email alice.jones@example.com phone 555-867-5309";
		const spans = [
			finding({ label: "private_email", start: 6, text: "alice.jones@example.com" }),
			finding({ label: "private_phone", start: 36, text: "555-867-5309" }),
		];
		const preview = buildRedactedPreview(text, spans);
		expect(preview).not.toContain("alice.jones@example.com");
		expect(preview).not.toContain("555-867-5309");
	});

	it("handles multiple adjacent spans by splicing from the end", () => {
		const text = "aaa bbb ccc";
		const spans = [
			finding({ label: "X", start: 0, text: "aaa" }),
			finding({ label: "Y", start: 4, text: "bbb" }),
			finding({ label: "Z", start: 8, text: "ccc" }),
		];
		expect(buildRedactedPreview(text, spans)).toBe("<X> <Y> <Z>");
	});

	it("truncates long inputs around the first hit", () => {
		const text = "prefix ".repeat(50) + "alice@example.com" + " suffix".repeat(50);
		const hitStart = text.indexOf("alice@example.com");
		const spans = [finding({ label: "private_email", start: hitStart, text: "alice@example.com" })];
		const preview = buildRedactedPreview(text, spans);
		expect(preview).toContain("<PRIVATE_EMAIL>");
		expect(preview.length).toBeLessThanOrEqual(205);
		expect(preview).not.toContain("alice@example.com");
	});

	it("passes short clean text through when no spans exist", () => {
		expect(buildRedactedPreview("hello world", [])).toBe("hello world");
	});
});

describe("writePendingPrompt", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-scanner-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function simpleRequest(): {
		request: ContentScanRequest;
		findingsBySource: Map<string, ScanFinding[]>;
	} {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "email alice@example.com" }],
		};
		const findingsBySource = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[
					finding({
						label: "private_email",
						start: 6,
						text: "alice@example.com",
						source: "Write.content",
					}),
				],
			],
		]);
		return { request, findingsBySource };
	}

	it("returns a relative path under .interlinked/scanner/pending/", () => {
		const { request, findingsBySource } = simpleRequest();
		const relPath = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		expect(relPath?.startsWith(".interlinked/scanner/pending/")).toBe(true);
	});

	it("creates exactly one file on disk", () => {
		const { request, findingsBySource } = simpleRequest();
		writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		const files = readdirSync(join(tmp, ".interlinked", "scanner", "pending"));
		expect(files).toHaveLength(1);
	});

	it("writes the full unmasked content with a LOCAL-ONLY note", () => {
		const { request, findingsBySource } = simpleRequest();
		writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		const files = readdirSync(join(tmp, ".interlinked", "scanner", "pending"));
		const raw = readFileSync(join(tmp, ".interlinked", "scanner", "pending", files[0]), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.tool_name).toBe("Write");
		expect(parsed.parts[0].text).toBe("email alice@example.com");
		expect(parsed.note).toContain("LOCAL-ONLY");
	});
});

describe("buildAskReason", () => {
	it("joins summary + per-source preview + local file pointer", () => {
		const request: ContentScanRequest = {
			hook: "pre_external_egress",
			parts: [
				{ source: "WebFetch.url", text: "https://x.com/u?email=alice@example.com" },
				{ source: "WebFetch.prompt", text: "fetch Alice's profile" },
			],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"WebFetch.url",
				[
					finding({
						label: "private_email",
						start: 22,
						text: "alice@example.com",
						source: "WebFetch.url",
					}),
				],
			],
			[
				"WebFetch.prompt",
				[
					finding({
						label: "private_person",
						start: 6,
						text: "Alice",
						source: "WebFetch.prompt",
					}),
				],
			],
		]);
		const reason = buildAskReason({
			policySummary:
				"privacy-filter detected sensitive content [private_email(1), private_person(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: ".interlinked/scanner/pending/xyz.json",
		});
		expect(reason).toContain("[private_email(1), private_person(1)]");
		expect(reason).toContain("Preview (PII masked");
		expect(reason).toContain("WebFetch.url: https://x.com/u?email=<PRIVATE_EMAIL>");
		expect(reason).toContain("WebFetch.prompt: fetch <PRIVATE_PERSON>'s profile");
		expect(reason).toContain(
			"Full unmasked content: .interlinked/scanner/pending/xyz.json  (local-only — not sent to Anthropic)",
		);
		expect(reason).not.toContain("alice@example.com");
		expect(reason).not.toContain("Alice");
	});

	it("omits the file pointer when no pending-prompt path was written", () => {
		const request: ContentScanRequest = {
			hook: "pre_bash_command",
			parts: [{ source: "Bash.command", text: "echo alice@example.com" }],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Bash.command",
				[
					finding({
						label: "private_email",
						start: 5,
						text: "alice@example.com",
						source: "Bash.command",
					}),
				],
			],
		]);
		const reason = buildAskReason({
			policySummary: "privacy-filter detected sensitive content [private_email(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(reason).not.toContain("Full unmasked content");
	});
});
