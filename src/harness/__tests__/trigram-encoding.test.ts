// @perf — benchmark tests in this file use Date.now() for timing
// characterization. Fake timers would defeat the measurement. Opt out of
// the non_deterministic_test check via this marker (see taste-checks.ts).

import { describe, expect, it } from "vitest";
import {
	extractTrigrams,
	isBinaryContent,
	packTrigram,
	shouldSkipFile,
	trigramToString,
	unpackTrigram,
} from "../trigram-index.js";

// ===========================================
// Trigram Encoding
// ===========================================

describe("packTrigram / unpackTrigram", () => {
	it("roundtrips ASCII characters", () => {
		const packed = packTrigram(0x61, 0x62, 0x63); // "abc"
		const [a, b, c] = unpackTrigram(packed);
		expect(a).toBe(0x61);
		expect(b).toBe(0x62);
		expect(c).toBe(0x63);
	});

	it("handles high byte values", () => {
		const packed = packTrigram(0xff, 0x00, 0x7f);
		const [a, b, c] = unpackTrigram(packed);
		expect(a).toBe(0xff);
		expect(b).toBe(0x00);
		expect(c).toBe(0x7f);
	});

	it("produces unique values for different trigrams", () => {
		const abc = packTrigram(0x61, 0x62, 0x63);
		const abd = packTrigram(0x61, 0x62, 0x64);
		const bac = packTrigram(0x62, 0x61, 0x63);
		expect(abc).not.toBe(abd);
		expect(abc).not.toBe(bac);
	});

	it("masks to byte range", () => {
		const packed = packTrigram(0x161, 0x262, 0x363);
		const [a, b, c] = unpackTrigram(packed);
		expect(a).toBe(0x61); // 0x161 & 0xFF
		expect(b).toBe(0x62);
		expect(c).toBe(0x63);
	});
});

describe("trigramToString", () => {
	it("converts packed trigram to readable string", () => {
		const packed = packTrigram(0x61, 0x62, 0x63);
		expect(trigramToString(packed)).toBe("abc");
	});

	it("handles space characters", () => {
		const packed = packTrigram(0x20, 0x61, 0x20);
		expect(trigramToString(packed)).toBe(" a ");
	});
});

// ===========================================
// Trigram Extraction
// ===========================================

describe("extractTrigrams", () => {
	it("extracts overlapping trigrams from a simple string", () => {
		const trigrams = extractTrigrams("abcde");
		// "abc", "bcd", "cde"
		expect(trigrams.size).toBe(3);
		expect(trigrams.has(packTrigram(0x61, 0x62, 0x63))).toBe(true); // abc
		expect(trigrams.has(packTrigram(0x62, 0x63, 0x64))).toBe(true); // bcd
		expect(trigrams.has(packTrigram(0x63, 0x64, 0x65))).toBe(true); // cde
	});

	it("lowercases all characters", () => {
		const upper = extractTrigrams("ABC");
		const lower = extractTrigrams("abc");
		expect(upper.size).toBe(1);
		expect(lower.size).toBe(1);
		// Both should produce the same trigram
		const upperVal = [...upper][0];
		const lowerVal = [...lower][0];
		expect(upperVal).toBe(lowerVal);
	});

	it("returns empty set for strings shorter than 3 chars", () => {
		expect(extractTrigrams("").size).toBe(0);
		expect(extractTrigrams("a").size).toBe(0);
		expect(extractTrigrams("ab").size).toBe(0);
	});

	it("returns exactly one trigram for 3-char string", () => {
		expect(extractTrigrams("abc").size).toBe(1);
	});

	it("deduplicates repeated trigrams", () => {
		// "aaaa" → "aaa", "aaa", "aaa" but only 1 unique
		const trigrams = extractTrigrams("aaaa");
		expect(trigrams.size).toBe(1);
	});

	it("handles whitespace (spaces, tabs, newlines)", () => {
		const trigrams = extractTrigrams("a b");
		// "a " + " b" → trigrams: "a b"
		expect(trigrams.size).toBe(1);
	});

	it("includes tab characters in trigrams", () => {
		const trigrams = extractTrigrams("a\tb");
		expect(trigrams.size).toBe(1);
	});

	it("includes newline characters in trigrams", () => {
		const trigrams = extractTrigrams("a\nb");
		expect(trigrams.size).toBe(1);
	});

	it("skips control characters below 0x09", () => {
		const content = "ab\x01cd";
		const trigrams = extractTrigrams(content);
		// "ab\x01" → skipped (control char)
		// "b\x01c" → skipped
		// "\x01cd" → skipped
		expect(trigrams.size).toBe(0);
	});

	it("handles unicode characters by clamping to byte range", () => {
		// Unicode chars > 255 get masked to byte range
		const trigrams = extractTrigrams("café");
		expect(trigrams.size).toBeGreaterThan(0);
	});

	it("handles realistic source code", () => {
		const code = `export function handleAuth(req: Request): Response {
    const token = req.headers.get("Authorization");
    if (!token) return new Response("Unauthorized", { status: 401 });
    return validateToken(token);
}`;
		const trigrams = extractTrigrams(code);
		// Should extract many trigrams from identifiers and keywords
		expect(trigrams.size).toBeGreaterThan(50);
	});

	it("extracts consistent trigrams regardless of surrounding context", () => {
		const t1 = extractTrigrams("xxhandleAuthyy");
		const t2 = extractTrigrams("handleAuth");
		// t2's trigrams should be a subset of t1's
		for (const tri of t2) {
			expect(t1.has(tri)).toBe(true);
		}
	});
});

// ===========================================
// Binary Detection
// ===========================================

describe("isBinaryContent", () => {
	it("detects null bytes as binary", () => {
		expect(isBinaryContent("hello\x00world")).toBe(true);
	});

	it("allows normal text", () => {
		expect(isBinaryContent("hello world\nfoo bar")).toBe(false);
	});

	it("handles empty input", () => {
		expect(isBinaryContent("")).toBe(false);
	});

	it("handles Buffer input", () => {
		expect(isBinaryContent(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
		expect(isBinaryContent(Buffer.from([0x68, 0x69]))).toBe(false);
	});

	it("only checks first 8KB", () => {
		// Null byte at position 9000 — should NOT be detected
		const content = `${"x".repeat(9000)}\x00`;
		expect(isBinaryContent(content)).toBe(false);
	});
});

// ===========================================
// Skip File Logic
// ===========================================

describe("shouldSkipFile", () => {
	it("skips lock files", () => {
		expect(shouldSkipFile("package-lock.json")).toBe(true);
		expect(shouldSkipFile("yarn.lock")).toBe(true);
		expect(shouldSkipFile("some/path/pnpm-lock.yaml")).toBe(true);
	});

	it("skips minified files", () => {
		expect(shouldSkipFile("bundle.min.js")).toBe(true);
		expect(shouldSkipFile("styles.min.css")).toBe(true);
	});

	it("skips source maps", () => {
		expect(shouldSkipFile("app.js.map")).toBe(true);
	});

	it("allows normal source files", () => {
		expect(shouldSkipFile("src/index.ts")).toBe(false);
		expect(shouldSkipFile("lib/utils.js")).toBe(false);
		expect(shouldSkipFile("README.md")).toBe(false);
	});
});
