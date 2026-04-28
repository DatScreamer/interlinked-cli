// Tests for `ubs_weak_hash` (row 26 of Phase-1 Plan 04 phase matrix).
// Cross-language: catches MD5 / SHA-1 calls — broken hashes for security.

import { describe, expect, it } from "vitest";
import { checkWeakHash } from "../checks/agent-safety.js";

describe("checkWeakHash", () => {
	it("flags Node `crypto.createHash('md5')(...)` style — `md5(buf)`", () => {
		const code = "const digest = md5(buffer);";
		const matches = checkWeakHash(code, "src/auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Python `hashlib.md5(...)`", () => {
		const code = "h = hashlib.md5(data).hexdigest()";
		const matches = checkWeakHash(code, "src/auth.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `sha1(buf)` (case insensitive: also matches `SHA1(`)", () => {
		const code = "fingerprint = SHA1(payload)";
		const matches = checkWeakHash(code, "src/sig.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `sha256(buf)` (acceptable)", () => {
		const code = "const h = sha256(buf);";
		expect(checkWeakHash(code, "src/auth.ts")).toEqual([]);
	});

	it("does NOT flag identifier `sha1234` (boundary FP guard)", () => {
		const code = "const sha1234 = somethingElse(x);";
		expect(checkWeakHash(code, "src/auth.ts")).toEqual([]);
	});

	it("does NOT flag the comment `// don't use md5(`", () => {
		const code = "// don't use md5(payload)";
		expect(checkWeakHash(code, "src/auth.ts")).toEqual([]);
	});

	it("does NOT flag hashes inside a string literal", () => {
		const code = 'const msg = "use sha256, not md5(";';
		expect(checkWeakHash(code, "src/auth.ts")).toEqual([]);
	});

	it("does NOT fire in test files (golden hash fixtures are routine)", () => {
		const code = "expect(md5(buf)).toBe('5d41402abc4b2a76b9719d911017c592');";
		expect(checkWeakHash(code, "src/auth.test.ts")).toEqual([]);
	});

	it("flags Node `crypto.createHash(\"md5\")` form (algorithm in string literal)", () => {
		// Regression: an earlier version pre-stripped string literals before
		// running the regex, which turned `createHash("md5")` into
		// `createHash("")` and silently missed Node's primary weak-hash API.
		const code = `const h = crypto.createHash("md5").update(buf).digest();`;
		const matches = checkWeakHash(code, "src/auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `createHash('sha1')` with single quotes", () => {
		const code = "import { createHash } from 'node:crypto';\nconst h = createHash('sha1');";
		const matches = checkWeakHash(code, "src/auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `createHash(`md5`)` with template literals", () => {
		const code = "const h = createHash(`md5`);";
		const matches = checkWeakHash(code, "src/auth.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `createHash(\"sha256\")` (acceptable algorithm)", () => {
		const code = `const h = crypto.createHash("sha256").update(buf).digest();`;
		expect(checkWeakHash(code, "src/auth.ts")).toEqual([]);
	});

	it("does NOT flag a commented-out `// createHash(\"md5\")`", () => {
		const code = `// example only: createHash("md5")`;
		expect(checkWeakHash(code, "src/auth.ts")).toEqual([]);
	});

	it("does not double-count when both forms appear on the same line", () => {
		// Synthetic but possible: both an `md5(` call and a `createHash("md5")`
		// on the same line should count as one finding (deduped by line index).
		const code = `const h = md5(createHash("md5").digest());`;
		const matches = checkWeakHash(code, "src/auth.ts");
		expect(matches.length).toBe(1);
	});
});
