// Tests for `ubs_aes_ecb_mode` — AES in ECB mode across languages.

import { describe, expect, it } from "vitest";
import { checkAesEcbMode } from "../generic-checks.js";

describe("checkAesEcbMode — positive cases", () => {
	it("flags Python pycryptodome `AES.MODE_ECB`", () => {
		const code = "cipher = AES.new(key, AES.MODE_ECB)";
		expect(checkAesEcbMode(code, "src/c.py").length).toBeGreaterThan(0);
	});

	it("flags `cryptography` lib `modes.ECB(...)`", () => {
		const code = "from cryptography.hazmat.primitives.ciphers import modes\nm = modes.ECB()";
		expect(checkAesEcbMode(code, "src/c.py").length).toBeGreaterThan(0);
	});

	it("flags Node algorithm string `\"aes-128-ecb\"`", () => {
		const code = `const cipher = crypto.createCipheriv("aes-128-ecb", key, "");`;
		expect(checkAesEcbMode(code, "src/c.ts").length).toBeGreaterThan(0);
	});

	it("flags Node algorithm string `'aes-256-ecb'`", () => {
		const code = `const cipher = crypto.createCipheriv('aes-256-ecb', key, '');`;
		expect(checkAesEcbMode(code, "src/c.ts").length).toBeGreaterThan(0);
	});

	it("flags Go `cipher.NewECBEncrypter(...)`", () => {
		const code = "enc := cipher.NewECBEncrypter(block)";
		expect(checkAesEcbMode(code, "src/c.go").length).toBeGreaterThan(0);
	});
});

describe("checkAesEcbMode — negative cases", () => {
	it("does NOT flag `AES.MODE_GCM`", () => {
		expect(checkAesEcbMode("AES.new(key, AES.MODE_GCM)", "src/c.py")).toEqual([]);
	});

	it("does NOT flag `\"aes-256-gcm\"`", () => {
		const code = `crypto.createCipheriv("aes-256-gcm", key, iv);`;
		expect(checkAesEcbMode(code, "src/c.ts")).toEqual([]);
	});

	it("does NOT flag `\"aes-128-cbc\"`", () => {
		const code = `crypto.createCipheriv("aes-128-cbc", key, iv);`;
		expect(checkAesEcbMode(code, "src/c.ts")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkAesEcbMode("AES.MODE_ECB", "tests/test_c.py")).toEqual([]);
	});
});
