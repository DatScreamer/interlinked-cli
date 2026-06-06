// Behavioral unit tests for the Rust tool runners (cargo check, cargo clippy).
//
// Both runners are synchronous, so the only boundary mocked is
// node:child_process `spawnSync`. The real `parseCargoJson` /
// `filterResultsToFile` parsers run unmocked so we exercise the actual
// NDJSON → CheckResult[] mapping and the file-mode filter branch.
//
// Every branch of both runners is covered:
//   • ENOENT (cargo absent) → []
//   • status === 0 (clean compile) → []
//   • status === 101 (compile errors) → parsed diagnostics
//   • status === null (spawn never started, no .error) → parse path
//   • stdout / stderr `|| ""` fallbacks (one side undefined)
//   • file mode + targetFile + filterToFile → filtered to target
//   • project mode (and partial file-mode triggers) → unfiltered
//   • catch block (spawnSync throws) → []

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResult, CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Imported after the mock is registered.
const { runCargoCheck, runCargoClippy } = await import("./rust.js");

const PROJECT_ROOT = "/work/crate";
const TARGET_FILE = "src/lib.rs";

/**
 * Build one line of cargo's `--message-format=json` NDJSON stream:
 * a `compiler-message` carrying a single span. `parseCargoJson` only
 * emits a CheckResult for lines shaped exactly like this.
 */
function cargoMessageLine(over: {
	level?: string;
	fileName?: string;
	lineStart?: number;
	columnStart?: number;
	message?: string;
	code?: string | null;
}): string {
	const code = over.code === null ? null : { code: over.code ?? "E0308" };
	return JSON.stringify({
		reason: "compiler-message",
		message: {
			level: over.level ?? "error",
			message: over.message ?? "mismatched types",
			code,
			spans: [
				{
					file_name: over.fileName ?? TARGET_FILE,
					line_start: over.lineStart ?? 7,
					column_start: over.columnStart ?? 3,
				},
			],
		},
	});
}

/** A non-compiler-message NDJSON line (e.g. cargo's build progress). */
function nonMessageLine(): string {
	return JSON.stringify({ reason: "compiler-artifact", package_id: "crate 0.1.0" });
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET_FILE,
		filterToFile: true,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Minimal SpawnSyncReturns; `stdout`/`stderr` widened so we can pass
 *  `undefined` to exercise the runners' `|| ""` fallbacks. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	const base = {
		pid: 321,
		output: [] as Array<string | null>,
		stdout: "",
		stderr: "",
		status: null as number | null,
		signal: null as NodeJS.Signals | null,
	};
	return { ...base, ...over } as SpawnSyncReturns<string>;
}

function enoentError(): NodeJS.ErrnoException {
	const e = new Error("spawn cargo ENOENT") as NodeJS.ErrnoException;
	e.code = "ENOENT";
	return e;
}

beforeEach(() => {
	spawnSyncMock.mockReset();
});

// Each runner shares an identical control-flow skeleton, so the suite is
// parametrized over both. `expectedTool` is what the runner stamps onto
// each CheckResult; `expectedArgv` pins the exact cargo invocation.
const runners = [
	{
		name: "runCargoCheck",
		fn: runCargoCheck,
		expectedTool: "cargo-check" as const,
		expectedArgv: ["check", "--message-format=json"],
	},
	{
		name: "runCargoClippy",
		fn: runCargoClippy,
		expectedTool: "cargo-clippy" as const,
		expectedArgv: ["clippy", "--message-format=json", "--", "-W", "clippy::all"],
	},
];

describe.each(runners)("$name", ({ fn, expectedTool, expectedArgv }) => {
	it("invokes cargo with the right argv, cwd, timeout, encoding and pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		fn(input(fileScope(), 8_888));

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("cargo");
		expect(args).toEqual(expectedArgv);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 8_888,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when cargo is absent (error.code === ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoentError() }));
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("returns [] for a non-ENOENT spawn error that still reports status 0", () => {
		// A generic error whose code !== ENOENT does NOT hit the early return;
		// status === 0 then takes over and yields the clean-compile [].
		const e = new Error("EACCES") as NodeJS.ErrnoException;
		e.code = "EACCES";
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, error: e }));
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a clean compile (status === 0) without parsing", () => {
		// stdout carries a would-be diagnostic, but status 0 short-circuits
		// before the parser ever sees it.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 0, stdout: cargoMessageLine({}) }),
		);
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("parses an error diagnostic from stdout on status 101 (file mode, on-target)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: `${nonMessageLine()}\n${cargoMessageLine({
					level: "error",
					message: "mismatched types",
					code: "E0308",
					lineStart: 12,
					columnStart: 5,
				})}\n`,
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: expectedTool,
				severity: "error",
				file: TARGET_FILE,
				line: 12,
				column: 5,
				message: "mismatched types",
				ruleId: "E0308",
			},
		]);
	});

	it("maps a non-error level to severity 'warning'", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({
					level: "warning",
					message: "unused variable: `x`",
					code: "unused_variables",
				}),
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: expectedTool,
			severity: "warning",
			ruleId: "unused_variables",
			message: "unused variable: `x`",
		});
	});

	it("reads diagnostics from stderr when stdout is undefined ('' fallback)", () => {
		// stdout undefined exercises `(result.stdout || "")`; the diagnostic
		// arrives via stderr, exercising the stderr side of the concat.
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: undefined,
				stderr: cargoMessageLine({ message: "borrow checker error", code: "E0502" }),
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0].message).toBe("borrow checker error");
		expect(out[0].ruleId).toBe("E0502");
	});

	it("handles undefined stderr via the '' fallback (stdout-only diagnostic)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({ message: "type error" }),
				stderr: undefined,
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0].message).toBe("type error");
	});

	it("returns [] on status 101 with empty output (parser yields nothing)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 101, stdout: "", stderr: "" }));
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("treats status === null (no error) as non-zero and parses output", () => {
		// Neither ENOENT nor status 0 — falls through to the parse path.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: null, stdout: cargoMessageLine({ message: "killed mid-build" }) }),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0].message).toBe("killed mid-build");
	});

	it("emits ruleId undefined when the diagnostic carries no code", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 101, stdout: cargoMessageLine({ code: null }) }),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0].ruleId).toBeUndefined();
	});

	// --- file-mode filtering branch -----------------------------------------

	it("filters out off-target diagnostics in file mode (filterToFile=true)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: [
					cargoMessageLine({ fileName: "src/other.rs", message: "in other file" }),
					cargoMessageLine({ fileName: TARGET_FILE, message: "in target file" }),
				].join("\n"),
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0].file).toBe(TARGET_FILE);
		expect(out[0].message).toBe("in target file");
	});

	it("matches via endsWith when cargo reports an absolute path for the target", () => {
		// filterResultsToFile keeps results whose file endsWith targetFile.
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({
					fileName: `${PROJECT_ROOT}/${TARGET_FILE}`,
					message: "abs path diag",
				}),
			}),
		);
		const out = fn(input(fileScope({ targetFile: `${PROJECT_ROOT}/${TARGET_FILE}` })));
		expect(out).toHaveLength(1);
		expect(out[0].message).toBe("abs path diag");
	});

	it("does NOT filter in project mode (returns every file's diagnostics)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: [
					cargoMessageLine({ fileName: "src/a.rs", message: "diag a" }),
					cargoMessageLine({ fileName: "src/b.rs", message: "diag b" }),
				].join("\n"),
			}),
		);
		const out = fn(input(fileScope({ mode: "project" })));
		expect(out).toHaveLength(2);
		expect(out.map((r) => r.file)).toEqual(["src/a.rs", "src/b.rs"]);
	});

	it("does NOT filter when filterToFile is absent even in file mode", () => {
		const scope = fileScope();
		delete (scope as { filterToFile?: boolean }).filterToFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: [
					cargoMessageLine({ fileName: "src/x.rs", message: "diag x" }),
					cargoMessageLine({ fileName: TARGET_FILE, message: "diag target" }),
				].join("\n"),
			}),
		);
		const out = fn(input(scope));
		expect(out).toHaveLength(2);
	});

	it("does NOT filter when targetFile is absent even in file mode", () => {
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({ fileName: "src/anywhere.rs", message: "kept" }),
			}),
		);
		const out = fn(input(scope));
		expect(out).toHaveLength(1);
		expect(out[0].file).toBe("src/anywhere.rs");
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(fn(input(fileScope()))).toEqual([]);
	});
});
