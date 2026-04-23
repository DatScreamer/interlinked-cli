import { describe, expect, it } from "vitest";
import { findOverlappingPattern, patternsOverlap } from "../glob-overlap.js";

describe("patternsOverlap", () => {
	it("exact match returns true", () => {
		expect(patternsOverlap("src/auth/login.ts", "src/auth/login.ts")).toBe(true);
	});

	it("different files return false", () => {
		expect(patternsOverlap("src/auth/login.ts", "src/auth/logout.ts")).toBe(false);
	});

	it("** matches any depth", () => {
		expect(patternsOverlap("src/auth/login.ts", "src/**")).toBe(true);
		expect(patternsOverlap("src/auth/deep/nested/file.ts", "src/**")).toBe(true);
	});

	it("** at start matches everything", () => {
		expect(patternsOverlap("**", "anything/at/all.ts")).toBe(true);
	});

	it("* matches single segment", () => {
		expect(patternsOverlap("src/*/login.ts", "src/auth/login.ts")).toBe(true);
		expect(patternsOverlap("src/*/login.ts", "src/api/login.ts")).toBe(true);
	});

	it("*.ext matches extension pattern", () => {
		expect(patternsOverlap("src/auth/*.ts", "src/auth/login.ts")).toBe(true);
		expect(patternsOverlap("src/auth/*.ts", "src/auth/login.js")).toBe(false);
	});

	it("different directories return false", () => {
		expect(patternsOverlap("src/auth/login.ts", "lib/auth/login.ts")).toBe(false);
	});

	it("case-insensitive mode", () => {
		expect(patternsOverlap("SRC/Auth/Login.ts", "src/auth/login.ts", true)).toBe(true);
		expect(patternsOverlap("SRC/Auth/Login.ts", "src/auth/login.ts", false)).toBe(false);
	});

	it("mixed wildcards and literal segments", () => {
		expect(patternsOverlap("src/*/handlers/*.ts", "src/tools/handlers/auth.ts")).toBe(true);
		expect(patternsOverlap("src/*/handlers/*.ts", "src/tools/utils/auth.ts")).toBe(false);
	});

	it("prefix glob pattern (test_*)", () => {
		expect(patternsOverlap("src/test_utils.ts", "src/test_*.ts")).toBe(true);
		expect(patternsOverlap("src/main_utils.ts", "src/test_*.ts")).toBe(false);
	});

	it("both patterns have wildcards", () => {
		expect(patternsOverlap("src/*.ts", "src/*.js")).toBe(false);
		expect(patternsOverlap("src/*.ts", "src/*.ts")).toBe(true);
	});

	it("shorter path can overlap with longer if ** is involved", () => {
		expect(patternsOverlap("src/**", "src/a/b/c.ts")).toBe(true);
	});

	it("different length without ** — partial overlap accepted", () => {
		// When paths have different lengths but all segments up to minLen match,
		// patternsOverlap returns true (conservative: possible overlap)
		expect(patternsOverlap("src/auth", "src/auth/login.ts")).toBe(true);
	});
});

describe("findOverlappingPattern", () => {
	it("returns first matching pattern", () => {
		const patterns = ["src/api/**", "src/auth/**", "test/**"];
		expect(findOverlappingPattern("src/auth/login.ts", patterns)).toBe("src/auth/**");
	});

	it("returns null when no match", () => {
		const patterns = ["src/api/**", "test/**"];
		expect(findOverlappingPattern("lib/utils.ts", patterns)).toBeNull();
	});

	it("returns first match even if multiple would match", () => {
		const patterns = ["src/**", "src/auth/**"];
		expect(findOverlappingPattern("src/auth/login.ts", patterns)).toBe("src/**");
	});

	it("handles empty patterns array", () => {
		expect(findOverlappingPattern("anything.ts", [])).toBeNull();
	});

	it("supports case-insensitive matching", () => {
		const patterns = ["SRC/Auth/**"];
		expect(findOverlappingPattern("src/auth/login.ts", patterns, true)).toBe("SRC/Auth/**");
		expect(findOverlappingPattern("src/auth/login.ts", patterns, false)).toBeNull();
	});
});
