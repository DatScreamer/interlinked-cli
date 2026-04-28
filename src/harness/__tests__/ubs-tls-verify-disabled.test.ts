// Tests for `ubs_tls_verify_disabled` (row 24 of Phase-1 Plan 04 phase matrix).
// Cross-language: catches Python `verify=False`, Go `InsecureSkipVerify: true`,
// and Node `rejectUnauthorized: false` — all MitM vectors.

import { describe, expect, it } from "vitest";
import { checkTlsVerifyDisabled } from "../checks/agent-safety.js";

describe("checkTlsVerifyDisabled", () => {
	it("flags Python `requests.get(url, verify=False)`", () => {
		const code = "r = requests.get(url, verify=False)";
		const matches = checkTlsVerifyDisabled(code, "client.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Go `&tls.Config{InsecureSkipVerify: true}`", () => {
		const code = [
			"transport := &http.Transport{",
			"  TLSClientConfig: &tls.Config{InsecureSkipVerify: true},",
			"}",
		].join("\n");
		const matches = checkTlsVerifyDisabled(code, "main.go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Node `{ rejectUnauthorized: false }`", () => {
		const code = "const opts = { rejectUnauthorized: false };";
		const matches = checkTlsVerifyDisabled(code, "client.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `verify=True` (correct usage)", () => {
		const code = "r = requests.get(url, verify=True)";
		expect(checkTlsVerifyDisabled(code, "client.py")).toEqual([]);
	});

	it("does NOT flag `InsecureSkipVerify: false` (correct usage)", () => {
		const code = "tls.Config{InsecureSkipVerify: false}";
		expect(checkTlsVerifyDisabled(code, "main.go")).toEqual([]);
	});

	it("does NOT flag `rejectUnauthorized: true` (correct usage)", () => {
		const code = "{ rejectUnauthorized: true }";
		expect(checkTlsVerifyDisabled(code, "client.ts")).toEqual([]);
	});

	it("does NOT flag `verify=False` inside a comment", () => {
		const code = "# don't use verify=False here";
		expect(checkTlsVerifyDisabled(code, "client.py")).toEqual([]);
	});

	it("does NOT flag the literal string \"verify=False\"", () => {
		const code = 'const msg = "verify=False is unsafe";';
		expect(checkTlsVerifyDisabled(code, "doc.ts")).toEqual([]);
	});
});
