import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process BEFORE importing the dispatchers — the dispatchers call
// spawnSync at module scope resolution, so mocking after import is too late.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));
// Mock existsSync so runPytestDispatcher's candidate lookup deterministically
// finds (or doesn't find) a test file regardless of the host filesystem.
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

import { spawnSync as mockedSpawnSync } from "node:child_process";
import { existsSync as mockedExistsSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { getProfileForFile } from "../language-profiles.js";
import {
	TEST_DISPATCHERS,
} from "../quality-checks/test-dispatchers.js";

const spawnSyncMock = vi.mocked(mockedSpawnSync);
const existsSyncMock = vi.mocked(mockedExistsSync);

function mkSpawnResult(opts: {
	status?: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException;
}): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, opts.stdout ?? "", opts.stderr ?? ""],
		stdout: opts.stdout ?? "",
		stderr: opts.stderr ?? "",
		status: opts.status === undefined ? 0 : opts.status,
		signal: null,
		...(opts.error ? { error: opts.error } : {}),
	} as SpawnSyncReturns<string>;
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	existsSyncMock.mockReset();
	existsSyncMock.mockReturnValue(false);
});

describe("TEST_DISPATCHERS — registry", () => {
	it("registers typescript, python, rust, go", () => {
		expect(TEST_DISPATCHERS.typescript).toBeDefined();
		expect(TEST_DISPATCHERS.python).toBeDefined();
		expect(TEST_DISPATCHERS.rust).toBeDefined();
		expect(TEST_DISPATCHERS.go).toBeDefined();
	});

	it("does NOT register swift, java, c_cpp (silent-skip for now)", () => {
		expect(TEST_DISPATCHERS.swift).toBeUndefined();
		expect(TEST_DISPATCHERS.java).toBeUndefined();
		expect(TEST_DISPATCHERS.c_cpp).toBeUndefined();
	});
});

describe("runPytestDispatcher", () => {
	const filePath = "/repo/src/m.py";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("python profile missing");
	const dispatcher = TEST_DISPATCHERS.python;
	if (!dispatcher) throw new Error("python dispatcher not registered");

	it("returns empty when no test-candidate file exists", () => {
		existsSyncMock.mockReturnValue(false);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("skips silently when pytest binary missing (ENOENT)", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException,
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("skips an errored pytest process even when the status is nonzero", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException,
			}),
		);
		const out = dispatcher({
			filePath: "/repo/src/pytest-enoent.py",
			absPath: "/repo/src/pytest-enoent.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("classifies ImportError as pre-existing (no result)", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 2,
				stdout: "",
				stderr: "ImportError: cannot import name 'foo' from 'bar'",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports an edit-introduced failure", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "FAILED tests/test_m.py::test_adds - AssertionError: 1 != 2",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).name).toBe("affected_tests");
		expect(nonNull(out[0]).file).toBe(filePath);
		expect(nonNull(out[0]).message).toContain("pytest");
	});

	it("uses the exact pytest command and spawn options", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath: "/repo/src/command.py",
			absPath: "/repo/src/command.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 4321,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"python",
			["-m", "pytest", "-x", "--tb=short", "-q", "src/test_command.py"],
			{
				shell: false,
				timeout: 4321,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("treats a null pytest status without an error as a silent skip", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: null }));
		const out = dispatcher({
			filePath: "/repo/src/pytest-null.py",
			absPath: "/repo/src/pytest-null.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("keeps pytest-failure baselines distinct for different candidate files", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: "AssertionError: pytest baseline" }),
		);
		const run = (name: string) =>
			dispatcher({
				filePath: `/repo/src/${name}.py`,
				absPath: `/repo/src/${name}.py`,
				profile,
				checkCwd: "/repo",
				timeoutMs: 5000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(run("pytest-baseline-a")).toHaveLength(1);
		expect(run("pytest-baseline-b")).toHaveLength(1);
	});
});

describe("runCargoTestDispatcher", () => {
	const filePath = "/repo/src/lib.rs";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("rust profile missing");
	const dispatcher = TEST_DISPATCHERS.rust;
	if (!dispatcher) throw new Error("rust dispatcher not registered");

	it("classifies unresolved import as pre-existing", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 101,
				stdout: "",
				stderr: "error[E0432]: unresolved import `foo`",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports compile error from cargo test --no-run", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 101,
				stdout: "",
				stderr: "error[E0308]: mismatched types: expected `u32`, found `&str`",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("cargo test");
	});

	it("skips silently when cargo missing (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException,
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("skips an errored cargo process even when the status is nonzero", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException,
			}),
		);
		const out = dispatcher({
			filePath: "/repo/src/cargo-enoent.rs",
			absPath: "/repo/src/cargo-enoent.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("passes --no-run flag", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"cargo",
			["test", "--no-run", "--message-format=short"],
			{
				shell: false,
				timeout: 15000,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("treats a null cargo status without an error as a silent skip", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: null }));
		const out = dispatcher({
			filePath: "/repo/src/cargo-null.rs",
			absPath: "/repo/src/cargo-null.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("keeps cargo-failure baselines distinct for different project roots", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 101, stderr: "error[E0308]: baseline mismatch" }),
		);
		const run = (root: string) =>
			dispatcher({
				filePath: `${root}/src/lib.rs`,
				absPath: `${root}/src/lib.rs`,
				profile,
				checkCwd: root,
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(run("/repo/cargo-baseline-a")).toHaveLength(1);
		expect(run("/repo/cargo-baseline-b")).toHaveLength(1);
	});
});

describe("runGoTestDispatcher", () => {
	const filePath = "/repo/src/pkg/m.go";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("go profile missing");
	const dispatcher = TEST_DISPATCHERS.go;
	if (!dispatcher) throw new Error("go dispatcher not registered");

	it("scopes `go test` to the package directory, not project-wide", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		const args = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		expect(args[0]).toBe("test");
		// Scopes to ./src/pkg — NOT ./... — so unrelated failing packages
		// don't drown the agent in noise unrelated to the current edit.
		expect(args).toContain("./src/pkg");
		expect(args).not.toContain("./...");
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"go",
			["test", "-count=1", "./src/pkg"],
			{
				shell: false,
				timeout: 15000,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("skips an errored go process even when the status is nonzero", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException,
			}),
		);
		const out = dispatcher({
			filePath: "/repo/src/pkg/go-enoent.go",
			absPath: "/repo/src/pkg/go-enoent.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("classifies `cannot find package` as pre-existing", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "",
				stderr: "cannot find package foo/bar in /go/src/foo/bar",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("reports a genuine test failure", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout:
					"--- FAIL: TestAdd (0.00s)\n    m_test.go:12: expected 2, got 1\nFAIL\n",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(filePath);
		expect(nonNull(out[0]).message).toBe("Tests failed for /repo/src/pkg/m.go (go test ./src/pkg)");
	});
});

describe("runVitestDispatcher", () => {
	const filePath = "/repo/src/m.ts";
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error("typescript profile missing");
	const dispatcher = TEST_DISPATCHERS.typescript;
	if (!dispatcher) throw new Error("typescript dispatcher not registered");

	it("reports edit-introduced vitest --related failures", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "FAIL  src/m.test.ts > adds two\n  AssertionError: expected 2 to be 3",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("vitest --related");
	});

	it("classifies Cannot find module as pre-existing", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "Error: Cannot find module '@/foo'",
			}),
		);
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("returns empty (no result) when vitest --related exits 0", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "PASS" }));
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/ok-pass.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		// --related succeeded → convention fallback must NOT run (one spawn only).
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const firstArgs = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		expect(firstArgs).toContain("--related");
	});

	it("invokes vitest --related against the absolute edited path", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath: "src/m.ts",
			absPath: "/repo/src/widget.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "warning",
			checkName: "affected_tests",
		});
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run", "--related", "/repo/src/widget.ts", "--reporter=verbose"],
			{
				shell: false,
				timeout: 15000,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("does not use the convention fallback after a related pass", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "PASS" }));
		const out = dispatcher({
			filePath: "src/related-pass.ts",
			absPath: "/repo/src/related-pass.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("falls back when a related run returns null status without an error", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(mkSpawnResult({ status: null }))
			.mockReturnValueOnce(mkSpawnResult({ status: 0, stdout: "PASS" }));
		const out = dispatcher({
			filePath: "src/related-null.ts",
			absPath: "/repo/src/related-null.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("defaults to 'npx vitest run' when the profile declares no test_runner", () => {
		// test_runner === null → runnerCmd falls back to the literal default,
		// which still contains "vitest" so the dispatcher proceeds.
		const noRunner: typeof profile = { ...profile, test_runner: null };
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			// related → unknown option, fall through to convention
			.mockReturnValueOnce(
				mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
			)
			// convention runner (the fallback default) → failure
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					stdout: "FAIL src/dflt.test.ts > t\n  AssertionError: bad",
				}),
			);
		const out = dispatcher({
			filePath: "src/dflt.ts",
			absPath: "/repo/src/dflt.ts",
			profile: noRunner,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		// Convention runner was spawned via the default "npx vitest run" parts.
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		expect(nonNull(spawnSyncMock.mock.calls[1])[0]).toBe("npx");
	});

	it("uses the absolute test path verbatim when the candidate is outside checkCwd", () => {
		// absPath lives outside checkCwd → the discovered test file does NOT
		// start with checkCwd → relTest keeps the full absolute path (else branch).
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(
				mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
			)
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					stdout: "FAIL /outside/proj/m.test.ts\n  AssertionError: nope",
				}),
			);
		const out = dispatcher({
			filePath: "m.ts",
			absPath: "/outside/proj/m.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		// The convention runner received the full absolute test path (not sliced).
		const convArgs = nonNull(spawnSyncMock.mock.calls[1])[1] as string[];
		expect(convArgs.some((a) => a === "/outside/proj/m.test.ts")).toBe(true);
		// And the message embeds that absolute path.
		expect(nonNull(out[0]).message).toContain("/outside/proj/m.test.ts");
	});

	it("returns empty when profile test_runner is not vitest", () => {
		const nonVitest: typeof profile = {
			...profile,
			test_runner: {
				command: "jest",
				timeout_ms: 5000,
				severity: "error",
				description: "non-vitest runner",
			},
		};
		const out = dispatcher({
			filePath,
			absPath: "/repo/src/m.ts",
			profile: nonVitest,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		// Bailed before any spawn.
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("falls back to convention runner when --related reports unknown option", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			// 1) vitest --related → unsupported flag (older vitest)
			.mockReturnValueOnce(
				mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
			)
			// 2) convention runner → genuine failure
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					stdout: "FAIL src/conv.test.ts > x\n  AssertionError: expected 1 to be 2",
				}),
			);
		const out = dispatcher({
			filePath: "src/conv.ts",
			absPath: "/repo/src/conv.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		// Convention message embeds the discovered relative test path, NOT
		// the "vitest --related" wording.
		expect(nonNull(out[0]).message).toContain("src/conv.test.ts");
		expect(nonNull(out[0]).message).not.toContain("--related");
		// Convention runner invoked with the profile command head ("npx").
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		const convArgs = nonNull(spawnSyncMock.mock.calls[1])[1] as string[];
		expect(convArgs).toContain("--reporter=verbose");
		expect(convArgs.some((a) => a.endsWith("conv.test.ts"))).toBe(true);
	});

	it("normalizes the convention command and test path exactly", () => {
		existsSyncMock.mockReturnValue(true);
		const spacedProfile: typeof profile = {
			...profile,
			test_runner: {
				command: "  npx   vitest   run  ",
				timeout_ms: 5000,
				severity: "error",
				description: "spaced command",
			},
		};
		spawnSyncMock
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stderr: "unknown option --related" }))
			.mockReturnValueOnce(mkSpawnResult({ status: 0, stdout: "PASS" }));
		dispatcher({
			filePath: "src/space.ts",
			absPath: "/repo/src/space.ts",
			profile: spacedProfile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(spawnSyncMock.mock.calls).toContainEqual([
			"npx",
			["vitest", "run", "src/space.test.ts", "--reporter=verbose"],
			{
				shell: false,
				timeout: 15000,
				cwd: "/repo",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		]);
	});

	it("falls back to convention runner when --related errors (spawn error)", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(
				mkSpawnResult({
					status: null,
					error: Object.assign(new Error("EPIPE"), {
						code: "EPIPE",
					}) as NodeJS.ErrnoException,
				}),
			)
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					stdout: "FAIL src/err.test.ts\n  AssertionError",
				}),
			);
		const out = dispatcher({
			filePath: "src/err.ts",
			absPath: "/repo/src/err.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("src/err.test.ts");
	});

	it("convention fallback skips silently when the runner binary is missing (ENOENT)", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			// related: "unknown option" → older vitest → fall through to convention
			.mockReturnValueOnce(
				mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
			)
			// convention: ENOENT
			.mockReturnValueOnce(
				mkSpawnResult({
					status: null,
					error: Object.assign(new Error("ENOENT"), {
						code: "ENOENT",
					}) as NodeJS.ErrnoException,
				}),
			);
		const out = dispatcher({
			filePath: "src/missing-runner.ts",
			absPath: "/repo/src/missing-runner.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("skips an errored convention runner even when the status is nonzero", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stderr: "unknown option --related" }))
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					error: Object.assign(new Error("ENOENT"), {
						code: "ENOENT",
					}) as NodeJS.ErrnoException,
				}),
			);
		const out = dispatcher({
			filePath: "src/conv-enoent.ts",
			absPath: "/repo/src/conv-enoent.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("convention fallback returns empty when the convention test passes (status 0)", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(
				mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
			)
			.mockReturnValueOnce(mkSpawnResult({ status: 0, stdout: "PASS" }));
		const out = dispatcher({
			filePath: "src/conv-pass.ts",
			absPath: "/repo/src/conv-pass.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		// Convention runner WAS reached (two spawns), and a clean pass yields no
		// finding.
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("trims each output stream and preserves an empty combined output", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "  AssertionError: trimmed  ",
				stderr: "  stderr-trimmed  ",
			}),
		);
		const trimmed = dispatcher({
			filePath: "src/trimmed-output.ts",
			absPath: "/repo/src/trimmed-output.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(trimmed).toHaveLength(1);
		expect(nonNull(trimmed[0]).detail).toBe(
			"stderr-trimmed\nAssertionError: trimmed",
		);

		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 1 }));
		const empty = dispatcher({
			filePath: "src/empty-output.ts",
			absPath: "/repo/src/empty-output.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(empty).toHaveLength(1);
		expect(nonNull(empty[0]).detail).toBe("");
	});

	it("keeps related-failure baselines distinct for different edited files", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: "AssertionError: distinct baseline" }),
		);
		const run = (absPath: string) =>
			dispatcher({
				filePath: absPath,
				absPath,
				profile,
				checkCwd: "/repo",
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(run("/repo/src/baseline-a.ts")).toHaveLength(1);
		expect(run("/repo/src/baseline-b.ts")).toHaveLength(1);
	});

	it("keeps convention-failure baselines distinct for different test files", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stderr: "unknown option --related" }))
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stdout: "AssertionError: convention baseline" }))
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stderr: "unknown option --related" }))
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stdout: "AssertionError: convention baseline" }));
		const run = (name: string) =>
			dispatcher({
				filePath: `src/${name}.ts`,
				absPath: `/repo/src/${name}.ts`,
				profile,
				checkCwd: "/repo",
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(run("convention-baseline-a")).toHaveLength(1);
		expect(run("convention-baseline-b")).toHaveLength(1);
	});

	it("convention fallback classifies module-resolution failure as pre-existing", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(
				mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
			)
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					stdout: "Error: Cannot find module '@/preexisting'",
				}),
			);
		const out = dispatcher({
			filePath: "src/conv-pre.ts",
			absPath: "/repo/src/conv-pre.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		// Convention runner ran (2 spawns) but the failure was classified
		// pre-existing → suppressed.
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("convention fallback returns empty when NO test-candidate file exists", () => {
		// related falls through (unknown option) but existsSync finds nothing →
		// convention runner is never spawned (testFile is undefined).
		existsSyncMock.mockReturnValue(false);
		spawnSyncMock.mockReturnValueOnce(
			mkSpawnResult({ status: 1, stderr: "error: unknown option '--related'" }),
		);
		const out = dispatcher({
			filePath: "src/no-test.ts",
			absPath: "/repo/src/no-test.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
		// Only the --related probe ran; no convention runner spawn.
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("emits a related-failure detail tail combining stderr THEN stdout", () => {
		// combinedOutput: when both streams are present, stderr precedes stdout.
		const stderr = "stderr-line-A";
		const stdout = "FAIL src/m.test.ts > t\n  AssertionError: nope";
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout, stderr }),
		);
		const out = dispatcher({
			filePath: "src/combined.ts",
			absPath: "/repo/src/combined.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		const detail = nonNull(out[0]).detail;
		expect(detail).toContain("stderr-line-A");
		expect(detail).toContain("AssertionError: nope");
		// stderr appears before the stdout assertion line in the combined output.
		expect(detail.indexOf("stderr-line-A")).toBeLessThan(
			detail.indexOf("AssertionError: nope"),
		);
	});

	it("truncates a long failure detail to the last 8 lines", () => {
		const longBody = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
		// Last line carries a genuine-failure marker so it isn't classified
		// pre-existing.
		const stdout = `${longBody}\nAssertionError: boom`;
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 1, stdout }));
		const out = dispatcher({
			filePath: "src/long.ts",
			absPath: "/repo/src/long.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		const lines = nonNull(out[0]).detail.split("\n");
		expect(lines).toHaveLength(8);
		// Early lines dropped, tail retained.
		expect(nonNull(out[0]).detail).not.toContain("line-0");
		expect(nonNull(out[0]).detail).toContain("AssertionError: boom");
	});
});

describe("runGoTestDispatcher — path scoping branches", () => {
	const profile = getProfileForFile("/repo/m.go");
	if (!profile) throw new Error("go profile missing");
	const dispatcher = TEST_DISPATCHERS.go;
	if (!dispatcher) throw new Error("go dispatcher not registered");

	it("uses '.' as the package arg when the file sits in the project root", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath: "m.go",
			absPath: "/repo/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		// relative("/repo","/repo") === "" → falls back to "."
		expect(args).toContain(".");
		expect(args).toEqual(["test", "-count=1", "."]);
	});

	it("prefixes a non-dot package path with ./ and forward slashes", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath: "internal/svc/m.go",
			absPath: "/repo/internal/svc/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		expect(args).toContain("./internal/svc");
	});

	it("keeps a parent-relative ('..') package path as-is (no extra ./ prefix)", () => {
		// pkgDir resolves OUTSIDE checkCwd → relative() starts with ".." →
		// the `relPkg.startsWith(".")` branch keeps it verbatim.
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath: "../sibling/m.go",
			absPath: "/repo/sibling/m.go",
			profile,
			checkCwd: "/repo/app",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		const pkgArg = args[2];
		expect(nonNull(pkgArg).startsWith("..")).toBe(true);
		expect(nonNull(pkgArg).startsWith("./..")).toBe(false);
	});

	it("classifies a generic build failure (undefined symbol) as pre-existing", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 2,
				stderr: "build failed: ./m.go:3:5: undefined: helperFn",
			}),
		);
		const out = dispatcher({
			filePath: "pkg/m.go",
			absPath: "/repo/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("skips silently when the go binary is missing (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: null,
				error: Object.assign(new Error("ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException,
			}),
		);
		const out = dispatcher({
			filePath: "pkg/m.go",
			absPath: "/repo/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("returns empty when go test passes (status 0)", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "ok\t./pkg\t0.01s" }));
		const out = dispatcher({
			filePath: "pkg/m.go",
			absPath: "/repo/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("treats a null go status without an error as a silent skip", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: null }));
		const out = dispatcher({
			filePath: "/repo/src/pkg/go-null.go",
			absPath: "/repo/src/pkg/go-null.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("keeps go-failure baselines distinct for different package paths", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: "--- FAIL: TestBaseline\nFAIL" }),
		);
		const run = (pkg: string) =>
			dispatcher({
				filePath: `/repo/src/${pkg}/m.go`,
				absPath: `/repo/src/${pkg}/m.go`,
				profile,
				checkCwd: "/repo",
				timeoutMs: 15000,
				severity: "error",
				checkName: "affected_tests",
			});
		expect(run("go-baseline-a")).toHaveLength(1);
		expect(run("go-baseline-b")).toHaveLength(1);
	});
});

describe("test-candidate path construction", () => {
	it("derives Python candidates from the extension, directory, and basename", () => {
		const filePath = "/repo/src/candidate.py";
		const profile = getProfileForFile(filePath);
		if (!profile) throw new Error("python profile missing");
		const dispatcher = TEST_DISPATCHERS.python;
		if (!dispatcher) throw new Error("python dispatcher not registered");
		const seen: string[] = [];
		existsSyncMock.mockImplementation((candidate) => {
			seen.push(String(candidate));
			return false;
		});
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath,
			absPath: filePath,
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(seen).toEqual([
			"/repo/src/test_candidate.py",
			"/repo/src/candidate_test.py",
			"/repo/src/tests/test_candidate.py",
			"/repo/tests/test_candidate.py",
			"/repo/src/candidate.test.py",
			"/repo/src/candidate.spec.py",
			"/repo/src/__tests__/candidate.test.py",
			"/repo/src/__tests__/candidate.spec.py",
		]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

describe("runPytestDispatcher — additional branches", () => {
	const profile = getProfileForFile("/repo/src/m.py");
	if (!profile) throw new Error("python profile missing");
	const dispatcher = TEST_DISPATCHERS.python;
	if (!dispatcher) throw new Error("python dispatcher not registered");

	it("returns empty when pytest passes (status 0)", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0, stdout: "1 passed" }));
		const out = dispatcher({
			filePath: "/repo/src/pass.py",
			absPath: "/repo/src/pass.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([]);
	});

	it("emits the configured severity (warning) on a genuine failure", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({
				status: 1,
				stdout: "FAILED tests/test_warn.py::t - AssertionError: 1 != 2",
			}),
		);
		const out = dispatcher({
			filePath: "/repo/src/warn.py",
			absPath: "/repo/src/warn.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "warning",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).severity).toBe("warning");
	});

	it("relativizes the test path against checkCwd in the pytest invocation", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath: "src/rel.py",
			absPath: "/repo/src/rel.py",
			profile,
			checkCwd: "/repo",
			timeoutMs: 5000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		// First existing candidate for src/rel.py is the sibling test_rel.py.
		const relArg = args[args.length - 1];
		expect(nonNull(relArg).startsWith("/")).toBe(false);
		expect(relArg).toContain("rel");
	});
});

describe("dispatcher survivor contracts", () => {
	const profile = getProfileForFile("/repo/src/stream.ts");
	if (!profile) throw new Error("typescript profile missing");
	const dispatcher = TEST_DISPATCHERS.typescript;
	if (!dispatcher) throw new Error("typescript dispatcher not registered");

	// test-contract: public-api — the exported language registry routes every supported language to its documented dispatcher
	it("keeps every supported language entry available through the public registry", () => {
		expect(Object.keys(TEST_DISPATCHERS).sort()).toEqual([
			"go",
			"python",
			"rust",
			"typescript",
		]);
	});

	// test-contract: invariant — failure details trim a single non-empty stream without adding a phantom second stream
	it("preserves a trimmed stderr-only failure detail", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stderr: "  stderr-only failure  " }),
		);
		const out = dispatcher({
			filePath: "src/stderr-only.ts",
			absPath: "/repo/src/stderr-only.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).detail).toBe("stderr-only failure");
	});

	// test-contract: boundary — an empty stdout stream must not become synthetic output when stderr is the only failure evidence
	it("does not synthesize output for an empty stdout stream", () => {
		spawnSyncMock.mockReturnValue(
			mkSpawnResult({ status: 1, stdout: "", stderr: "real stderr" }),
		);
		const out = dispatcher({
			filePath: "src/empty-stdout.ts",
			absPath: "/repo/src/empty-stdout.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).detail).toBe("real stderr");
	});

	// test-contract: boundary — a non-ENOENT spawn error remains an actionable test failure instead of being silently skipped
	it("reports a convention failure when the runner returns a non-ENOENT process error", () => {
		existsSyncMock.mockReturnValue(true);
		spawnSyncMock
			.mockReturnValueOnce(mkSpawnResult({ status: 1, stderr: "unknown option --related" }))
			.mockReturnValueOnce(
				mkSpawnResult({
					status: 1,
					stdout: "AssertionError: runner pipe failed",
					error: Object.assign(new Error("EPIPE"), {
						code: "EPIPE",
					}) as NodeJS.ErrnoException,
				}),
			);
		const out = dispatcher({
			filePath: "src/epipe.ts",
			absPath: "/repo/src/epipe.ts",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).detail).toContain("runner pipe failed");
	});
});
