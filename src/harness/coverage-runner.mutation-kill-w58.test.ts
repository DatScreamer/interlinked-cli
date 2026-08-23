import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	coverageLanguageForPath,
	JsCoverageRunner,
	PythonCoverageRunner,
	type SpawnFn,
} from "./coverage-runner.js";

describe("coverage-runner.ts mutation kills (w58)", () => {
	let tmpDirs: string[] = [];
	function makeTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "cov-runner-w58-"));
		tmpDirs.push(dir);
		return dir;
	}
	afterEach(() => {
		for (const dir of tmpDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tmpDirs = [];
	});

	// --- coverageLanguageForPath: dot >= 0 vs dot > 0 (mutant 21ae2f6a08bacd31) ---
	describe("coverageLanguageForPath — positive (must fire)", () => {
		it("P1: a leading-dot path ('.ts', dot index 0) resolves to 'ts'", () => {
			// lastIndexOf(".") === 0 here. Original: dot >= 0 is true, so the
			// extension is sliced and matched. Mutated to `dot > 0`, 0 > 0 is
			// false, so the ext falls back to "" and the function returns null.
			expect(coverageLanguageForPath(".ts")).toBe("ts");
		});
		it("P2: an ordinary '.py' path resolves to 'python'", () => {
			expect(coverageLanguageForPath("src/foo.py")).toBe("python");
		});
	});
	describe("coverageLanguageForPath — negative (must not fire)", () => {
		it("N1: an extensionless path returns null", () => {
			expect(coverageLanguageForPath("Makefile")).toBeNull();
		});
	});

	// --- defaultSpawn stdio array (mutant 3f1e75e5c795ad12): ["ignore","pipe","pipe"] vs [] ---
	// With stdio[0] === "ignore" (original), a child reading from stdin (like
	// `cat` with no args) sees immediate EOF and exits fast. If stdio becomes
	// `[]`, node defaults the missing slots to "pipe", so stdin stays open and
	// nothing ever closes it — `cat` blocks until the timeout kills it.
	it("P3: stdin is closed for the child (stdio[0] is 'ignore', not left open)", async () => {
		const dir = makeTmpDir();
		const runner = new JsCoverageRunner();
		const result = await runner.run({
			projectRoot: dir,
			coverageDir: dir,
			testCommand: ["cat"],
			timeoutMs: 400,
		});
		expect(result.ok).toBe(false);
		// Original: cat gets EOF immediately and exits well under the timeout,
		// so the failure is "no parseable coverage", never a timeout.
		expect(result.error ?? "").not.toMatch(/timed out|ETIMEDOUT/i);
		expect(result.suiteMs).toBeLessThan(300);
	}, 10_000);

	// --- Local .bin resolution (mutants cbb37812c2e92dd4, acfebf6af0a51454,
	//     abdf668dedef0901, 8caf635adb5f9bb9): all four collapse the
	//     `!rawBin.includes("/") && existsSync(localBin)` local-bin lookup so a
	//     bare command name is launched from PATH instead of
	//     `<projectRoot>/node_modules/.bin/<rawBin>`. We plant an executable at
	//     that exact local path (under a bin name that certainly doesn't exist
	//     on PATH) and confirm it actually gets invoked. ---
	it("P4: a bare command name is resolved through node_modules/.bin when present", async () => {
		const dir = makeTmpDir();
		const binDir = join(dir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		const markerPath = join(dir, "marker.txt");
		const scriptPath = join(binDir, "probebin12345");
		writeFileSync(scriptPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 0\n`);
		chmodSync(scriptPath, 0o755);

		const runner = new JsCoverageRunner();
		const result = await runner.run({
			projectRoot: dir,
			coverageDir: dir,
			testCommand: ["probebin12345"],
			timeoutMs: 5_000,
		});

		// Original: the local script runs and creates the marker file. If the
		// local-bin lookup is short-circuited (any of the four mutants), the
		// bare name "probebin12345" is looked up on PATH, fails with ENOENT,
		// and the marker is never created.
		expect(existsSync(markerPath)).toBe(true);
		// Also confirm we didn't fall into the "not found" launch-failure path.
		expect(result.error ?? "").not.toMatch(/not found/i);
	}, 10_000);

	// --- Date.now() - start vs Date.now() + start (mutants 9108696f4a8afe3c,
	//     510ed38cbb8ebf18): flipping the subtraction to addition inflates
	//     suiteMs to roughly 2x the current epoch millis (trillions), instead
	//     of a small elapsed-time number. ---
	it("P5: suiteMs reports a small elapsed duration, not an epoch-scale sum", async () => {
		const dir = makeTmpDir();
		const runner = new JsCoverageRunner();
		const result = await runner.run({
			projectRoot: dir,
			coverageDir: dir,
			testCommand: ["node", "-e", "process.exit(0)"],
			timeoutMs: 10_000,
		});
		expect(result.suiteMs).toBeGreaterThanOrEqual(0);
		expect(result.suiteMs).toBeLessThan(60_000);
	}, 10_000);

	// --- Runner id string literals (mutants 3f79986a97bb1141, 10a429933d0ed488) ---
	it("P6: JsCoverageRunner.id is 'vitest' and PythonCoverageRunner.id is 'coverage-py'", () => {
		expect(new JsCoverageRunner().id).toBe("vitest");
		expect(new PythonCoverageRunner().id).toBe("coverage-py");
	});

	// --- PythonCoverageRunner failure-message construction (mutants
	//     ed3586cd54046bf0: `outcome.error ?? "suite did not run"` -> `&&`,
	//     and 35a106ce4835fad0: the pytest-cov hint string -> "") ---
	it("P7: a launch failure surfaces the ACTUAL error text, not a fixed fallback", async () => {
		const dir = makeTmpDir();
		const failingSpawn: SpawnFn = async () => ({
			stdout: "",
			stderr: "",
			status: null,
			error: new Error("boom-marker-xyz"),
		});
		const runner = new PythonCoverageRunner(failingSpawn);
		const result = await runner.run({ projectRoot: dir, coverageDir: dir });
		expect(result.ok).toBe(false);
		expect(result.testsPassed).toBeNull();
		// Original: outcome.error is truthy, so `?? "suite did not run"` passes
		// it through unchanged — the real launch-failure text survives.
		// Mutated to `&&`, a truthy outcome.error yields the literal
		// "suite did not run" instead, losing "boom-marker-xyz".
		expect(result.error).toContain("boom-marker-xyz");
	});

	it("P8: a missing coverage.json names pytest-cov in the error hint", async () => {
		const dir = makeTmpDir();
		const okSpawn: SpawnFn = async () => ({
			stdout: "",
			stderr: "",
			status: 0,
		});
		const runner = new PythonCoverageRunner(okSpawn);
		const result = await runner.run({ projectRoot: dir, coverageDir: dir });
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("pytest-cov (--cov --cov-report=json)?");
	});
});
