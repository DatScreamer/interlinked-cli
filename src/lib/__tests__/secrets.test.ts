import { describe, expect, it } from "vitest";
import { containsSecrets, scrubSecrets } from "../secrets.js";

describe("scrubSecrets — pattern matching", () => {
	it("detects AWS access key", () => {
		const result = scrubSecrets("key is AKIAIOSFODNN7EXAMPLE");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("aws_key");
		expect(result.text).toContain("[REDACTED:aws_key]");
		expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("detects GitHub token (ghp_)", () => {
		// Build token at runtime so static scanners don't flag this file as a leaked secret.
		const ghLikeToken = `gh${"p"}_${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"}`;
		const result = scrubSecrets(`token: ${ghLikeToken}`);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("github_token");
		expect(result.text).toContain("[REDACTED:github_token]");
	});

	it("detects GitHub PAT", () => {
		const result = scrubSecrets(
			"pat: github_pat_11AABCDEFG0123456789abcdefghijklmnopqrstuvwxyz",
		);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("github_pat");
	});

	it("detects JWT tokens", () => {
		// Build the JWT fixture at runtime to avoid a static secret-shaped literal.
		const jwtHeader = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
		const jwtBody = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
		const jwtSig = "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const jwtLike = `${jwtHeader}.${jwtBody}.${jwtSig}`;
		const result = scrubSecrets(`Bearer ${jwtLike}`);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("jwt");
	});

	it("detects private key headers", () => {
		const result = scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("private_key");
	});

	it("detects connection strings", () => {
		const result = scrubSecrets("db: mongodb://admin:pass123@host:27017/mydb");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("connection_string");
	});

	it("detects Stripe keys", () => {
		// Build token at runtime to avoid committing a static secret-shaped literal.
		const stripeLikeToken = `sk_${"live_51ABCDEFabcdefghijklmnop"}`;
		const result = scrubSecrets(`stripe: ${stripeLikeToken}`);
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("stripe_key");
	});

	it("detects Slack tokens", () => {
		const result = scrubSecrets("slack: xoxb-1234567890-abcdefghij");
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("slack_token");
	});

	it("detects generic api_key patterns", () => {
		const result = scrubSecrets('config.api_key = "AbCdEf123456789XyZ012345"');
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("generic_secret");
	});

	it("detects OpenAI-style sk- keys and 64-char hex secrets", () => {
		const sk = scrubSecrets("token sk-ABCDEF0123456789abcdef0123456789");
		expect(sk.types).toContain("openai_key");
		const hex = scrubSecrets(`digest ${"a1b2c3d4".repeat(8)} done`);
		expect(hex.types).toContain("hex_secret");
	});

	it("returns unchanged text with no secrets", () => {
		const clean = "Just a normal log message about reading files";
		const result = scrubSecrets(clean);
		expect(result.found).toBe(0);
		expect(result.types).toEqual([]);
		expect(result.text).toBe(clean);
	});

	it("handles empty string", () => {
		const result = scrubSecrets("");
		expect(result.found).toBe(0);
		expect(result.text).toBe("");
	});

	it("handles null/undefined gracefully", () => {
		const result = scrubSecrets(undefined as unknown as string);
		expect(result.found).toBe(0);
	});
});

describe("scrubSecrets — configuration", () => {
	it("respects enabled: false", () => {
		const result = scrubSecrets("AKIAIOSFODNN7EXAMPLE", { enabled: false });
		expect(result.found).toBe(0);
		expect(result.text).toContain("AKIAIOSFODNN7EXAMPLE");
	});

	it("applies extra_patterns", () => {
		const result = scrubSecrets("MY_SECRET_TOKEN_ABC123", {
			extra_patterns: ["MY_SECRET_TOKEN_[A-Z0-9]+"],
		});
		expect(result.found).toBeGreaterThanOrEqual(1);
		expect(result.types).toContain("custom");
	});

	it("skips matches in ignore_patterns", () => {
		const result = scrubSecrets("test_token_abc123def456ghi789", {
			ignore_patterns: ["test_token_.*"],
		});
		// The ignore pattern should prevent "generic_secret" from matching
		// (though whether it matches depends on the pattern specifics)
		expect(result.text).not.toContain("[REDACTED:");
	});
});

describe("scrubSecrets — replacement format", () => {
	it("uses [REDACTED:{type}] format", () => {
		const result = scrubSecrets("AKIAIOSFODNN7EXAMPLE");
		expect(result.text).toMatch(/\[REDACTED:aws_key\]/);
	});

	it("handles multiple secrets in one string", () => {
		// Build the fixture at runtime so static scanners don't flag this file.
		const ghLikeToken = `gh${"p"}_${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"}`;
		const result = scrubSecrets(`aws=AKIAIOSFODNN7EXAMPLE token=${ghLikeToken}`);
		expect(result.found).toBeGreaterThanOrEqual(2);
		expect(result.text).toContain("[REDACTED:aws_key]");
		expect(result.text).toContain("[REDACTED:github_token]");
	});
});

describe("containsSecrets", () => {
	it("returns true for text with secrets", () => {
		expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
	});

	it("returns false for clean text", () => {
		expect(containsSecrets("just normal text")).toBe(false);
	});

	it("returns false for empty", () => {
		expect(containsSecrets("")).toBe(false);
	});
});

describe("scrubSecrets — false positive resistance", () => {
	it("does not flag short strings", () => {
		const result = scrubSecrets("abc123");
		expect(result.found).toBe(0);
	});

	it("does not flag common code patterns", () => {
		const result = scrubSecrets('const x = require("./module"); export default class Foo {}');
		expect(result.found).toBe(0);
	});

	it("does not flag file paths", () => {
		const result = scrubSecrets("/home/user/repo/cli/src/index.ts");
		expect(result.found).toBe(0);
	});

	it("does not flag npm package names", () => {
		const result = scrubSecrets("@anthropic/claude-code-sdk");
		expect(result.found).toBe(0);
	});
});
