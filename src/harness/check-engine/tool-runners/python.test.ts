// Behavioral unit tests for the Python tool runners (mypy + ruff, sync + async).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `mypy` / `ruff` binary:
//   • node:child_process `spawnSync` — drives the sync runners.
//   • ../spawn-async.js `runProcessAsync` — drives the async runners.
// The real parsers (parseMypyOutput / parseRuffJson) run unmocked, so we
// exercise the actual text/JSON → CheckResult[] mapping rather than asserting
// against a stubbed parser.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "../spawn-async.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn();
const runProcessAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: unknown[]) => runProcessAsyncMock(...args),
}));

// Imported after the mocks are registered.
const { runMypy, runRuff, runMypyAsync, runRuffAsync } = await import("./python.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/app/models.py`;

// ---------------------------------------------------------------------------
// Tool output fixtures (real shapes the parsers consume).
// ---------------------------------------------------------------------------

/** mypy line-oriented output: one error (with code) + one warning + one note. */
function mypyOutput(): string {
	return [
		`${TARGET}:12: error: Incompatible return value type (got "int", expected "str")  [return-value]`,
		`${TARGET}:30: warning: Returning Any from function declared to return "int"  [no-any-return]`,
		`${TARGET}:5: note: See https://example.test for more info`,
	].join("\n");
}

/** ruff JSON array: two findings for the target file. */
function ruffJson(): string {
	return JSON.stringify([
		{
			filename: TARGET,
			row: 7,
			column: 4,
			code: "F401",
			message: "`os` imported but unused",
		},
		{
			filename: TARGET,
			row: 19,
			column: 1,
			code: "E711",
			message: "Comparison to `None` should be `cond is None`",
		},
	]);
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** A minimal SpawnSyncReturns. `stdout`/`stderr`/`status` are widened so we
 *  can exercise the runner's `|| ""` and status-branch fallbacks. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	return {
		pid: 123,
		output: [],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
		...over,
	} as SpawnSyncReturns<string>;
}

function procResult(over: Partial<RunProcessResult>): RunProcessResult {
	return {
		stdout: "",
		stderr: "",
		code: null,
		timedOut: false,
		killed: false,
		...over,
	};
}

const enoent = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });

beforeEach(() => {
	spawnSyncMock.mockReset();
	runProcessAsyncMock.mockReset();
});

// ===========================================================================
// runMypy (sync)
// ===========================================================================

describe("runMypy (sync)", () => {
	it("invokes mypy with summary/color flags + targetFile in file mode, cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runMypy(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("mypy");
		expect(args).toEqual(["--no-error-summary", "--no-color-output", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runMypy(input(fileScope({ mode: "project" })));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		runMypy(input(scope));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("returns [] when mypy is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean) even if stdout has content", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: mypyOutput() }));
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("parses error + warning (skipping notes) from stdout on status === 1", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: mypyOutput() }));
		const out = runMypy(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "mypy",
				severity: "error",
				file: TARGET,
				line: 12,
				message: 'Incompatible return value type (got "int", expected "str")',
				ruleId: "return-value",
			},
			{
				tool: "mypy",
				severity: "warning",
				file: TARGET,
				line: 30,
				message: 'Returning Any from function declared to return "int"',
				ruleId: "no-any-return",
			},
		]);
	});

	it("reads diagnostics from stderr too (stdout+stderr concat path)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "", stderr: mypyOutput() }));
		const out = runMypy(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]?.ruleId).toBe("return-value");
	});

	it("returns [] on non-zero status with both streams undefined (|| '' fallbacks)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined, stderr: undefined }));
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runMypy(input(fileScope()))).toEqual([]);
	});

	it("treats a non-ENOENT spawn error as a real (non-zero) run and parses output", () => {
		// error set but code !== ENOENT → not short-circuited; status 1 → parse.
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: mypyOutput(),
				error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
			}),
		);
		expect(runMypy(input(fileScope()))).toHaveLength(2);
	});
});

// ===========================================================================
// runRuff (sync)
// ===========================================================================

describe("runRuff (sync)", () => {
	it("invokes ruff check with json output + targetFile in file mode, cwd/timeout/pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRuff(input(fileScope(), 8_888));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("ruff");
		expect(args).toEqual(["check", "--output-format=json", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 8_888,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("targets '.' in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRuff(input(fileScope({ mode: "project" })));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["check", "--output-format=json", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		runRuff(input(scope));
		const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["check", "--output-format=json", "."]);
	});

	it("returns [] when ruff is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean) even if stdout has content", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: ruffJson() }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("parses findings (all severity warning, code: message, column) on status === 1", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: ruffJson() }));
		const out = runRuff(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "ruff",
				severity: "warning",
				file: TARGET,
				line: 7,
				column: 4,
				message: "F401: `os` imported but unused",
				ruleId: "F401",
			},
			{
				tool: "ruff",
				severity: "warning",
				file: TARGET,
				line: 19,
				column: 1,
				message: "E711: Comparison to `None` should be `cond is None`",
				ruleId: "E711",
			},
		]);
	});

	it("returns [] on status === 1 with empty stdout (the !output guard, pre-parse)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "" }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] on status === 1 with whitespace-only stdout (trim → '' guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "   \n  " }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] on status === 1 with undefined stdout (the '' fallback then guard)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] when ruff emits non-array JSON (parser guard, via status 1)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: JSON.stringify({ not: "an array" }) }),
		);
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] when ruff emits non-JSON garbage (parser catch, via status 1)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "not json {{{" }));
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("kaboom");
		});
		expect(runRuff(input(fileScope()))).toEqual([]);
	});

	it("treats a non-ENOENT spawn error as a real (non-zero) run and parses output", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: ruffJson(),
				error: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
			}),
		);
		expect(runRuff(input(fileScope()))).toHaveLength(2);
	});
});

// ===========================================================================
// runMypyAsync
// ===========================================================================

describe("runMypyAsync", () => {
	it("invokes runProcessAsync with summary/color flags + targetFile in file mode, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runMypyAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("mypy");
		expect(args).toEqual(["--no-error-summary", "--no-color-output", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("targets '.' in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runMypyAsync(input(fileScope({ mode: "project" })));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		await runMypyAsync(input(scope));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["--no-error-summary", "--no-color-output", "."]);
	});

	it("returns [] when code === null (process never started, e.g. ENOENT)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: mypyOutput() }));
		expect(await runMypyAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (clean) even with stdout content", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: mypyOutput() }));
		expect(await runMypyAsync(input(fileScope()))).toEqual([]);
	});

	it("parses error + warning from stdout on a non-zero code", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: mypyOutput() }));
		const out = await runMypyAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "mypy", severity: "error", line: 12, ruleId: "return-value" });
		expect(out[1]).toMatchObject({ severity: "warning", line: 30, ruleId: "no-any-return" });
	});

	it("reads diagnostics from stderr too (stdout+stderr concat path)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "", stderr: mypyOutput() }));
		expect(await runMypyAsync(input(fileScope()))).toHaveLength(2);
	});

	it("returns [] on a non-zero code with empty streams (parser yields nothing)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: "", stderr: "" }));
		expect(await runMypyAsync(input(fileScope()))).toEqual([]);
	});
});

// ===========================================================================
// runRuffAsync
// ===========================================================================

describe("runRuffAsync", () => {
	it("invokes runProcessAsync with json output + targetFile in file mode, cwd/timeout", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runRuffAsync(input(fileScope(), 1_234));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = runProcessAsyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("ruff");
		expect(args).toEqual(["check", "--output-format=json", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 1_234 });
	});

	it("targets '.' in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runRuffAsync(input(fileScope({ mode: "project" })));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["check", "--output-format=json", "."]);
	});

	it("targets '.' when file mode but targetFile is missing", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		await runRuffAsync(input(scope));
		const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(["check", "--output-format=json", "."]);
	});

	it("returns [] when code === null (process never started, e.g. ENOENT)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null, stdout: ruffJson() }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when code === 0 (clean) even with stdout content", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: ruffJson() }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("parses findings on a non-zero code", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: ruffJson() }));
		const out = await runRuffAsync(input(fileScope()));
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ tool: "ruff", severity: "warning", ruleId: "F401", column: 4 });
		expect(out[1]).toMatchObject({ ruleId: "E711", line: 19 });
	});

	it("returns [] on a non-zero code with empty stdout (the !output guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "" }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a non-zero code with whitespace-only stdout (trim → '' guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: "  \n  " }));
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});

	it("returns [] when ruff emits non-array JSON on a non-zero code (parser guard)", async () => {
		runProcessAsyncMock.mockResolvedValue(
			procResult({ code: 1, stdout: JSON.stringify({ not: "array" }) }),
		);
		expect(await runRuffAsync(input(fileScope()))).toEqual([]);
	});
});
