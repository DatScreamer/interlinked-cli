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

	// FP refinement (139-repo audit, 2026-05): Bandit `# noqa: S602 /
	// S603` is the explicit, reasoned, intentional acknowledgment.
	// Supermodel's mcpbr/tutorial.py:854 was the canonical case (tutorial
	// validation runs user-defined shell commands by design).

	it("does NOT fire on `subprocess.run(cmd, shell=True)  # noqa: S602`", () => {
		const code = `result = subprocess.run(cmd, shell=True)  # noqa: S602`;
		expect(checkSubprocessShellTrue(code, "src/runner.py")).toEqual([]);
	});

	it("does NOT fire on multi-line call with `# noqa: S602` on opening line", () => {
		// The canonical Supermodel mcpbr/tutorial.py:854 shape — the
		// noqa sits on the line where the call STARTS, but the match
		// anchors on the deeper `shell=True` keyword line.
		const code = [
			"result = subprocess.run(  # noqa: S602 -- tutorial validation runs user-defined shell commands by design",
			"    cmd,",
			"    shell=True,",
			"    capture_output=True,",
			")",
		].join("\n");
		expect(checkSubprocessShellTrue(code, "src/tutorial.py")).toEqual([]);
	});

	it("does NOT fire on `subprocess.Popen(..., shell=True)` with `# noqa: S603`", () => {
		const code = `proc = subprocess.Popen(cmd, shell=True)  # noqa: S603`;
		expect(checkSubprocessShellTrue(code, "src/proc.py")).toEqual([]);
	});

	// Positive cases — real positives MUST still fire.

	it("STILL fires on `subprocess.run(cmd, shell=True)` with no noqa", () => {
		const code = `subprocess.run(cmd, shell=True)`;
		expect(checkSubprocessShellTrue(code, "src/runner.py").length).toBeGreaterThan(0);
	});

	it("STILL fires when noqa carries an unrelated bandit code", () => {
		// S301 (pickle) must NOT suppress shell=True.
		const code = `subprocess.run(cmd, shell=True)  # noqa: S301`;
		expect(checkSubprocessShellTrue(code, "src/runner.py").length).toBeGreaterThan(0);
	});

	it("STILL fires when noqa is on a different (out-of-range) line", () => {
		// noqa on line 1 — the call is on lines 3-5; noqa range is the
		// CALL itself, not the whole file.
		const code = [
			"# noqa: S602  -- this is just a comment, not on the call",
			"",
			"def run(cmd):",
			"    return subprocess.run(cmd, shell=True)",
		].join("\n");
		expect(checkSubprocessShellTrue(code, "src/runner.py").length).toBeGreaterThan(0);
	});
});
