import { describe, expect, it } from "vitest";

import {
	DEFAULT_EGRESS_FILTER_CONFIG,
	filterOutputEgress,
} from "./output-egress-filter.js";
import type { EgressFilterConfig } from "./output-egress-filter.js";
import { scanSecrets } from "./signatures.js";

// ===========================================
// Test fixtures
// ===========================================
// These are intentionally synthetic — fake but well-formed strings that match
// the live signature patterns in ./signatures.ts. None are real credentials.

const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const FAKE_GITHUB_PAT = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123";
const PRIVATE_KEY_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";

const baseConfig: EgressFilterConfig = { enabled: true };

// Sanity-check that the live signature scanner detects each fixture. If a
// signature changes upstream and a fixture stops matching, this guard makes
// the test failure point at the right place instead of producing a confusing
// "didn't redact" failure.
describe("output-egress-filter fixtures (preflight)", () => {
	it("scanSecrets detects the AWS key fixture", () => {
		const matches = scanSecrets(FAKE_AWS_KEY);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.map((m) => m.rule_id)).toContain("sig-secret-aws-key");
	});

	it("scanSecrets detects the GitHub PAT fixture", () => {
		const matches = scanSecrets(FAKE_GITHUB_PAT);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.map((m) => m.rule_id)).toContain("sig-secret-github-pat");
	});

	it("scanSecrets detects the OpenAI key fixture", () => {
		const matches = scanSecrets(FAKE_OPENAI_KEY);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.map((m) => m.rule_id)).toContain("sig-secret-openai");
	});

	it("scanSecrets detects the private-key BEGIN marker fixture", () => {
		const matches = scanSecrets(PRIVATE_KEY_BEGIN);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.map((m) => m.rule_id)).toContain("sig-secret-private-key");
	});
});

// ===========================================
// Positive cases — content gets redacted
// ===========================================

describe("filterOutputEgress — positive cases", () => {
	it("redacts an AWS access key and reports its rule id", () => {
		const content = `Some output\n${FAKE_AWS_KEY}\nmore output`;
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).not.toContain(FAKE_AWS_KEY);
		expect(result.filtered).toContain("[REDACTED]");
		expect(result.redacted_rule_ids).toContain("sig-secret-aws-key");
		expect(result.redaction_count).toBeGreaterThanOrEqual(1);
	});

	it("redacts a private-key block (BEGIN marker scrubbed)", () => {
		const content = [
			"# Leaked key dump",
			PRIVATE_KEY_BEGIN,
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).not.toContain(PRIVATE_KEY_BEGIN);
		expect(result.filtered).toContain("[REDACTED]");
		expect(result.redacted_rule_ids).toContain("sig-secret-private-key");
		expect(result.redaction_count).toBeGreaterThanOrEqual(1);
	});

	it("redacts multiple distinct secrets and reports all rule ids", () => {
		const content = [
			`AWS: ${FAKE_AWS_KEY}`,
			`GitHub: ${FAKE_GITHUB_PAT}`,
			`OpenAI: ${FAKE_OPENAI_KEY}`,
		].join("\n");
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).not.toContain(FAKE_AWS_KEY);
		expect(result.filtered).not.toContain(FAKE_GITHUB_PAT);
		expect(result.filtered).not.toContain(FAKE_OPENAI_KEY);
		expect(result.redacted_rule_ids).toEqual(
			expect.arrayContaining([
				"sig-secret-aws-key",
				"sig-secret-github-pat",
				"sig-secret-openai",
			]),
		);
		expect(result.redaction_count).toBeGreaterThanOrEqual(3);
	});

	it("honours a custom redaction_marker", () => {
		const content = `prefix ${FAKE_AWS_KEY} suffix`;
		const result = filterOutputEgress(content, {
			enabled: true,
			redaction_marker: "***",
		});

		expect(result.filtered).not.toContain(FAKE_AWS_KEY);
		expect(result.filtered).toContain("***");
		expect(result.filtered).not.toContain("[REDACTED]");
		expect(result.redaction_count).toBeGreaterThanOrEqual(1);
	});

	it("skips redaction for rule ids listed in ignored_rule_ids", () => {
		const content = `Token: ${FAKE_GITHUB_PAT}`;
		const result = filterOutputEgress(content, {
			enabled: true,
			ignored_rule_ids: ["sig-secret-github-pat"],
		});

		// Should pass through unchanged for that rule.
		expect(result.filtered).toContain(FAKE_GITHUB_PAT);
		expect(result.filtered).not.toContain("[REDACTED]");
		expect(result.redacted_rule_ids).not.toContain("sig-secret-github-pat");
		expect(result.redaction_count).toBe(0);
	});

	it("redacts all occurrences when the same secret appears 3 times", () => {
		const content = [
			`first ${FAKE_AWS_KEY}`,
			`second ${FAKE_AWS_KEY}`,
			`third ${FAKE_AWS_KEY}`,
		].join("\n");
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).not.toContain(FAKE_AWS_KEY);
		// All three occurrences replaced by the same marker.
		const markerCount = (result.filtered.match(/\[REDACTED\]/g) ?? []).length;
		expect(markerCount).toBe(3);
		expect(result.redaction_count).toBeGreaterThanOrEqual(3);
		// Rule id reported once (deduped).
		expect(
			result.redacted_rule_ids.filter((id) => id === "sig-secret-aws-key").length,
		).toBe(1);
	});
});

// ===========================================
// Negative cases — content passes through unchanged
// ===========================================

describe("filterOutputEgress — negative / passthrough cases", () => {
	it("returns empty content unchanged", () => {
		const result = filterOutputEgress("", baseConfig);
		expect(result).toEqual({
			filtered: "",
			redacted_rule_ids: [],
			redaction_count: 0,
		});
	});

	it("returns clean content unchanged when no secrets match", () => {
		const content = "Just regular output. Some logs. No credentials here at all.";
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).toBe(content);
		expect(result.redacted_rule_ids).toEqual([]);
		expect(result.redaction_count).toBe(0);
	});

	it("passes through verbatim when config.enabled === false (even with a secret)", () => {
		const content = `Hot leak: ${FAKE_AWS_KEY}`;
		const result = filterOutputEgress(content, { enabled: false });

		expect(result.filtered).toBe(content);
		expect(result.filtered).toContain(FAKE_AWS_KEY);
		expect(result.redacted_rule_ids).toEqual([]);
		expect(result.redaction_count).toBe(0);
	});

	it("scans the tail of content under max_scan_bytes (secret near the end is caught)", () => {
		// 10KB of filler, then the secret. Well under the default 100KB cap.
		const filler = "x".repeat(10_000);
		const content = `${filler}\n${FAKE_AWS_KEY}\n`;
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).not.toContain(FAKE_AWS_KEY);
		expect(result.redacted_rule_ids).toContain("sig-secret-aws-key");
		expect(result.redaction_count).toBeGreaterThanOrEqual(1);
	});

	it("ignores hash-shaped text that doesn't match any signature rule", () => {
		// 40-char hex string with no provider prefix — matches no rule in
		// signatures.ts (no AKIA/ghp_/sk-/etc).
		const content = `commit deadbeefcafef00d1234567890abcdef0123456789 is fine`;
		const result = filterOutputEgress(content, baseConfig);

		expect(result.filtered).toBe(content);
		expect(result.redacted_rule_ids).toEqual([]);
		expect(result.redaction_count).toBe(0);
	});
});

// ===========================================
// Config defaults
// ===========================================

describe("DEFAULT_EGRESS_FILTER_CONFIG", () => {
	it("is enabled by default", () => {
		expect(DEFAULT_EGRESS_FILTER_CONFIG.enabled).toBe(true);
	});

	it("uses [REDACTED] as the default marker", () => {
		expect(DEFAULT_EGRESS_FILTER_CONFIG.redaction_marker).toBe("[REDACTED]");
	});

	it("defaults max_scan_bytes to 100_000 (matches output_scanning)", () => {
		expect(DEFAULT_EGRESS_FILTER_CONFIG.max_scan_bytes).toBe(100_000);
	});

	it("redacts when invoked with the default config", () => {
		const content = `token: ${FAKE_GITHUB_PAT}`;
		const result = filterOutputEgress(content, DEFAULT_EGRESS_FILTER_CONFIG);

		expect(result.filtered).not.toContain(FAKE_GITHUB_PAT);
		expect(result.filtered).toContain("[REDACTED]");
	});
});

// ===========================================
// Purity — no mutation of inputs
// ===========================================

describe("filterOutputEgress — purity", () => {
	it("does not mutate the input content string", () => {
		const original = `before ${FAKE_AWS_KEY} after`;
		const snapshot = original;
		filterOutputEgress(original, baseConfig);
		expect(original).toBe(snapshot);
	});

	it("does not mutate the input config object", () => {
		const config: EgressFilterConfig = {
			enabled: true,
			redaction_marker: "##",
			ignored_rule_ids: ["sig-secret-private-key"],
		};
		const snapshot = JSON.stringify(config);
		filterOutputEgress(`x ${FAKE_AWS_KEY} y`, config);
		expect(JSON.stringify(config)).toBe(snapshot);
	});
});
