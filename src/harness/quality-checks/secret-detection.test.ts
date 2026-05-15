// Tests for the entropy-gated secret detector. Every secret-shaped fixture is
// assembled from fragments via template interpolation so this file contains no
// contiguous secret of its own — the source stays clean for secrets_in_source.

import { describe, expect, it } from "vitest";
import { containsSecrets } from "./secret-detection.js";

describe("containsSecrets — genuine high-entropy secrets are detected", () => {
	it("detects an AWS access key with a random body", () => {
		const key = `AKIA${"J7QX2M9FD3KP1WZ8"}`;
		expect(containsSecrets(`const k = '${key}';`).length).toBeGreaterThan(0);
	});

	it("detects a Stripe key with a random body", () => {
		const key = `sk_${"live"}_4eC39HqLyjWDarjtT1zdp7dc`;
		expect(containsSecrets(`const k = '${key}';`).length).toBeGreaterThan(0);
	});

	it("detects a GitHub token with a random body", () => {
		const key = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
		expect(containsSecrets(`const k = '${key}';`).length).toBeGreaterThan(0);
	});

	it("reports PEM private-key headers regardless of entropy", () => {
		const pem = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
		expect(containsSecrets(pem).length).toBeGreaterThan(0);
	});
});

describe("containsSecrets — low-entropy filler is suppressed", () => {
	it("suppresses an AKIA prefix followed by repeated characters", () => {
		const filler = `AKIA${"X".repeat(16)}`;
		expect(containsSecrets(`const k = '${filler}';`)).toEqual([]);
	});

	it("suppresses a Stripe-shaped string with a repeated body", () => {
		const filler = `sk_${"test"}_${"a".repeat(24)}`;
		expect(containsSecrets(`const k = '${filler}';`)).toEqual([]);
	});

	it("suppresses a GitHub-shaped string with a zeroed body", () => {
		const filler = `ghp_${"0".repeat(36)}`;
		expect(containsSecrets(`const k = '${filler}';`)).toEqual([]);
	});
});

describe("containsSecrets — non-secrets", () => {
	it("returns empty for ordinary code", () => {
		expect(containsSecrets("function add(a, b) { return a + b; }")).toEqual([]);
	});

	it("returns empty for an empty string", () => {
		expect(containsSecrets("")).toEqual([]);
	});
});
