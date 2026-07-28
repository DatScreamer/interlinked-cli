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
	__test_only__,
	TEST_DISPATCHERS,
	type TestDispatcherInput,
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
		status: opts.status ?? 0,
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

	it("passes --no-run flag", () => {
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		dispatcher({
			filePath,
			absPath: "/repo/src/lib.rs",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"cargo",
			expect.arrayContaining(["test", "--no-run"]),
			expect.any(Object),
		);
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
		dispatcher({
			filePath,
			absPath: "/repo/src/pkg/m.go",
			profile,
			checkCwd: "/repo",
			timeoutMs: 15000,
			severity: "error",
			checkName: "affected_tests",
		});
		const args = nonNull(spawnSyncMock.mock.calls[0])[1] as string[];
		expect(args[0]).toBe("test");
		// Scopes to ./src/pkg — NOT ./... — so unrelated failing packages
		// don't drown the agent in noise unrelated to the current edit.
		expect(args).toContain("./src/pkg");
		expect(args).not.toContain("./...");
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
			expect.objectContaining({ shell: false, cwd: "/repo" }),
		);
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

describe("__test_only__.relativizeFromRoot", () => {
	const { relativizeFromRoot } = __test_only__;

	it("strips the root prefix and the leading separator", () => {
		expect(relativizeFromRoot("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
	});

	it("strips the root prefix without a trailing separator already on root", () => {
		// root ends without sep; remainder begins with sep → sliced off.
		expect(relativizeFromRoot("/repo/x.ts", "/repo")).toBe("x.ts");
	});

	it("returns the path unchanged when it is not under the root", () => {
		expect(relativizeFromRoot("/other/place/a.ts", "/repo")).toBe(
			"/other/place/a.ts",
		);
	});

	it("keeps the remainder verbatim when no leading separator follows the root", () => {
		// "/repoX" starts with "/repo" but the next char is not a separator,
		// so the remainder ("X/y.ts") is returned without slicing a sep.
		expect(relativizeFromRoot("/repoX/y.ts", "/repo")).toBe("X/y.ts");
	});
});

describe("__test_only__ exposes every dispatcher and the relativizer", () => {
	it("matches the registry dispatchers by reference", () => {
		expect(__test_only__.runVitestDispatcher).toBe(TEST_DISPATCHERS.typescript);
		expect(__test_only__.runPytestDispatcher).toBe(TEST_DISPATCHERS.python);
		expect(__test_only__.runCargoTestDispatcher).toBe(TEST_DISPATCHERS.rust);
		expect(__test_only__.runGoTestDispatcher).toBe(TEST_DISPATCHERS.go);
		expect(typeof __test_only__.relativizeFromRoot).toBe("function");
	});

	it("dispatchers accept a fully-typed TestDispatcherInput", () => {
		// Compile-time + runtime guard that the public input shape is honored.
		const input: TestDispatcherInput = {
			filePath: "src/typed.rs",
			absPath: "/repo/src/typed.rs",
			checkCwd: "/repo",
			profile: getProfileForFile("/repo/src/typed.rs") as NonNullable<
				ReturnType<typeof getProfileForFile>
			>,
			timeoutMs: 1000,
			severity: "error",
			checkName: "affected_tests",
		};
		spawnSyncMock.mockReturnValue(mkSpawnResult({ status: 0 }));
		expect(__test_only__.runCargoTestDispatcher(input)).toEqual([]);
	});
});
