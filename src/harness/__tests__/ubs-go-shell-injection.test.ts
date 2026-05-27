// Tests for `ubs_go_shell_injection` — Go exec.Command("sh"|"bash"|...).

import { describe, expect, it } from "vitest";
import { checkGoShellInjection } from "../checks/ubs-language-specific.js";

describe("checkGoShellInjection — positive cases", () => {
	it(`flags exec.Command("sh", "-c", ...)`, () => {
		const code = `cmd := exec.Command("sh", "-c", "ping -c 1 "+host)`;
		expect(checkGoShellInjection(code, "main.go").length).toBeGreaterThan(0);
	});

	it(`flags exec.Command("bash", "-c", ...)`, () => {
		const code = `cmd := exec.Command("bash", "-c", spec)`;
		expect(checkGoShellInjection(code, "main.go").length).toBeGreaterThan(0);
	});

	it(`flags exec.Command("/bin/sh", ...)`, () => {
		const code = `cmd := exec.Command("/bin/sh", "-c", spec)`;
		expect(checkGoShellInjection(code, "main.go").length).toBeGreaterThan(0);
	});

	it(`flags exec.Command("/bin/bash", ...)`, () => {
		const code = `cmd := exec.Command("/bin/bash", "-c", spec)`;
		expect(checkGoShellInjection(code, "main.go").length).toBeGreaterThan(0);
	});
});

describe("checkGoShellInjection — negative cases", () => {
	it(`does NOT flag exec.Command("ping", "-c", "1", host)`, () => {
		const code = `cmd := exec.Command("ping", "-c", "1", host)`;
		expect(checkGoShellInjection(code, "main.go")).toEqual([]);
	});

	it(`does NOT flag exec.Command("ls", "-la")`, () => {
		const code = `cmd := exec.Command("ls", "-la")`;
		expect(checkGoShellInjection(code, "main.go")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		expect(checkGoShellInjection(`exec.Command("sh", "-c", x)`, "main.py")).toEqual([]);
	});

	it("skips test files", () => {
		const code = `exec.Command("sh", "-c", x)`;
		expect(checkGoShellInjection(code, "main_test.go")).toEqual([]);
	});
});
