// Behavioral unit tests for the tsgo Bash-acceleration helpers.
//
// The single boundary mocked here is node:child_process `spawnSync` — both
// `isTsgoAvailable` (probes `npx tsgo --version`) and `tryTsgoRewrite` (runs
// the rewritten `sh -c` command) go through it, so the mock implementation
// branches on the spawned command to serve the right canned result. Nothing
// real is ever spawned; the tests assert real return values, the `block`
// decision text, the rewrite substitution, and the log side-channel.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Imported after the mock is registered so the module binds the mocked spawnSync.
const { isTsgoAvailable, _resetTsgoAvailabilityCache, isBashTsc, tryTsgoRewrite } = await import(
	"./server-tsgo-bash.js"
);

/** Build a minimal SpawnSyncReturns. `stdout`/`stderr` widened to optional so
 *  we can exercise the `(result.stdout || "")` fallback branches. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...over,
	} as SpawnSyncReturns<string>;
}

/** True when this spawnSync call is the `npx tsgo --version` availability probe. */
function isVersionProbe(args: unknown[]): boolean {
	const [cmd, argv] = args as [string, string[]];
	return cmd === "npx" && Array.isArray(argv) && argv[0] === "tsgo" && argv[1] === "--version";
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	_resetTsgoAvailabilityCache();
});

// ---------------------------------------------------------------------------
// isTsgoAvailable
// ---------------------------------------------------------------------------

describe("isTsgoAvailable", () => {
	it("returns true when `npx tsgo --version` exits 0 with no error, and passes correct args/opts", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		expect(isTsgoAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, argv, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("npx");
		expect(argv).toEqual(["tsgo", "--version"]);
		expect(opts).toMatchObject({
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns false when the probe exits non-zero", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1 }));
		expect(isTsgoAvailable()).toBe(false);
	});

	it("returns false when the probe sets result.error even with status 0", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, error: new Error("ENOENT") }));
		expect(isTsgoAvailable()).toBe(false);
	});

	it("returns false from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(isTsgoAvailable()).toBe(false);
	});

	it("memoizes: probes only once across repeated calls (true)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		expect(isTsgoAvailable()).toBe(true);
		expect(isTsgoAvailable()).toBe(true);
		expect(isTsgoAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("memoizes a false result too (no re-probe after failure)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1 }));
		expect(isTsgoAvailable()).toBe(false);
		expect(isTsgoAvailable()).toBe(false);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// _resetTsgoAvailabilityCache
// ---------------------------------------------------------------------------

describe("_resetTsgoAvailabilityCache", () => {
	it("clears memoization so the next call re-probes (false → true)", () => {
		spawnSyncMock.mockReturnValueOnce(spawnResult({ status: 1 }));
		expect(isTsgoAvailable()).toBe(false);

		_resetTsgoAvailabilityCache();

		spawnSyncMock.mockReturnValueOnce(spawnResult({ status: 0 }));
		expect(isTsgoAvailable()).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// isBashTsc — matching
// ---------------------------------------------------------------------------

describe("isBashTsc — matching", () => {
	it("matches bare `tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc" } })).toBe(true);
	});
	it("matches `tsc --noEmit`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --noEmit" } })).toBe(true);
	});
	it("matches `npx tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" } })).toBe(
			true,
		);
	});
	it("matches chained `cd foo && tsc`", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "cd x && tsc --noEmit" } })).toBe(
			true,
		);
	});
	it("matches tsc chained after a pipe", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "echo hi | tsc" } })).toBe(true);
	});
	it("matches chained `npx tsc` after a semicolon", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "ls; npx tsc" } })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// isBashTsc — non-matching
// ---------------------------------------------------------------------------

describe("isBashTsc — non-matching", () => {
	it("does not match non-Bash tools", () => {
		expect(isBashTsc({ tool_name: "Read", tool_input: { command: "tsc" } })).toBe(false);
	});
	it("does not match a missing tool_name", () => {
		expect(isBashTsc({ tool_input: { command: "tsc" } })).toBe(false);
	});
	it("does not match when tsgo already in use", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx tsgo --noEmit" } })).toBe(
			false,
		);
	});
	it("does not match --build mode (long and short flags)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --build" } })).toBe(false);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -b" } })).toBe(false);
	});
	it("does not match --watch mode (long and short flags)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --watch" } })).toBe(false);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -w" } })).toBe(false);
	});
	it("does not match --declaration / --emitDeclarationOnly", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --declaration" } })).toBe(
			false,
		);
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --emitDeclarationOnly" } }),
		).toBe(false);
	});
	it("does not match -d short declaration flag", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc -d" } })).toBe(false);
	});
	it("does not match --incremental / --composite", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --incremental" } })).toBe(
			false,
		);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --composite" } })).toBe(
			false,
		);
	});
	it("does not match --init / --generateTrace", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --init" } })).toBe(false);
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: "tsc --generateTrace trace" } }),
		).toBe(false);
	});
	it("does not match tsc mentioned inside a string", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "echo 'run tsc later'" } })).toBe(
			false,
		);
	});
	it("does not match missing tool_input", () => {
		expect(isBashTsc({ tool_name: "Bash" })).toBe(false);
	});
	it("does not match an empty / whitespace command (the `|| ''` + trim fallback)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "" } })).toBe(false);
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "   " } })).toBe(false);
	});
	it("does not match a non-string command (coerced via `|| ''`)", () => {
		expect(
			isBashTsc({ tool_name: "Bash", tool_input: { command: undefined } as never }),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// tryTsgoRewrite
// ---------------------------------------------------------------------------

describe("tryTsgoRewrite", () => {
	it("returns null without spawning when tsgo is unavailable", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1 })); // version probe fails
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc --noEmit" } }, "/work", log);
		expect(out).toBeNull();
		// Only the version probe ran; no `sh -c` rewrite spawn.
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(log).not.toHaveBeenCalled();
	});

	it("rewrites `npx tsc` → `npx tsgo`, runs it, and returns a block with the output", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "all good\n" });
		});
		const log = vi.fn();
		const out = tryTsgoRewrite(
			{ tool_input: { command: "npx tsc --noEmit" } },
			"/work",
			log,
		);
		expect(out).toEqual({
			decision: "block",
			reason: [
				"[interlinked:tsgo] Accelerated with tsgo (native TypeScript compiler)",
				"$ npx tsgo --noEmit",
				"all good",
			].join("\n"),
		});
		// The rewritten command is the second spawnSync call, via `sh -c`.
		const rewriteCall = spawnSyncMock.mock.calls[1] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(rewriteCall[0]).toBe("sh");
		expect(rewriteCall[1]).toEqual(["-c", "npx tsgo --noEmit"]);
		expect(rewriteCall[2]).toMatchObject({
			cwd: "/work",
			timeout: 120_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// log fires once: the acceleration banner.
		expect(log).toHaveBeenCalledTimes(1);
		expect(nonNull(log.mock.calls[0])[0]).toContain("tsgo acceleration:");
		expect(nonNull(log.mock.calls[0])[0]).toContain("→");
	});

	it("rewrites bare `tsc` → `npx tsgo` (adds the npx prefix)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc --noEmit" } }, "/r", () => {});
		const rewriteCall = spawnSyncMock.mock.calls[1] as [string, string[], unknown];
		expect(rewriteCall[1]).toEqual(["-c", "npx tsgo --noEmit"]);
		expect(out).not.toBeNull();
	});

	it("concatenates stdout + stderr in the block output", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "out-part", stderr: "err-part" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason).toContain("out-parterr-part");
	});

	it("emits `(no output)` when tsgo runs clean but prints nothing", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "", stderr: "" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason.split("\n")).toContain("(no output)");
	});

	it("falls back (null) and logs when the rewrite leaves only whitespace output but clean exit", () => {
		// `output` is trimmed to "" so the `(no output)` branch is taken — exit
		// is clean, so this is still a block, not a fallback. Distinct from the
		// non-zero cases below.
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "   \n  " });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason.split("\n")).toContain("(no output)");
	});

	it("falls back to tsc (null) and logs when tsgo exits non-zero", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 2, stdout: "type error\n" });
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(log).toHaveBeenCalledTimes(2); // banner + "falling back"
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo exited 2, falling back to tsc");
	});

	it("treats a null exit status as 1 (the `?? 1` fallback) and falls back", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: null, stdout: "" });
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo exited 1, falling back to tsc");
	});

	it("returns null from the catch block when the rewrite spawnSync throws (Error)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			throw new Error("spawn blew up");
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(log).toHaveBeenCalledTimes(2);
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo acceleration failed: spawn blew up");
	});

	it("returns null from the catch block when the thrown value is not an Error (String fallback)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			// Non-Error throw exercises the `String(err)` branch in the catch.
			throw "string failure";
		});
		const log = vi.fn();
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", log);
		expect(out).toBeNull();
		expect(nonNull(log.mock.calls[1])[0]).toBe("tsgo acceleration failed: string failure");
	});

	it("handles a missing command (the `|| ''` fallback) — rewrites to empty `npx tsgo`-less string", () => {
		// No `tsc` token to match, so replace() leaves the empty string untouched.
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "ran" });
		});
		const out = tryTsgoRewrite({ tool_input: {} }, "/r", () => {});
		const rewriteCall = spawnSyncMock.mock.calls[1] as [string, string[], unknown];
		expect(rewriteCall[1]).toEqual(["-c", ""]);
		expect(out).not.toBeNull();
	});

	it("uses the undefined-stdout/stderr `|| ''` fallback without throwing", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: undefined, stderr: undefined });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "tsc" } }, "/r", () => {});
		expect(out?.reason.split("\n")).toContain("(no output)");
	});
});
