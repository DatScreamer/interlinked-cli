// Tests for `ubs_subprocess_shell_true` (row 23 of Phase-1 Plan 04 phase matrix).
// Detects `subprocess.<call>(..., shell=True)` in Python — command-injection vector.

import { describe, expect, it } from "vitest";
import { checkSubprocessShellTrue } from "../checks/ubs-language-specific.js";

describe("checkSubprocessShellTrue", () => {
	it("flags `subprocess.run(cmd, shell=True)`", () => {
		const code = "subprocess.run(cmd, shell=True)";
		const matches = checkSubprocessShellTrue(code, "main.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `subprocess.Popen(args, shell=True)`", () => {
		const code = "subprocess.Popen(args, shell=True, stdout=subprocess.PIPE)";
		const matches = checkSubprocessShellTrue(code, "worker.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `subprocess.check_output(s, shell=True)` across newlines", () => {
		const code = [
			"result = subprocess.check_output(",
			"    user_input,",
			"    shell=True,",
			")",
		].join("\n");
		const matches = checkSubprocessShellTrue(code, "lib.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `subprocess.run([\"ls\", \"-la\"])` (list arg, no shell)", () => {
		const code = 'subprocess.run(["ls", "-la"])';
		expect(checkSubprocessShellTrue(code, "main.py")).toEqual([]);
	});

	it("does NOT flag `subprocess.run(cmd, shell=False)` (explicit safe form)", () => {
		const code = "subprocess.run(cmd, shell=False)";
		expect(checkSubprocessShellTrue(code, "main.py")).toEqual([]);
	});

	it("does NOT flag a comment that mentions shell=True", () => {
		const code = "# never use shell=True with user input";
		expect(checkSubprocessShellTrue(code, "main.py")).toEqual([]);
	});

	it("returns empty for non-Python files", () => {
		const code = "subprocess.run(cmd, shell=True)";
		expect(checkSubprocessShellTrue(code, "main.ts")).toEqual([]);
		expect(checkSubprocessShellTrue(code, "main.rs")).toEqual([]);
	});
});
