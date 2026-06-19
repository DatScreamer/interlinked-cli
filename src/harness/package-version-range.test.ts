// ===========================================
// package-version-range — the screened version is always INSIDE the range
// ===========================================
// resolveScreenVersion picks the version the supply-chain admission screens
// (license + OSV) inspect for a `--version-range` approval. The contract under
// test: it returns a version the range ADMITS (its lower-bound floor), never an
// exclusive upper bound (`<2.0.0` → `2.0.0`), and null when there is no lower
// bound so the caller can fall back to latest loudly (finding 2026-06, round 8).

import { describe, expect, it } from "vitest";
import { resolveScreenVersion } from "./package-version-range.js";

describe("resolveScreenVersion — common lower-bounded / exact forms", () => {
	it("returns the floor of the usual range shapes", () => {
		expect(resolveScreenVersion("1.2.3")).toBe("1.2.3");
		expect(resolveScreenVersion("=1.2.3")).toBe("1.2.3");
		expect(resolveScreenVersion("==1.2.3")).toBe("1.2.3"); // pip exact
		expect(resolveScreenVersion("^1.2.3")).toBe("1.2.3");
		expect(resolveScreenVersion("~1.2.3")).toBe("1.2.3");
		expect(resolveScreenVersion("~0.4.1-beta.2")).toBe("0.4.1-beta.2");
		expect(resolveScreenVersion(">=2.0.0 <3")).toBe("2.0.0");
	});

	it("normalizes a partial numeric core to major.minor.patch", () => {
		expect(resolveScreenVersion(">=1")).toBe("1.0.0");
		expect(resolveScreenVersion("^1")).toBe("1.0.0");
		expect(resolveScreenVersion("~1.2")).toBe("1.2.0");
		expect(resolveScreenVersion("1.x")).toBe("1.0.0");
	});

	it("floors a hyphen range at its left endpoint", () => {
		expect(resolveScreenVersion("1.2.3 - 2.3.4")).toBe("1.2.3");
	});

	it("floors a pip comma-separated compound range", () => {
		expect(resolveScreenVersion(">=1.2.3, <2.0.0")).toBe("1.2.3");
	});
});

describe("resolveScreenVersion — never selects an excluded upper bound (the fix)", () => {
	it("returns null for a purely upper-bounded range (was the excluded 2.0.0)", () => {
		// `<2.0.0` FORBIDS 2.0.0; screening it would vouch for in-range 1.x it
		// never looked at. No lower bound → null (caller screens latest loudly).
		expect(resolveScreenVersion("<2.0.0")).toBeNull();
		expect(resolveScreenVersion("<=2.0.0")).toBeNull();
	});

	it("takes the LOWER bound of a bounded range, not the upper literal", () => {
		// Old bug: `1` didn't match the literal regex, so the first literal found
		// was the upper `2.0.0` — outside the approved set. Now floors at 1.0.0.
		expect(resolveScreenVersion(">=1 <2.0.0")).toBe("1.0.0");
		expect(resolveScreenVersion(">=1.5.0 <2.0.0")).toBe("1.5.0");
	});

	it("screens the boundary literal of an exclusive lower bound (over-reports, fail-safe)", () => {
		expect(resolveScreenVersion(">1.2.3")).toBe("1.2.3");
	});
});

describe("resolveScreenVersion — Go v-prefixed pins (the OSV-skip fix)", () => {
	it("screens a v-prefixed pin instead of returning null, preserving the v for OSV", () => {
		// Go module pins (`v0.9.1`) used to miss the floor regex → null → Go (which
		// has no registry-version API) then skipped the OSV advisory screen
		// entirely, admitting a vulnerable pin without --force (finding 2026-06).
		expect(resolveScreenVersion("v0.9.1")).toBe("v0.9.1");
		expect(resolveScreenVersion("=v1.2.3")).toBe("v1.2.3");
		expect(resolveScreenVersion(">=v1.2.0")).toBe("v1.2.0");
		expect(resolveScreenVersion(">=v1.2.0 <v2.0.0")).toBe("v1.2.0");
		expect(resolveScreenVersion("v1.2.3 - v2.3.4")).toBe("v1.2.3");
	});

	it("normalizes a partial v-prefixed core, keeping the prefix", () => {
		expect(resolveScreenVersion("v1")).toBe("v1.0.0");
		expect(resolveScreenVersion("~v1.2")).toBe("v1.2.0");
	});

	it("still excludes a v-prefixed exclusive upper bound", () => {
		expect(resolveScreenVersion("<v2.0.0")).toBeNull();
	});
});

describe("resolveScreenVersion — no resolvable literal", () => {
	it("returns null for wildcards and dist-tags", () => {
		expect(resolveScreenVersion("*")).toBeNull();
		expect(resolveScreenVersion("latest")).toBeNull();
		expect(resolveScreenVersion("")).toBeNull();
	});
});
