import { describe, expect, it } from "vitest";
import { DEFAULT_LICENSE_ALLOWLIST, isLicenseAllowed } from "./license-policy.js";

describe("isLicenseAllowed — parenthesis guard (mutation-kill w54)", () => {
	// positive (must fire): a lone "(" in a later OR-disjunct must block the
	// WHOLE expression, even though an earlier disjunct ("MIT") alone would
	// otherwise be allowed. This distinguishes the real `||` guard from a
	// mutated `&&` (which would need BOTH "(" and ")" present) or a
	// mutated always-false guard (which would never block).
	// test-contract: public-api — isLicenseAllowed's doc comment says a
	// parenthesized sub-expression is never evaluated and returns false.
	it("P1: blocks when only '(' is present, before an otherwise-allowed disjunct", () => {
		expect(isLicenseAllowed("MIT OR (", ["MIT"])).toBe(false);
	});

	// test-contract: public-api — same guard, ')' side of the OR condition.
	it("P2: blocks when only ')' is present, before an otherwise-allowed disjunct", () => {
		expect(isLicenseAllowed("MIT OR )", ["MIT"])).toBe(false);
	});

	// test-contract: boundary — control case proving the OR-disjunct match
	// itself works when no parens are present, isolating the guard's effect.
	it("N1: clean OR expression with no parens is allowed via the first disjunct", () => {
		expect(isLicenseAllowed("MIT OR GPL-3.0", ["MIT"])).toBe(true);
	});
});

describe("isLicenseAllowed — '+' range guard regex (mutation-kill w54)", () => {
	// The literal id happens to end in "+" at the very end of the string:
	// only the original /\+\s*($|\s)/ (matching "+" immediately followed by
	// end-of-string) blocks this. A mutant requiring a literal trailing
	// whitespace char (no `$` alternative) fails to match and lets it through.
	// test-contract: public-api — doc comment states "+" ranges are a
	// complex shape that always returns false, regardless of the allowlist.
	it("P1: blocks an id ending in '+' at end of string even if allowlisted verbatim", () => {
		expect(isLicenseAllowed("MIT+", ["mit+"])).toBe(false);
	});

	// The literal id has non-whitespace directly after "+" with nothing after
	// that (string ends right there). Original regex requires \s* (whitespace
	// only) between "+" and the end/whitespace anchor, so "+X" at end of
	// string does NOT match — not blocked. Mutants using \S* (non-whitespace)
	// before the anchor, or \S in the final alternative, both incorrectly
	// match here and block it.
	// test-contract: boundary — the "+" guard is scoped to "+" at a real
	// SPDX range position (end-of-string/whitespace), not any "+" anywhere.
	it("P2: does not block a '+' immediately followed by a non-whitespace suffix", () => {
		expect(isLicenseAllowed("MIT+X", ["mit+x"])).toBe(true);
	});
});

describe("isLicenseAllowed — allowlist normalization (mutation-kill w54)", () => {
	// The Set of allowed ids is built by trimming + lowercasing each allowlist
	// entry. If that trim is dropped, a padded entry like " MIT " becomes
	// " mit " (only lowercased) and a clean "MIT" lookup no longer matches.
	// test-contract: public-api — isLicenseAllowed is meant to compare
	// SPDX ids case-insensitively and whitespace-insensitively on both sides.
	it("P1: allowlist entries with stray whitespace still match a clean expression", () => {
		expect(isLicenseAllowed("MIT", [" MIT "])).toBe(true);
	});

	// test-contract: boundary — control case confirming the allowlist is
	// still selective, not merely returning true for any/all input.
	it("N1: an id not on the (trimmed) allowlist is rejected", () => {
		expect(isLicenseAllowed("GPL-3.0", [" MIT "])).toBe(false);
	});
});

describe("DEFAULT_LICENSE_ALLOWLIST — permissive seed entries (mutation-kill w54)", () => {
	const expected = [
		"BSD-2-Clause",
		"BSL-1.0",
		"Unlicense",
		"CC0-1.0",
		"0BSD",
		"Zlib",
		"MIT-0",
		"Unicode-3.0",
		"CDLA-Permissive-2.0",
	];

	for (const id of expected) {
		// test-contract: public-api — each of these SPDX ids is a named
		// entry in the exported permissive seed; the module doc says
		// projects rely on it directly for supply-chain admission.
		it(`P: DEFAULT_LICENSE_ALLOWLIST includes ${id}`, () => {
			expect(DEFAULT_LICENSE_ALLOWLIST).toContain(id);
			expect(isLicenseAllowed(id, DEFAULT_LICENSE_ALLOWLIST)).toBe(true);
		});
	}

	// test-contract: invariant — the seed is a curated list of real SPDX
	// identifiers; an empty-string entry would silently allow any
	// whitespace-only expression pathway through isLicenseAllowed.
	it("N: DEFAULT_LICENSE_ALLOWLIST does not contain an empty-string entry", () => {
		expect(DEFAULT_LICENSE_ALLOWLIST).not.toContain("");
	});
});
