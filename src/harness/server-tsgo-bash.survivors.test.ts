// Hardening tests targeting specific SURVIVING mutants from
// scratch/fleet-r2/kill-briefs/src_harness_server-tsgo-bash.ts.json that
// the companion server-tsgo-bash.integration.test.ts did not yet have a
// fixture for. Every case below was empirically verified BEFORE being
// written here with a shadow-mutation probe that physically applies each
// mutant's exact textual replacement to a shadow copy of the module and
// diffs real behavior against the mutant — see
// scratch/probes/server-tsgo-bash-shadow-verify.mts.
//
// Of the kill-brief's 115 listed survivor rows, the shadow probe confirms
// 114 are killed by (existing-file UNION this-file) — 104 were already
// killed by scenarios that directly mirror the existing file's assertions
// (that file already discriminates them; this new file adds only the ~10
// rows that needed a genuinely new fixture: regex whitespace-quantifier
// boundaries in isBashTsc and tryTsgoRewrite's own rewrite regex, plus the
// trim()+slice(0,60) log-banner formatting, none of which the existing
// short/no-whitespace command fixtures exercise).
//
// The ONE remaining row — site 029e1690c06f53bb, the `""` ->
// `"Stryker was here!"` fallback string in isBashTsc's
// `(... || "").trim()` — is proven EQUIVALENT: isBashTsc's entire surface
// is a single boolean derived from regex tests against `cmd`, `cmd` itself
// is never returned or structurally compared, and "Stryker was here!"
// fails every one of those regexes exactly like "" does, for any reachable
// input. Proven via a 5000-case randomized + adversarial fuzz, 0
// mismatches — see scratch/probes/server-tsgo-bash-fallback-fuzz.mts.
// Deliberately not (and cannot be) re-tested here.
//
// Same single mocked boundary as the companion file: node:child_process
// `spawnSync`.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Imported after the mock is registered so the module binds the mocked spawnSync.
const { _resetTsgoAvailabilityCache, isBashTsc, tryTsgoRewrite } = await import(
	"./server-tsgo-bash.js"
);

/** Build a minimal SpawnSyncReturns — mirrors the companion file's helper. */
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
// isBashTsc — regex/whitespace boundary cases
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
