// Tests for `ubs_node_create_cipher` — deprecated Node crypto.createCipher.

import { describe, expect, it } from "vitest";
import { checkNodeCreateCipher } from "../checks/ubs-language-specific.js";

describe("checkNodeCreateCipher — positive cases", () => {
	it("flags `crypto.createCipher(...)`", () => {
		const code = `const c = crypto.createCipher("aes-256-cbc", password);`;
		expect(checkNodeCreateCipher(code, "src/c.ts").length).toBeGreaterThan(0);
	});

	it("flags destructured `createCipher(...)`", () => {
		const code = `const { createCipher } = require("crypto");\nconst c = createCipher("aes", k);`;
		expect(checkNodeCreateCipher(code, "src/c.js").length).toBeGreaterThan(0);
	});

	it("flags `crypto.createDecipher(...)`", () => {
		const code = `const d = crypto.createDecipher("aes-256-cbc", password);`;
		expect(checkNodeCreateCipher(code, "src/c.ts").length).toBeGreaterThan(0);
	});
});

describe("checkNodeCreateCipher — negative cases", () => {
	it("does NOT flag the safe `createCipheriv(...)`", () => {
		const code = `const c = crypto.createCipheriv("aes-256-gcm", key, iv);`;
		expect(checkNodeCreateCipher(code, "src/c.ts")).toEqual([]);
	});

	it("does NOT flag `createDecipheriv(...)`", () => {
		const code = `const d = crypto.createDecipheriv("aes-256-gcm", key, iv);`;
		expect(checkNodeCreateCipher(code, "src/c.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		expect(checkNodeCreateCipher("createCipher(k)", "src/c.py")).toEqual([]);
	});

	it("skips test files", () => {
		expect(checkNodeCreateCipher("crypto.createCipher(k)", "src/c.test.ts")).toEqual([]);
	});
});
