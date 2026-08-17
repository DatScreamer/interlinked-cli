// ===========================================
// Companion-stem tests for server-tsgo-bash.ts
// ===========================================
// This is the mutation runner's primary overlay target for
// `server-tsgo-bash.ts`. The runner's fixed-stem probe (`testScopeFor` in
// scratch/two-box-runner/runner.mjs) looks for `<base>.test.ts` first, and
// the reverse-import-graph fallback (`computeMutationTestScope` in
// `mutation/test-scope.ts`) needs a real STATIC import edge to find a test
// file at all. Neither existed before this file.
//
// The two siblings that already cover this module —
// server-tsgo-bash.survivors.test.ts (7 tests) and
// server-tsgo-bash.integration.test.ts (38 tests) — both import the SUT via
// a three-line destructured DYNAMIC import:
//
//   const { isTsgoAvailable, ... } = await import(
//   	"./server-tsgo-bash.js"
//   );
//
// `project-graph/parser-imports.ts`'s `collapseImportLines` only buffers a
// continuation line when the line itself starts with the literal token
// "import" (a real static `import { … } from '...'` split across lines).
// A line starting with `const { … } = await import(` does not qualify, so
// the three lines are parsed SEPARATELY and none of them satisfies
// `matchDynamicImport`'s single-line regex (the opening `import(` is on
// line 1, the string literal on line 2, the closing paren on line 3) —
// `parseImports` emits ZERO edges for either file. The reverse-graph BFS
// the mutation runner's `computeMutationTestScope` walks therefore sees no
// dependents of `server-tsgo-bash.ts`, and the fixed-stem probe also comes
// up empty since neither sibling is literally named
// `server-tsgo-bash.test.ts`. Net effect: the runner ships zero overlay
// tests for this target and all 115 mutants report survived — not because
// the code is untested, but because neither existing test file is where
// either resolution path looks.
//
// This file ports the full, unmodified test bodies of both siblings (same
// assertions, same mocked boundary) behind ONE static top-level import so
// both problems are fixed at once: it satisfies the fixed-stem probe by
// name, and the static `import { … } from "./server-tsgo-bash.js"` below
// is matched directly by `matchStaticImport`'s single-line named-import
// regex, giving the reverse-import graph a real edge. Vitest hoists
// `vi.mock(...)` calls above ALL imports (static or dynamic) in the same
// file regardless of source order, so mocking `node:child_process` still
// works exactly as it did with the dynamic-import form — this is Vitest's
// documented, primary mocking pattern, not a workaround.
//
// Both source files remain in place unmodified; this file is additive
// only. See them for the full mutant-kill provenance notes —
// survivors.test.ts's header in particular documents the one proven-
// equivalent mutant (site 029e1690c06f53bb) that is deliberately not
// re-tested anywhere.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	_resetTsgoAvailabilityCache,
	isBashTsc,
	isTsgoAvailable,
	tryTsgoRewrite,
} from "./server-tsgo-bash.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

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
// isTsgoAvailable  (ported from server-tsgo-bash.integration.test.ts)
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
// _resetTsgoAvailabilityCache  (ported from integration.test.ts)
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
// isBashTsc — matching  (ported from integration.test.ts)
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
// isBashTsc — non-matching  (ported from integration.test.ts)
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
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: undefined } as never })).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// tryTsgoRewrite  (ported from integration.test.ts)
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
		const out = tryTsgoRewrite({ tool_input: { command: "npx tsc --noEmit" } }, "/work", log);
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

// ---------------------------------------------------------------------------
// isBashTsc — regex/whitespace boundary cases
// (ported from server-tsgo-bash.survivors.test.ts)
// ---------------------------------------------------------------------------

describe("isBashTsc — regex/whitespace boundary cases (kill-brief hardening)", () => {
	it("P1: double space between `npx` and `tsc` still matches (kills the leading regex's \\s+ -> \\s mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "npx  tsc --noEmit" } })).toBe(
			true,
		);
	});

	it("P2: zero spaces after a `;` separator still matches (kills the chained regex's \\s* -> \\s mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "ls;tsc" } })).toBe(true);
	});

	it("P3: two spaces between a separator's `npx` and `tsc` still matches (kills the chained regex's inner npx \\s+ -> \\s mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "ls; npx  tsc" } })).toBe(true);
	});

	it("P4: leading/trailing whitespace around a bare `tsc` command still matches (kills the cmd.trim() removal mutant)", () => {
		expect(isBashTsc({ tool_name: "Bash", tool_input: { command: "  tsc --noEmit  " } })).toBe(
			true,
		);
	});

	it("N1: a command that already mentions tsgo is never treated as a tsc command, even with a real tsc chained right after it (kills the tsgo-check ConditionalExpression->false mutant)", () => {
		expect(
			isBashTsc({
				tool_name: "Bash",
				tool_input: { command: "npx tsgo --version; tsc --noEmit" },
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// tryTsgoRewrite — regex + trim/slice boundary cases
// (ported from server-tsgo-bash.survivors.test.ts)
// ---------------------------------------------------------------------------

describe("tryTsgoRewrite — regex + trim/slice boundary cases (kill-brief hardening)", () => {
	it("P5: double space between `npx` and `tsc` still rewrites the WHOLE prefix (kills tryTsgoRewrite's own replace-regex \\s+ -> \\s mutant)", () => {
		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "ok" });
		});
		const out = tryTsgoRewrite({ tool_input: { command: "npx  tsc --noEmit" } }, "/r", () => {});
		const rewriteCall = spawnSyncMock.mock.calls[1] as [string, string[], unknown];
		expect(rewriteCall[1]).toEqual(["-c", "npx tsgo --noEmit"]);
		expect(out).not.toBeNull();
	});

	it("P6: the acceleration banner is trim()+slice(0,60)-exact on both sides of the arrow (kills 4 MethodExpression mutants that drop .trim()/.slice(0,60) on cmd/rewritten)", () => {
		const raw = `   tsc ${"x".repeat(70)}   `;
		const rewritten = raw.replace(/\b(npx\s+)?tsc\b/, "npx tsgo");
		const expectedBanner = `tsgo acceleration: ${raw.trim().slice(0, 60)} → ${rewritten
			.trim()
			.slice(0, 60)}`;

		spawnSyncMock.mockImplementation((...args: unknown[]) => {
			if (isVersionProbe(args)) return spawnResult({ status: 0 });
			return spawnResult({ status: 0, stdout: "ok" });
		});
		const log = vi.fn();
		tryTsgoRewrite({ tool_input: { command: raw } }, "/w", log);

		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toBe(expectedBanner);
	});
});
