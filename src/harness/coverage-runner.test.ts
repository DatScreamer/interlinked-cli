import { type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetCoverageFinalCache } from "./coverage-final-reader.js";
import {
	COVERAGE_FINAL_FILENAME,
	type CoverageRunOpts,
	coverageRunnerFor,
	defaultJsTestCommand,
	defaultPythonTestCommand,
	JsCoverageRunner,
	PythonCoverageRunner,
	type SpawnFn,
} from "./coverage-runner.js";

// ==================================================================
// Helpers — stub spawn + a minimal istanbul coverage-final.json fixture
// ==================================================================

/** A successful spawn result (no error, exit 0). */
function okSpawnResult(): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: ["", "", ""],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
	};
}

/**
 * Build a stub spawn that (a) optionally sleeps `delayMs` to make `suiteMs`
 * measurable, (b) optionally writes a `coverage-final.json` into `coverageDir`,
 * and (c) returns `extra` overrides (e.g. an `error` to simulate ENOENT).
 */
function makeStubSpawn(cfg: {
	coverageDir?: string;
	writeReport?: boolean;
	delayMs?: number;
	extra?: Partial<SpawnSyncReturns<string>>;
}): { spawn: SpawnFn; calls: Array<{ command: string; args: string[] }> } {
	const calls: Array<{ command: string; args: string[] }> = [];
	const spawn: SpawnFn = (command, args) => {
		calls.push({ command, args });
		if (cfg.delayMs && cfg.delayMs > 0) {
			// Busy-wait keeps the stub synchronous (spawnSync is sync) while still
			// advancing wall-clock so `suiteMs` is provably > 0.
			const until = Date.now() + cfg.delayMs;
			while (Date.now() < until) {
				/* spin */
			}
		}
		if (cfg.writeReport && cfg.coverageDir) {
			writeFileSync(join(cfg.coverageDir, COVERAGE_FINAL_FILENAME), istanbulFixture(), "utf-8");
		}
		return { ...okSpawnResult(), ...cfg.extra };
	};
	return { spawn, calls };
}

/** Minimal istanbul `coverage-final.json` with one covered + one uncovered fn. */
function istanbulFixture(): string {
	// The reader keys by repo-relative path; use a path under the temp root that
	// each test sets at parse time via opts.projectRoot.
	const fixture = {
		__ABS__: {
			path: "__ABS__",
			fnMap: {
				"0": { name: "covered", decl: { start: { line: 1 }, end: { line: 3 } } },
				"1": { name: "uncovered", decl: { start: { line: 10 }, end: { line: 12 } } },
			},
			f: { "0": 5, "1": 0 },
			statementMap: {
				"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } },
				"1": { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
				"2": { start: { line: 10, column: 0 }, end: { line: 10, column: 9 } },
			},
			s: { "0": 5, "1": 5, "2": 0 },
		},
	};
	return JSON.stringify(fixture);
}

// ==================================================================
// Setup
// ==================================================================

let root: string;
let coverageDir: string;
let absSrc: string;

beforeEach(() => {
	__resetCoverageFinalCache();
	root = mkdtempSync(join(tmpdir(), "cov-runner-"));
	coverageDir = join(root, "coverage");
	mkdirSync(coverageDir, { recursive: true });
	absSrc = join(root, "src/foo.ts");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Rewrite the fixture's `__ABS__` placeholder to this test's absolute src path. */
function writeReportFor(absPath: string): void {
	const json = istanbulFixture().replace(/__ABS__/g, absPath.replace(/\\/g, "\\\\"));
	writeFileSync(join(coverageDir, COVERAGE_FINAL_FILENAME), json, "utf-8");
}

function baseOpts(): CoverageRunOpts {
	return { projectRoot: root, coverageDir };
}

// ==================================================================
// JsCoverageRunner — parses coverage-final.json into PerFileCoverage
// ==================================================================

describe("JsCoverageRunner", () => {
	it("parses a sample coverage-final.json into per-file PerFileCoverage", async () => {
		// Stub spawn writes the report (with the right abs path) when invoked.
		const spawn: SpawnFn = () => {
			writeReportFor(absSrc);
			return okSpawnResult();
		};
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		expect(res.error).toBeUndefined();
		const entry = res.perFile.get("src/foo.ts");
		expect(entry).toBeDefined();
		expect(entry?.functions.map((f) => f.name).sort()).toEqual(["covered", "uncovered"]);
		const covered = entry?.functions.find((f) => f.name === "covered");
		const uncovered = entry?.functions.find((f) => f.name === "uncovered");
		expect(covered?.hits).toBe(5);
		expect(uncovered?.hits).toBe(0);
	});

	it("measures suiteMs as wall-clock (> 0 with an injected delay)", async () => {
		const { spawn } = makeStubSpawn({ coverageDir, writeReport: false, delayMs: 20 });
		// Write a valid report so the run succeeds; the delay is in the spawn.
		const wrappingSpawn: SpawnFn = (cmd, args, optsArg) => {
			const r = spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		expect(res.suiteMs).toBeGreaterThan(0);
	});

	it("returns ok:false + error when the spawn fails (ENOENT)", async () => {
		const { spawn } = makeStubSpawn({
			extra: {
				error: Object.assign(new Error("spawn vitest ENOENT"), { code: "ENOENT" }),
			},
		});
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not found|did not run/i);
		expect(res.perFile.size).toBe(0);
	});

	it("returns ok:false + error when the report is missing", async () => {
		// Spawn "succeeds" but writes nothing → no coverage-final.json.
		const { spawn } = makeStubSpawn({ writeReport: false });
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/no parseable coverage/i);
		expect(res.perFile.size).toBe(0);
	});

	it("returns ok:false + error when the spawn throws", async () => {
		const spawn: SpawnFn = () => {
			throw new Error("boom");
		};
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/spawn threw: boom/);
	});

	it("uses the default vitest command when none is supplied", async () => {
		const { spawn, calls } = makeStubSpawn({ coverageDir, writeReport: false });
		const wrappingSpawn: SpawnFn = (cmd, args, optsArg) => {
			const r = spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		await runner.run(baseOpts());

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("vitest");
		expect(calls[0]?.args).toEqual(defaultJsTestCommand(coverageDir).slice(1));
		expect(calls[0]?.args.join(" ")).toContain(`--coverage.reportsDirectory=${coverageDir}`);
	});

	it("honors an explicit testCommand override", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = (cmd, args, optsArg) => {
			const r = spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		await runner.run({ ...baseOpts(), testCommand: ["my-runner", "--cov"] });

		expect(calls[0]?.command).toBe("my-runner");
		expect(calls[0]?.args).toEqual(["--cov"]);
	});
});

// ==================================================================
// PythonCoverageRunner — honest stub, never silently passes
// ==================================================================

describe("PythonCoverageRunner", () => {
	it("returns ok:false with a 'not yet wired' reason even when the suite runs", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not yet wired/i);
		expect(res.perFile.size).toBe(0);
		// It DID exercise/time the suite command.
		expect(calls[0]?.command).toBe("pytest");
		expect(defaultPythonTestCommand()).toEqual(["pytest", "--cov", "--cov-report=json"]);
	});

	it("includes the spawn failure AND the not-yet-wired reason on ENOENT", async () => {
		const { spawn } = makeStubSpawn({
			extra: { error: Object.assign(new Error("nope"), { code: "ENOENT" }) },
		});
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not found|did not run/i);
		expect(res.error).toMatch(/not yet wired/i);
	});
});

// ==================================================================
// Factory
// ==================================================================

describe("coverageRunnerFor", () => {
	it("returns a JsCoverageRunner for js and ts", () => {
		expect(coverageRunnerFor("js")).toBeInstanceOf(JsCoverageRunner);
		expect(coverageRunnerFor("ts")).toBeInstanceOf(JsCoverageRunner);
	});

	it("returns the PythonCoverageRunner stub for python", () => {
		expect(coverageRunnerFor("python")).toBeInstanceOf(PythonCoverageRunner);
	});

	it("forwards an injected spawn into the runner", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const runner = coverageRunnerFor("python", spawn);
		expect(runner).not.toBeNull();
		await runner?.run(baseOpts());
		expect(calls).toHaveLength(1);
	});
});
