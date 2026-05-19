// Tests for the shared internal helpers of the UBS language-specific
// detector modules. Extracted from ubs-language-specific.ts during the
// 1500-line decomposition.

import { describe, expect, it } from "vitest";
import {
	isJsTsFile,
	isNoqaSuppressedInRange,
	isPyFile,
	JS_TS_EXT_LIST,
	MATCH_LIMIT,
	PY_EXTS,
	stripCommentsPreservingStrings,
} from "./_shared.js";

describe("ubs-language-specific/_shared", () => {
	describe("isPyFile", () => {
		it("recognizes Python source extensions", () => {
			expect(isPyFile(".py")).toBe(true);
			expect(isPyFile(".pyi")).toBe(true);
		});
		it("rejects non-Python extensions", () => {
			expect(isPyFile(".ts")).toBe(false);
			expect(isPyFile(".go")).toBe(false);
			expect(isPyFile("")).toBe(false);
		});
	});

	describe("isJsTsFile", () => {
		it("recognizes JS/TS source extensions", () => {
			expect(isJsTsFile(".ts")).toBe(true);
			expect(isJsTsFile(".tsx")).toBe(true);
			expect(isJsTsFile(".mjs")).toBe(true);
			expect(isJsTsFile(".cts")).toBe(true);
		});
		it("rejects non-JS/TS extensions", () => {
			expect(isJsTsFile(".py")).toBe(false);
			expect(isJsTsFile(".rs")).toBe(false);
		});
	});

	describe("constants", () => {
		it("MATCH_LIMIT is 10", () => {
			expect(MATCH_LIMIT).toBe(10);
		});
		it("PY_EXTS and JS_TS_EXT_LIST are non-empty", () => {
			expect(PY_EXTS.length).toBeGreaterThan(0);
			expect(JS_TS_EXT_LIST.length).toBeGreaterThan(0);
		});
	});

	describe("stripCommentsPreservingStrings", () => {
		it("removes line comments but keeps string contents", () => {
			const out = stripCommentsPreservingStrings('const x = "a // b"; // tail');
			expect(out).toContain('"a // b"');
			expect(out).not.toContain("// tail");
		});

		it("removes hash comments", () => {
			const out = stripCommentsPreservingStrings("x = 1  # comment");
			expect(out).not.toContain("# comment");
			expect(out).toContain("x = 1");
		});

		it("removes block comments spanning lines", () => {
			const out = stripCommentsPreservingStrings("a\n/* block\ncomment */\nb");
			expect(out).toContain("a");
			expect(out).toContain("b");
			expect(out).not.toContain("block");
		});
	});

	describe("isNoqaSuppressedInRange", () => {
		it("detects a noqa within the scanned range", () => {
			const lines = ["x = run()  # noqa", "y = 2"];
			expect(isNoqaSuppressedInRange(lines, 1, 2, "ubs_x")).toBe(true);
		});

		it("returns false when no noqa appears in range", () => {
			const lines = ["x = run()", "y = 2"];
			expect(isNoqaSuppressedInRange(lines, 1, 2, "ubs_x")).toBe(false);
		});

		it("clamps out-of-bounds line numbers", () => {
			const lines = ["a  # noqa"];
			expect(isNoqaSuppressedInRange(lines, 0, 99, "ubs_x")).toBe(true);
		});
	});
});
