import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Commander wiring runs side-effects on import (parseAsync at module load),
// so we exercise the entry via a child process with different argv tails.
// tsx is a devDependency — available in this repo's dev/test env.
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("npx", ["tsx", ENTRY, ...args], {
		encoding: "utf-8",
		timeout: 30_000,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, CI: "1", NO_COLOR: "1" },
	});
	return {
		status: result.status,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
	};
}

describe("CLI entry (src/index.ts)", () => {
	it("prints a version string for --version", () => {
		const { status, stdout } = runCli(["--version"]);
		expect(status).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	}, 45_000);

	it("prints help including the `interlinked` name", () => {
		const { status, stdout } = runCli(["--help"]);
		expect(status).toBe(0);
		expect(stdout).toMatch(/interlinked/);
		expect(stdout).toMatch(/Interlinked CLI/i);
	}, 45_000);

	it("exits non-zero on an unknown command", () => {
		const { status, stdout, stderr } = runCli(["nope-this-does-not-exist"]);
		// commander writes the error to stderr and exits 1 in strict mode, but
		// may print usage to stdout. Either way the exit code should be non-zero.
		expect(status).not.toBe(0);
		expect(stdout + stderr).toMatch(/unknown command|error/i);
	}, 45_000);
});
