import { describe, expect, it } from "vitest";
import { coverageScopeId, formatScopeReanchorWarning } from "./coverage-scope.js";

describe("coverageScopeId", () => {
	it("returns the stable 'full' id for a full-suite run", () => {
		expect(coverageScopeId(undefined)).toBe("full");
	});

	it("hashes a scoped test list order-insensitively", () => {
		const a = coverageScopeId(["b.test.ts", "a.test.ts"]);
		const b = coverageScopeId(["a.test.ts", "b.test.ts"]);
		expect(a).toBe(b);
		expect(a).toMatch(/^scoped:[0-9a-f]{12}$/);
	});

	it("distinguishes different test sets", () => {
		expect(coverageScopeId(["a.test.ts"])).not.toBe(coverageScopeId(["a.test.ts", "b.test.ts"]));
		expect(coverageScopeId(["a.test.ts"])).not.toBe(coverageScopeId(undefined));
	});

	it("treats an empty scoped list as its own scope, not full", () => {
		expect(coverageScopeId([])).toMatch(/^scoped:/);
	});
});

describe("formatScopeReanchorWarning", () => {
	it("names the file, both fractions unrounded, and the new scope", () => {
		const warning = formatScopeReanchorWarning("src/x.ts", 1, 0.987, "scoped:abc123def456");
		expect(warning).toContain("[interlinked:coverage]");
		expect(warning).toContain("src/x.ts");
		expect(warning).toContain("100.0%");
		expect(warning).toContain("98.7%");
		expect(warning).toContain("scoped:abc123def456");
		expect(warning).toContain("re-anchored");
		expect(warning).not.toContain("BLOCKED");
	});
});
