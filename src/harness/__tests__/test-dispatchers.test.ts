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
import { getProfileForFile } from "../language-profiles.js";
import { TEST_DISPATCHERS } from "../quality-checks/test-dispatchers.js";

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
		expect(out[0].name).toBe("affected_tests");
		expect(out[0].file).toBe(filePath);
		expect(out[0].message).toContain("pytest");
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
		expect(out[0].message).toContain("cargo test");
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
		const args = spawnSyncMock.mock.calls[0][1] as string[];
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
		expect(out[0].file).toBe(filePath);
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
		expect(out[0].message).toContain("vitest --related");
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
});
