import { describe, expect, it } from "vitest";
import {
	checkAesEcbMode,
	checkRecursiveWalkerLstat,
	checkTlsVerifyDisabled,
	checkWeakHash,
} from "./agent-safety-crypto.js";

// Smoke-test coverage for the agent-safety crypto / TLS / filesystem-safety
// check family. Deeper coverage lives in `src/harness/__tests__/`
// (`ubs-weak-hash.test.ts`, `ubs-tls-verify-disabled.test.ts`) and
// `__fixtures__/weak-hash.fixtures.test.ts` — this file satisfies the
// harness's per-source-file test rule and guards the shape of the exports.

describe("checkAesEcbMode", () => {
	it("flags AES.MODE_ECB in Python", () => {
		expect(checkAesEcbMode("c = AES.new(k, AES.MODE_ECB)", "a.py").length).toBeGreaterThan(0);
	});

	it("does NOT fire on AES-GCM strings", () => {
		expect(checkAesEcbMode('createCipheriv("aes-256-gcm", k, iv)', "a.ts")).toEqual([]);
	});
});

describe("checkTlsVerifyDisabled", () => {
	it("flags Python verify=False", () => {
		expect(checkTlsVerifyDisabled("requests.get(url, verify=False)", "a.py").length).toBeGreaterThan(
			0,
		);
	});

	it("flags Node rejectUnauthorized: false", () => {
		const out = checkTlsVerifyDisabled("https.request({ rejectUnauthorized: false })", "a.ts");
		expect(out.length).toBeGreaterThan(0);
	});

	it("does NOT fire on the shape inside a string literal", () => {
		const out = checkTlsVerifyDisabled('const msg = "verify=False is unsafe";', "a.ts");
		expect(out).toEqual([]);
	});
});

describe("checkWeakHash", () => {
	it("flags hashlib.md5(...)", () => {
		expect(checkWeakHash("h = hashlib.md5(data)", "a.py").length).toBeGreaterThan(0);
	});

	it("flags Node createHash(\"sha1\")", () => {
		expect(checkWeakHash('crypto.createHash("sha1")', "a.ts").length).toBeGreaterThan(0);
	});

	it("does NOT run on test files", () => {
		expect(checkWeakHash("h = hashlib.md5(data)", "a.test.ts")).toEqual([]);
	});
});

describe("checkRecursiveWalkerLstat", () => {
	const recursiveWalkerStatSync = [
		'import { readdirSync, statSync } from "node:fs";',
		"function walk(dir) {",
		"  for (const e of readdirSync(dir)) {",
		"    const p = dir + '/' + e;",
		"    const st = statSync(p);",
		"    if (st.isDirectory()) walk(p);",
		"  }",
		"}",
	].join("\n");

	it("flags a self-recursive walker that uses statSync to gate dir-recursion", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag the same walker once it switches to lstatSync", () => {
		const safe = recursiveWalkerStatSync.replace(/statSync/g, "lstatSync");
		const out = checkRecursiveWalkerLstat(safe, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("flags a class-method walker that recurses via this.<name>(...)", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"class Walker {",
			"  walk(dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      const p = dir + '/' + e;",
			"      if (statSync(p).isDirectory()) this.walk(p);",
			"    }",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag a non-recursive function that uses readdirSync + statSync", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"function listOne(dir) {",
			"  return readdirSync(dir).filter((e) => statSync(dir + '/' + e).isFile());",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a recursive function that doesn't read directories", () => {
		const src = [
			"function recurse(n) {",
			"  if (n <= 0) return;",
			"  recurse(n - 1);",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/x.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on test files", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.test.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.py");
		expect(out).toEqual([]);
	});
});
