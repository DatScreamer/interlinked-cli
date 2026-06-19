import { describe, expect, it } from "vitest";
import { DEFAULT_LICENSE_ALLOWLIST, isLicenseAllowed } from "./license-policy.js";

describe("DEFAULT_LICENSE_ALLOWLIST", () => {
	it("contains the permissive core set", () => {
		for (const id of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "MPL-2.0"]) {
			expect(DEFAULT_LICENSE_ALLOWLIST).toContain(id);
		}
	});

	it("does not contain copyleft licenses", () => {
		for (const id of ["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "SSPL-1.0", "BUSL-1.1"]) {
			expect(DEFAULT_LICENSE_ALLOWLIST).not.toContain(id);
		}
	});
});

describe("isLicenseAllowed — positive cases", () => {
	it("matches a bare identifier", () => {
		expect(isLicenseAllowed("MIT", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
	});

	it("matches case-insensitively", () => {
		expect(isLicenseAllowed("mit", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
		expect(isLicenseAllowed("apache-2.0", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
	});

	it("matches a WITH-exception identifier as one unit", () => {
		expect(
			isLicenseAllowed("Apache-2.0 WITH LLVM-exception", DEFAULT_LICENSE_ALLOWLIST),
		).toBe(true);
	});

	it("allows a dual-license OR when any disjunct is allowed", () => {
		expect(isLicenseAllowed("MIT OR GPL-3.0", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
		expect(isLicenseAllowed("GPL-3.0 OR MIT", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
	});

	it("allows an AND only when all conjuncts are allowed", () => {
		expect(isLicenseAllowed("MIT AND ISC", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
	});

	it("trims surrounding whitespace", () => {
		expect(isLicenseAllowed("  MIT  ", DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
	});

	it("respects a custom allowlist over the default", () => {
		expect(isLicenseAllowed("GPL-3.0", ["GPL-3.0"])).toBe(true);
		expect(isLicenseAllowed("MIT", ["GPL-3.0"])).toBe(false);
	});
});

describe("isLicenseAllowed — negative cases", () => {
	it("rejects a copyleft identifier", () => {
		expect(isLicenseAllowed("GPL-3.0", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
	});

	it("rejects an AND with one disallowed conjunct", () => {
		expect(isLicenseAllowed("MIT AND GPL-3.0", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
	});

	it("rejects parenthesized expressions conservatively (human decides)", () => {
		expect(isLicenseAllowed("(MIT OR Apache-2.0)", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
	});

	it("rejects `+` range operators conservatively", () => {
		expect(isLicenseAllowed("GPL-2.0+", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
		expect(isLicenseAllowed("Apache-2.0+ OR MIT", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
	});

	it("rejects empty and whitespace-only input", () => {
		expect(isLicenseAllowed("", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
		expect(isLicenseAllowed("   ", DEFAULT_LICENSE_ALLOWLIST)).toBe(false);
	});

	it("rejects free-text non-SPDX prose", () => {
		expect(
			isLicenseAllowed("See LICENSE file in the project root", DEFAULT_LICENSE_ALLOWLIST),
		).toBe(false);
	});
});
