import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveAdminUrl, formatRecentEvents, loadCloudUrl } from "../cloud.js";

describe("deriveAdminUrl", () => {
	it("derives /admin/recent from the evaluate URL, preserving origin+port", () => {
		const u = deriveAdminUrl("http://localhost:8787/governor/evaluate", 20);
		expect(u).toBe("http://localhost:8787/admin/recent?limit=20");
	});

	it("works for an https production URL", () => {
		const u = deriveAdminUrl("https://interlinked-cloud.example.workers.dev/governor/evaluate", 5);
		expect(u).toBe("https://interlinked-cloud.example.workers.dev/admin/recent?limit=5");
	});

	it("ignores any path/query on the source URL (resolves against origin)", () => {
		const u = deriveAdminUrl("https://x.workers.dev/anything?foo=bar", 100);
		expect(u).toBe("https://x.workers.dev/admin/recent?limit=100");
	});
});

describe("formatRecentEvents", () => {
	it("renders an empty-state line when there are no events", () => {
		const out = formatRecentEvents([]);
		expect(out.toLowerCase()).toContain("no events");
	});

	it("includes id, tool, decision and rule_id for each event", () => {
		const out = formatRecentEvents([
			{
				id: 287,
				session_id: "cli-test-session",
				hook_event: "PreToolUse",
				tool_name: "Bash",
				decision: "allow",
				rule_id: "cloud-builtin-cf-dns-record-delete",
				created_at: 1779991638099,
			},
		]);
		expect(out).toContain("287");
		expect(out).toContain("Bash");
		expect(out).toContain("allow");
		expect(out).toContain("cloud-builtin-cf-dns-record-delete");
	});

	it("renders an em-dash for a null rule_id", () => {
		const out = formatRecentEvents([
			{ id: 1, tool_name: "Edit", decision: "allow", rule_id: null, created_at: 1779991638099 },
		]);
		expect(out).toContain("Edit");
		expect(out).toContain("—");
	});
});

describe("loadCloudUrl", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cloud-cli-test-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when config.local.json is missing", () => {
		expect(loadCloudUrl(dir)).toBeNull();
	});

	it("returns null when there is no cloud_governor block", () => {
		writeFileSync(join(dir, ".interlinked", "config.local.json"), JSON.stringify({ agent_name: "x" }));
		expect(loadCloudUrl(dir)).toBeNull();
	});

	it("returns null when the url is missing", () => {
		writeFileSync(
			join(dir, ".interlinked", "config.local.json"),
			JSON.stringify({ cloud_governor: { enabled: true, timeout_ms: 3000 } }),
		);
		expect(loadCloudUrl(dir)).toBeNull();
	});

	it("returns the url string when present", () => {
		writeFileSync(
			join(dir, ".interlinked", "config.local.json"),
			JSON.stringify({
				cloud_governor: { url: "https://interlinked-cloud.example.workers.dev/governor/evaluate" },
			}),
		);
		expect(loadCloudUrl(dir)).toBe("https://interlinked-cloud.example.workers.dev/governor/evaluate");
	});
});
