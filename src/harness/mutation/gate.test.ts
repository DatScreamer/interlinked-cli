import { describe, expect, it } from "vitest";
import { MutationNotMeasurableError } from "./cloud-runner.js";
import {
	type FileOverlay,
	type MutationGateContext,
	type MutationRunner,
	type PerEditMutationConfig,
	primaryCodeFile,
	runPerEditMutationGate,
} from "./gate.js";
import { emptyManifest } from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutationManifest, MutationReceipt, TestRunResult } from "./types.js";

const FILE = "src/x.ts";
const CONTENT = "function bar(x: number): boolean { return x > 0; }\n";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

function cfg(over: Partial<PerEditMutationConfig> = {}): PerEditMutationConfig {
	return { enabled: true, mode: "block", unavailable_behavior: "allow_unmeasured", ...over };
}

function survivor(status: AdaptedMutant["status"] = "survived"): AdaptedMutant {
	return {
		raw: { file: FILE, mutator: "Eq", originalLexeme: ">", replacement: ">=", startOffset: CONTENT.indexOf("> 0") },
		status,
	};
}

function fakeRunner(mutants: AdaptedMutant[], avail = true, testRun?: TestRunResult): MutationRunner {
	return { available: () => avail, run: () => Promise.resolve(testRun ? { mutants, testRun } : { mutants }) };
}

/**
 * A manifest that already knows this file, so the ratchet applies.
 *
 * `emptyManifest` is a FIRST SIGHTING: with no prior state the gate establishes
 * a baseline rather than verdicting, because "changed region" would otherwise
 * mean the whole file and every pre-existing survivor would look new. These
 * tests exercise the ratchet, so they need a prior. The record's hash is
 * deliberately not CONTENT's — the symbol must read as CHANGED.
 */
function withPriorBaseline(): MutationManifest {
	return {
		...emptyManifest(META),
		files: {
			[FILE]: {
				"sym-prior": {
					symbolId: "sym-prior",
					qualifiedName: "bar",
					symbolHash: "hash-that-does-not-match-current-content",
					mutants: {},
					instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
				},
			},
		},
	};
}

function ctx(over: Partial<MutationGateContext> = {}): MutationGateContext {
	return {
		toolName: "Write",
		toolInput: { file_path: FILE, content: CONTENT },
		config: cfg(),
		runner: fakeRunner([survivor()]),
		baseManifest: withPriorBaseline(),
		readDisk: () => CONTENT,
		at: "t",
		...over,
	};
}

describe("runPerEditMutationGate", () => {
	it("no-ops when disabled", async () => {
		expect(await runPerEditMutationGate(ctx({ config: cfg({ enabled: false }) }))).toBeNull();
	});

	it("no-ops when mode is off", async () => {
		expect(await runPerEditMutationGate(ctx({ config: cfg({ mode: "off" }) }))).toBeNull();
	});

	it("no-ops for a non-mutating tool", async () => {
		expect(await runPerEditMutationGate(ctx({ toolName: "Read" }))).toBeNull();
	});

	it("no-ops when no code file is touched", async () => {
		expect(await runPerEditMutationGate(ctx({ toolInput: { file_path: "README.md", content: "x" } }))).toBeNull();
	});

	it("returns a not-measured allow when no runner is configured", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("[mutation:not-measured]");
	});

	it("returns not-measured when the runner reports unavailable", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([], false) }));
		expect(d?.warnings?.[0]).toContain("not-measured");
	});

	it("fails closed when unavailable_behavior is block", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null, config: cfg({ unavailable_behavior: "block" }) }));
		expect(d?.decision).toBe("block");
	});

	it("blocks a measured new survivor", async () => {
		const d = await runPerEditMutationGate(ctx());
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("surviving mutant");
	});

	it("downgrades a block to a warning when mode is warn", async () => {
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.length).toBeGreaterThan(0);
	});

	it("allows a measured clean run (killed)", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings).toBeUndefined();
	});

	it("blocks a red overlay suite through the gate, even with a killed mutant (spec §7)", async () => {
		const runner = fakeRunner([survivor("killed")], true, { overlayGreen: false, redWitnessSatisfied: null });
		const d = await runPerEditMutationGate(ctx({ runner }));
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("RED on this edit");
	});

	it("no-ops when the edited file has no disk content to overlay", async () => {
		const d = await runPerEditMutationGate(ctx({ readDisk: () => null }));
		expect(d).toBeNull();
	});

	it("returns not-measured when the runner throws", async () => {
		const throwing: MutationRunner = { available: () => true, run: () => Promise.reject(new Error("boom")) };
		const d = await runPerEditMutationGate(ctx({ runner: throwing }));
		expect(d?.warnings?.[0]).toContain("not-measured");
	});

	it("ships the full overlay set: primary first, companion test read from disk (spec §7)", async () => {
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		// ctx's readDisk returns content for every path — so the companion test
		// "exists" on local disk and must travel with the edit.
		await runPerEditMutationGate(ctx({ runner: capturing }));
		expect(captured?.map((o) => o.path)).toEqual([FILE, "src/x.test.ts"]);
		expect(captured?.[0]?.content).toBe(CONTENT);
	});
});

describe("runPerEditMutationGate — manifest/receipt persistence (spec §4/§12)", () => {
	function persistSpy(): { calls: Array<{ generation: number; overlayHash: string }>; persist: (m: MutationManifest, r: MutationReceipt) => void } {
		const calls: Array<{ generation: number; overlayHash: string }> = [];
		return { calls, persist: (m, r) => calls.push({ generation: m.generation, overlayHash: r.overlayHash }) };
	}

	it("persists the refreshed manifest + receipt on a measured-clean allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.generation).toBe(1); // bumped from the empty manifest's 0
		expect(spy.calls[0]?.overlayHash).toHaveLength(64); // receipt bound to the overlay
	});

	it("does NOT persist on a survivor block", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ persist: spy.persist }));
		expect(d?.decision).toBe("block");
		expect(spy.calls).toHaveLength(0);
	});

	it("does NOT persist when warn-mode downgrades a dirty run to allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }), persist: spy.persist }));
		expect(d?.decision).toBe("allow"); // downgraded on the wire…
		expect(spy.calls).toHaveLength(0); // …but the OUTCOME was dirty → no refresh
	});

	it("does NOT persist on a not-measured allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ runner: null, persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(spy.calls).toHaveLength(0);
	});

	it("surfaces a persistence failure as a warning — the allow stands", async () => {
		const persist = () => {
			throw new Error("disk full");
		};
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.some((w) => w.includes("persistence failed") && w.includes("disk full"))).toBe(true);
	});
});

describe("primaryCodeFile — choosing what is worth mutating", () => {
	it("picks a plain code file", () => {
		expect(primaryCodeFile(["src/a.ts"])).toBe("src/a.ts");
	});

	it("skips a test file — mutating tests measures nothing", () => {
		// Live failure this prevents: a run targeting harvest.test.ts derived the
		// scope harvest.test.test.ts, matched no tests, and reported an opaque
		// "the mutation runner failed".
		expect(primaryCodeFile(["src/a.test.ts"])).toBeNull();
	});

	it("prefers the code file when a change set holds both", () => {
		expect(primaryCodeFile(["src/a.test.ts", "src/a.ts"])).toBe("src/a.ts");
	});

	it("skips __tests__ directory files too", () => {
		expect(primaryCodeFile(["src/__tests__/a.test.ts"])).toBeNull();
	});

	it("returns null for non-code paths", () => {
		expect(primaryCodeFile(["README.md", "data.json"])).toBeNull();
	});

	it("returns null for an empty change set", () => {
		expect(primaryCodeFile([])).toBeNull();
	});

	it("skips repo scratch probes — they have no companion test by design", () => {
		// Observed live: a run targeting scratch/two-box-runner/runner.mjs could
		// only ever report "no tests were executed".
		expect(primaryCodeFile(["scratch/probe.mjs"])).toBeNull();
		expect(primaryCodeFile(["scratch/two-box-runner/runner.mjs"])).toBeNull();
	});

	it("still picks product code when a scratch file is also in the change set", () => {
		expect(primaryCodeFile(["scratch/probe.mjs", "src/a.ts"])).toBe("src/a.ts");
	});
});

const NM_CONFIG: PerEditMutationConfig = {
	enabled: true,
	mode: "warn",
	unavailable_behavior: "allow_unmeasured",
	budget_ms: 1000,
};

function nmGateCtx(runError: unknown): MutationGateContext {
	return {
		toolName: "Edit",
		toolInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
		config: NM_CONFIG,
		runner: {
			available: () => true,
			run: async () => {
				throw runError;
			},
		},
		baseManifest: emptyManifest({
			engine: "stryker",
			engineVersion: "9",
			dependencyGraphVersion: "1",
			environmentHash: "h",
			authoritativeAt: "2026-07-28T00:00:00Z",
		}),
		readDisk: () => "export const a = 1;\n",
		at: "2026-07-28T00:00:00Z",
	};
}

describe("gate messaging — the reader can act on the difference", () => {
	it("says the file has no test, not that the runner failed", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("no_tests")));
		expect(d?.warnings?.join("\n")).toContain("no test exercises this file");
		expect(d?.warnings?.join("\n")).not.toContain("runner failed");
	});

	it("names an unrecognized not-measurable reason instead of hiding it", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("engine_unsupported")));
		expect(d?.warnings?.join("\n")).toContain("engine_unsupported");
	});

	it("still reports a genuine failure as a failure", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("connection refused")));
		expect(d?.warnings?.join("\n")).toContain("runner failed");
	});

	it("P: says the runner is BUSY, not that the file has no tests, when the runner throws the dedicated busy error", async () => {
		// The measurement-integrity property under test: a contended runner must
		// never read as "no test exercises this file" — that would silently drop
		// a perfectly-tested file out of the campaign's denominator every time
		// the fleet is loaded.
		const busyErr = Object.assign(new Error("mutation runner is busy with another job (HTTP 503)"), {
			name: "MutationRunnerBusyError",
		});
		const d = await runPerEditMutationGate(nmGateCtx(busyErr));
		expect(d?.warnings?.join("\n")).toContain("busy");
		expect(d?.warnings?.join("\n")).not.toContain("no test exercises this file");
		expect(d?.warnings?.join("\n")).not.toContain("runner failed");
	});

	it("P: also recognizes a generic HTTP 503 error (a runner with no dedicated busy type) as busy, not as a plain failure", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("mutation runner HTTP 503")));
		expect(d?.warnings?.join("\n")).toContain("busy");
		expect(d?.warnings?.join("\n")).not.toContain("no test exercises this file");
	});

	it("N: a non-503 HTTP error stays a plain failure, never mislabeled busy", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new Error("mutation runner HTTP 500")));
		expect(d?.warnings?.join("\n")).toContain("runner failed");
		expect(d?.warnings?.join("\n")).not.toContain("busy");
	});

	it("N: a genuine no_tests verdict is unaffected by the busy check — still terminal, still says no tests", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("no_tests")));
		expect(d?.warnings?.join("\n")).toContain("no test exercises this file");
		expect(d?.warnings?.join("\n")).not.toContain("busy");
	});

	it("prefers the still-running message when handles came back", async () => {
		// Budget expiry outranks everything: results are genuinely still coming.
		const pendingErr = Object.assign(new Error("pending"), {
			jobId: "j1",
			runnerUrl: "http://runner/",
		});
		const d = await runPerEditMutationGate(nmGateCtx(pendingErr));
		expect(d?.warnings?.join("\n")).toContain("still running past the budget");
	});

	it("falls back to 'unspecified' when the not-measurable reason is an empty string", async () => {
		const d = await runPerEditMutationGate(nmGateCtx(new MutationNotMeasurableError("")));
		expect(d?.warnings?.join("\n")).toContain("mutation not measurable here (unspecified)");
	});

	it("falls back to 'unspecified' when the not-measurable reason is not a string at all", async () => {
		const nonStringReasonErr = Object.assign(new Error("x"), {
			name: "MutationNotMeasurableError",
			reason: 42,
		});
		const d = await runPerEditMutationGate(nmGateCtx(nonStringReasonErr));
		expect(d?.warnings?.join("\n")).toContain("mutation not measurable here (unspecified)");
	});
});

describe("runPerEditMutationGate — local-dependency overlay walk (spec §7)", () => {
	const TARGET = "src/y.ts";
	const COMPANION = "src/y.test.ts";
	const DEP = "src/shared.ts";
	const GONE = "src/gone.ts";

	it("carries a local dep imported by both the target and its companion exactly once, and drops one that vanishes before the second read", async () => {
		const files: Record<string, string> = {
			[TARGET]: 'import "./shared.js";\nimport "./gone.js";\nexport const y = 1;\n',
			[COMPANION]: 'import "./shared.js";\nexport {};\n',
			[DEP]: "export const shared = 1;\n",
			[GONE]: "export const gone = 1;\n",
		};
		const counts: Record<string, number> = {};
		const readDisk = (p: string): string | null => {
			if (!(p in files)) return null;
			counts[p] = (counts[p] ?? 0) + 1;
			// GONE resolves fine the first two times collectLocalDeps reads it
			// (once confirming the specifier, once when dequeued) but has vanished
			// by the time addLocalDeps does its own re-read.
			if (p === GONE && counts[p] > 2) return null;
			return files[p] ?? null;
		};
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: TARGET, content: files[TARGET] as string },
				runner: capturing,
				readDisk,
			}),
		);
		const paths = captured?.map((o) => o.path) ?? [];
		expect(paths.filter((p) => p === DEP)).toEqual([DEP]);
		expect(paths).not.toContain(GONE);
	});
});

describe("runPerEditMutationGate — cwd threading (spec: manifest key normalization)", () => {
	it("accepts an explicit cwd for manifest-key resolution without throwing", async () => {
		const d = await runPerEditMutationGate(
			ctx({
				toolInput: { file_path: "/repo/src/z.ts", content: "export const z = 1;\n" },
				readDisk: () => "export const z = 1;\n",
				runner: fakeRunner([survivor("killed")]),
				baseManifest: emptyManifest(META),
				cwd: "/repo",
			}),
		);
		expect(d?.decision).toBe("allow");
	});
});

describe("persistIfCleanMeasured — non-Error persistence failure (via runPerEditMutationGate)", () => {
	it("stringifies a thrown non-Error value in the persistence-failure warning", async () => {
		const persist = () => {
			// eslint-disable-next-line no-throw-literal
			throw "disk full (string throw)";
		};
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.some((w) => w.includes("persistence failed") && w.includes("disk full (string throw)"))).toBe(
			true,
		);
	});
});
