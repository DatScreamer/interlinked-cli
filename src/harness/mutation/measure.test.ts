import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyManifest } from "./manifest.js";
import type { MutationManifest } from "./types.js";

// Override hook for `mutationIdentityAvailable` — null (the default) passes
// through to the REAL implementation so every other test in this file keeps
// exercising the actual TypeScript-availability check; a single test sets
// this to `false` for its own duration to reach the (otherwise environment-
// dependent — this repo always has `typescript` installed) "identity
// unavailable" branch of `explainRefusal`, then resets it in `afterEach`.
let identityAvailableOverride: boolean | null = null;
vi.mock("./identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./identity.js")>();
	// `explainRefusal` (measure.ts) only calls `mutationIdentityAvailable`, but
	// `seedFileBaseline` (adopt.ts, imported separately) calls `deriveIdentities`
	// / `computeSymbolHashes` directly — both must degrade together for the
	// override to reach the SAME "unavailable" outcome `recordMeasurement`
	// would see for real (a missing `typescript` optionalDependency), rather
	// than explainRefusal disagreeing with what seedFileBaseline actually did.
	return {
		...actual,
		mutationIdentityAvailable: () =>
			identityAvailableOverride ?? actual.mutationIdentityAvailable(),
		deriveIdentities: (...args: Parameters<typeof actual.deriveIdentities>) =>
			identityAvailableOverride === false ? null : actual.deriveIdentities(...args),
		computeSymbolHashes: (...args: Parameters<typeof actual.computeSymbolHashes>) =>
			identityAvailableOverride === false ? null : actual.computeSymbolHashes(...args),
	};
});

const {
	buildMeasureOverlays,
	buildScopedMeasureOverlays,
	MAX_MEASURE_OVERLAYS,
	measureFile,
	recordMeasurement,
	requestWholeFileReport,
} = await import("./measure.js");
type FetchResponseLike = import("./measure.js").FetchResponseLike;

const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

const FILE = "src/a.ts";
const CONTENT = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";

/** A Stryker-shaped report for CONTENT with one mutant at the `>`. */
function report(status: string, file: string = FILE, content: string = CONTENT) {
	const line2 = content.split("\n")[1] ?? "";
	const col = line2.indexOf(">") + 1;
	return {
		files: {
			[file]: {
				source: content,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status,
						location: { start: { line: 2, column: col }, end: { line: 2, column: col + 1 } },
					},
				],
			},
		},
	};
}

function fakeResponse(status: number, body: unknown): FetchResponseLike {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
	identityAvailableOverride = null;
});

describe("buildMeasureOverlays", () => {
	it("P1: includes the companion test when it exists on disk", () => {
		const disk = new Map([["src/a.test.ts", "test content"]]);
		const overlays = buildMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null);
		expect(overlays.map((o) => o.path)).toEqual([FILE, "src/a.test.ts"]);
	});

	it("N1: omits the companion test when it does not exist on disk", () => {
		const overlays = buildMeasureOverlays(FILE, CONTENT, () => null);
		expect(overlays.map((o) => o.path)).toEqual([FILE]);
	});

	it("P2: pulls in transitive local deps from both the target and its companion", () => {
		const disk = new Map([
			["src/a.test.ts", "import './b.js'"],
			["src/a.ts", CONTENT],
			["src/b.ts", "import './c.js'"],
			["src/c.ts", "export const z = 1;\n"],
		]);
		const overlays = buildMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null);
		expect(overlays.map((o) => o.path)).toEqual(["src/a.ts", "src/a.test.ts", "src/b.ts", "src/c.ts"]);
	});

	it("N2: never adds a dep path twice even when both the target and companion import it", () => {
		const disk = new Map([
			["src/a.test.ts", "import './shared.js'"],
			["src/a.ts", "import './shared.js'\n" + CONTENT],
			["src/shared.ts", "export const z = 1;\n"],
		]);
		const overlays = buildMeasureOverlays(FILE, disk.get("src/a.ts") ?? "", (p) => disk.get(p) ?? null);
		const sharedCount = overlays.filter((o) => o.path === "src/shared.ts").length;
		expect(sharedCount).toBe(1);
	});

	it("N3: skips the companion entirely when the target has no test-pairable extension (companion === file)", () => {
		// `expectedCompanionTest` only rewrites a recognized `.ts`/`.js`/… suffix;
		// an extensionless path comes back UNCHANGED, so `companion !== file` is
		// false and the companion push is skipped outright.
		const overlays = buildMeasureOverlays("src/README", "readme content", () => "should never be read");
		expect(overlays).toEqual([{ path: "src/README", content: "readme content" }]);
	});
});

describe("buildScopedMeasureOverlays", () => {
	it("P1: ships every test in the scope, plus each scope test's own transitive deps", () => {
		const disk = new Map([
			["src/a.ts", CONTENT],
			["src/a.test.ts", "sibling companion, no imports"],
			["src/a-roundtrip.test.ts", "import './helper.js'"],
			["src/helper.ts", "export const h = 1;\n"],
			["src/a-outcome.test.ts", "no imports here either"],
		]);
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, [
			"src/a-roundtrip.test.ts",
			"src/a-outcome.test.ts",
		]);
		expect(result.overlays.map((o) => o.path)).toEqual([
			"src/a.ts",
			"src/a.test.ts",
			"src/a-roundtrip.test.ts",
			"src/a-outcome.test.ts",
			"src/helper.ts",
		]);
		expect(result.unreadable).toEqual([]);
		expect(result.capped).toBeUndefined();
	});

	it("N1: a scope test that cannot be read is reported in `unreadable`, not silently dropped", () => {
		const disk = new Map([["src/a.ts", CONTENT]]);
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, [
			"src/ghost.test.ts",
		]);
		expect(result.overlays.map((o) => o.path)).toEqual(["src/a.ts"]);
		expect(result.unreadable).toEqual(["src/ghost.test.ts"]);
	});

	it("P2: an empty testScope reduces to exactly buildMeasureOverlays's behavior", () => {
		const disk = new Map([["src/a.test.ts", "test content"]]);
		const scoped = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, []);
		const plain = buildMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null);
		expect(scoped.overlays).toEqual(plain);
		expect(scoped.unreadable).toEqual([]);
	});

	it("N2: overflow caps the dependency closure but NEVER drops target/companion/scope files themselves", () => {
		const disk = new Map<string, string>([["src/a.ts", CONTENT]]);
		const testScope: string[] = [];
		for (let i = 0; i < 10; i++) {
			const testPath = `src/scope-${i}.test.ts`;
			testScope.push(testPath);
			disk.set(testPath, `import './dep-${i}.js'`);
			disk.set(`src/dep-${i}.ts`, "export const z = 1;\n");
		}
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, testScope);
		// No overflow at this small scale — everything present, nothing capped.
		expect(result.capped).toBeUndefined();
		for (const t of testScope) {
			expect(result.overlays.some((o) => o.path === t)).toBe(true);
		}
	});

	it("N3: MAX_MEASURE_OVERLAYS caps dependency spillover once the candidate set exceeds it, keeping the request set intact", () => {
		const disk = new Map<string, string>([["src/a.ts", CONTENT]]);
		const testScope: string[] = [];
		const overCap = MAX_MEASURE_OVERLAYS + 20;
		for (let i = 0; i < overCap; i++) {
			const testPath = `src/scope-${i}.test.ts`;
			testScope.push(testPath);
			disk.set(testPath, "no imports");
		}
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, testScope);
		expect(result.capped).toBeUndefined(); // no DEPS here, so the required set alone can exceed the const without a "capped" dep-overflow marker
		// Every requested scope test is still present — required paths are never truncated.
		for (const t of testScope) {
			expect(result.overlays.some((o) => o.path === t)).toBe(true);
		}
	});

	it("N4: a testScope entry that duplicates an already-collected path (the companion) is skipped, not re-added", () => {
		const disk = new Map([["src/a.ts", CONTENT], ["src/a.test.ts", "no imports"]]);
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, [
			"src/a.test.ts", // == the companion, already collected before the scope loop runs
		]);
		expect(result.overlays.map((o) => o.path)).toEqual(["src/a.ts", "src/a.test.ts"]);
		expect(result.unreadable).toEqual([]);
	});

	it("N5: reports a non-empty `capped.dropped` when the DEPENDENCY closure (not the required set) overflows the cap", () => {
		const disk = new Map<string, string>([["src/a.ts", CONTENT]]);
		const depCount = MAX_MEASURE_OVERLAYS + 2;
		const imports = Array.from({ length: depCount }, (_, i) => `import './dep-${i}.js';`).join("\n");
		disk.set("src/a.test.ts", imports);
		for (let i = 0; i < depCount; i++) {
			disk.set(`src/dep-${i}.ts`, "export const z = 1;\n");
		}
		const result = buildScopedMeasureOverlays(FILE, CONTENT, (p) => disk.get(p) ?? null, []);
		expect(result.capped).toBeDefined();
		expect(result.capped?.limit).toBe(MAX_MEASURE_OVERLAYS);
		expect(result.capped?.dropped.length).toBeGreaterThan(0);
		// The required set (target + companion) is NEVER among the dropped paths.
		expect(result.capped?.dropped).not.toContain("src/a.ts");
		expect(result.capped?.dropped).not.toContain("src/a.test.ts");
		expect(result.overlays.length).toBe(MAX_MEASURE_OVERLAYS);
		expect(result.overlays.some((o) => o.path === "src/a.ts")).toBe(true);
		expect(result.overlays.some((o) => o.path === "src/a.test.ts")).toBe(true);
	});
});

describe("requestWholeFileReport", () => {
	const baseArgs = {
		file: FILE,
		content: CONTENT,
		overlays: [{ path: FILE, content: CONTENT }],
		jobId: "job-1",
		deadlineMs: 5_000,
		requestTimeoutMs: 1_000,
	};

	it("P1: returns the body from the first endpoint that answers 200", async () => {
		const body = { files: {} };
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome).toEqual({ ok: true, body });
	});

	it("P2: falls over to the second endpoint when the first is unreachable", async () => {
		const body = { files: {} };
		let calls = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://down/", "http://up/"],
			fetchImpl: async (url) => {
				calls++;
				if (url === "http://down/") throw new Error("ECONNREFUSED");
				return fakeResponse(200, body);
			},
		});
		expect(outcome).toEqual({ ok: true, body });
		expect(calls).toBe(2);
	});

	it("N1: a non-503 HTTP error is reported immediately, without retrying", async () => {
		let calls = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async () => {
				calls++;
				return fakeResponse(500, {});
			},
		});
		expect(outcome).toEqual({ ok: false, reason: "mutation runner HTTP 500" });
		expect(calls).toBe(1);
	});

	it("N2: every endpoint busy/unreachable until the deadline reports 'busy or unreachable', never a forged success", async () => {
		// A virtual clock: fetchImpl always fails, sleep() advances the clock
		// instead of actually waiting, so the retry loop runs to completion in
		// real time under a millisecond while still exercising the deadline math.
		let clock = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			deadlineMs: 3_000,
			endpoints: ["http://busy/"],
			fetchImpl: async () => fakeResponse(503, {}),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toContain("busy or unreachable");
	});

	it("P3: a busy-exhausted outcome is TAGGED busy: true — never indistinguishable from a real HTTP error", async () => {
		// The measurement-integrity property under test: a caller must be able to
		// branch on a structured flag, not on parsing the reason string. A busy
		// runner never answered the "does this file have tests?" question, so
		// this MUST NOT read like (or be confusable with) a no_tests verdict.
		let clock = 0;
		const outcome = await requestWholeFileReport({
			...baseArgs,
			deadlineMs: 2_000,
			endpoints: ["http://busy-1/", "http://busy-2/"],
			fetchImpl: async () => fakeResponse(503, {}),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome).toMatchObject({ ok: false, busy: true });
		expect(outcome.ok === false && outcome.reason).toContain("runner_busy");
		expect(outcome.ok === false && outcome.reason).not.toContain("no_tests");
	});

	it("N3: a genuine non-503 HTTP error is NOT tagged busy — it is a definitive (if unhappy) answer", async () => {
		const outcome = await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(500, {}),
		});
		expect(outcome).toEqual({ ok: false, reason: "mutation runner HTTP 500" });
		expect((outcome as { busy?: boolean }).busy).toBeUndefined();
	});

	it("P4: forwards `testScope` verbatim in the request body when provided", async () => {
		let capturedBody = "";
		await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			testScope: ["src/a.test.ts", "src/b.test.ts"],
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(JSON.parse(capturedBody).testScope).toEqual(["src/a.test.ts", "src/b.test.ts"]);
	});

	it("N4: omits `testScope` from the request body entirely when not provided", async () => {
		let capturedBody = "";
		await requestWholeFileReport({
			...baseArgs,
			endpoints: ["http://runner/"],
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(Object.prototype.hasOwnProperty.call(JSON.parse(capturedBody), "testScope")).toBe(false);
	});
});

describe("measureFile", () => {
	const args = {
		file: FILE,
		content: CONTENT,
		overlays: [{ path: FILE, content: CONTENT }],
	};

	it("P1: a full report classifies as 'measured' with the raw report attached", async () => {
		const body = report("Survived");
		const outcome = await measureFile({ ...args, endpoints: ["http://runner/"], fetchImpl: async () => fakeResponse(200, body) });
		expect(outcome.status).toBe("measured");
		expect(outcome.mutantCount).toBe(1);
		expect(outcome.survivorCount).toBe(1);
		expect(outcome.rawReport).toEqual(body);
	});

	it("P2: distinguishes killed from survived mutants in the same report — not just a length check", async () => {
		const killed = report("Killed");
		const survived = report("Survived");
		const both = {
			files: {
				[FILE]: {
					source: CONTENT,
					mutants: [...(killed.files[FILE]?.mutants ?? []), ...(survived.files[FILE]?.mutants ?? [])],
				},
			},
		};
		const outcome = await measureFile({ ...args, endpoints: ["http://runner/"], fetchImpl: async () => fakeResponse(200, both) });
		expect(outcome.mutantCount).toBe(2);
		expect(outcome.survivorCount).toBe(1);
	});

	it("N1: a not_measurable response never carries a rawReport for the caller to (mis)record", async () => {
		const body = { not_measurable: { reason: "no_tests" } };
		const outcome = await measureFile({ ...args, endpoints: ["http://runner/"], fetchImpl: async () => fakeResponse(200, body) });
		expect(outcome.status).toBe("not_measurable");
		expect(outcome.reason).toBe("no_tests");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("N2: an unreachable endpoint exhausted to the deadline reports 'busy' (never got a definitive answer), with no rawReport", async () => {
		// Virtual clock again (see requestWholeFileReport's N2): `now` MUST advance
		// or the deadline condition never trips and the retry loop spins forever —
		// a constant `now` with a no-op `sleep` is not a fast test, it is a hang.
		//
		// "unreachable" and "503-busy" share one retry bucket (tryEndpoint treats
		// both as "keep trying"), so exhausting the deadline this way is the SAME
		// "nobody ever answered" outcome as sustained 503s — status "busy", not
		// the generic "error" a truly broken runner (a definitive non-503 HTTP
		// response) earns. This test used to assert "error" here; that was the
		// exact conflation this fix corrects, not a behavior this test should
		// keep pinning.
		let clock = 0;
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			deadlineMs: 500,
			requestTimeoutMs: 100,
			fetchImpl: async () => {
				throw new Error("down");
			},
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome.status).toBe("busy");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("P3: a sustained-busy runner classifies as 'busy' — a DIFFERENT status than 'error', and NEVER 'no_tests'", async () => {
		// This is the exact defect under test: a runner that only ever answered
		// 503 must not be misreported as "this file has no tests" (not_measurable)
		// nor folded into the generic "error" bucket a truly broken runner earns.
		let clock = 0;
		const outcome = await measureFile({
			...args,
			endpoints: ["http://busy/"],
			deadlineMs: 500,
			requestTimeoutMs: 100,
			fetchImpl: async () => fakeResponse(503, {}),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(outcome.status).toBe("busy");
		expect(outcome.status).not.toBe("error");
		expect(outcome.status).not.toBe("not_measurable");
		expect(outcome.reason).not.toContain("no_tests");
		expect(outcome.rawReport).toBeUndefined();
	});

	it("N3: a genuine HTTP 500 still classifies as 'error', not 'busy' — a broken runner is not a contended one", async () => {
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(500, {}),
		});
		expect(outcome.status).toBe("error");
	});

	it("P4: forwards `testScope` through to the wire request", async () => {
		let capturedBody = "";
		await measureFile({
			...args,
			endpoints: ["http://runner/"],
			testScope: ["src/a.test.ts"],
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				return fakeResponse(200, { files: {} });
			},
		});
		expect(JSON.parse(capturedBody).testScope).toEqual(["src/a.test.ts"]);
	});

	it("P5: a not_measurable response WITH a detail folds it into the reason as `<reason>: <detail>`", async () => {
		const body = { not_measurable: { reason: "no_tests", detail: "no companion test on disk" } };
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("not_measurable");
		expect(outcome.reason).toBe("no_tests: no companion test on disk");
	});

	it("N4: a body with no `files` key summarizes to zero mutants rather than throwing", async () => {
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, { unrelated: true }),
		});
		expect(outcome.status).toBe("measured");
		expect(outcome).toMatchObject({ mutantCount: 0, survivorCount: 0, survivors: [] });
	});

	it("N5: tolerates malformed per-file / per-mutant shapes — skips what it can't read, defaults the rest", async () => {
		const body = {
			files: {
				"not-a-record": "just a string, not an object",
				"missing-mutants-array": { source: "x", mutants: "not an array" },
				[FILE]: {
					source: CONTENT,
					mutants: [
						"not a record — skipped entirely",
						{
							// No `location` at all, and every scalar field is the WRONG type —
							// every `typeof === "string"` / `isRecord` fallback should fire.
							mutatorName: 123,
							replacement: 456,
							status: 789,
						},
						{ mutatorName: "EqualityOperator", replacement: ">=", status: "Survived" },
					],
				},
			},
		};
		const outcome = await measureFile({
			...args,
			endpoints: ["http://runner/"],
			fetchImpl: async () => fakeResponse(200, body),
		});
		expect(outcome.status).toBe("measured");
		// "not-a-record" and "missing-mutants-array" contribute nothing; the
		// string mutant entry is skipped; the two remaining object mutants land.
		expect(outcome.mutantCount).toBe(2);
		expect(outcome.survivorCount).toBe(1);
		expect(outcome.survivors).toEqual([{ line: 0, mutator: "EqualityOperator", replacement: ">=" }]);
	});
});

describe("recordMeasurement — the only write path, and it goes through seedFileBaseline", () => {
	function must(m: MutationManifest | null | undefined): MutationManifest {
		if (m === null || m === undefined) throw new Error("expected a manifest");
		return m;
	}

	it("P1: records a survivor and reports a real before/after delta, not a hardcoded one", () => {
		const base = emptyManifest(META);
		const first = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t1" });
		expect(first.recorded).toBe(true);
		expect(first.before).toEqual({ mutants: 0, survivors: 0 });
		expect(first.after).toEqual({ mutants: 1, survivors: 1 });

		// Re-measure with the SAME mutant now killed — before must reflect the
		// PRIOR (survived) state, after the NEW (killed) state. If the before/after
		// computation were stubbed to constants this would fail.
		const second = recordMeasurement({
			base: must(first.manifest),
			file: FILE,
			content: CONTENT,
			rawReport: report("Killed"),
			at: "t2",
		});
		expect(second.before).toEqual({ mutants: 1, survivors: 1 });
		expect(second.after).toEqual({ mutants: 1, survivors: 0 });
	});

	it("N1: refuses a test-file target — never trusts the report enough to write", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: "src/a.test.ts",
			content: CONTENT,
			rawReport: report("Survived", "src/a.test.ts"),
			at: "t",
		});
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("test files are not mutation targets");
		expect(result.manifest).toBeUndefined();
	});

	it("N2: refuses (and explains) an unrecognizable report rather than writing an empty baseline", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: { nonsense: true }, at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("not a recognizable mutation report");
	});

	it("N3: refuses a report naming zero mutants for this file", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: { files: {} }, at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("zero mutants");
	});

	it("N4: refuses (and explains) when the TypeScript identity API is unavailable", () => {
		identityAvailableOverride = false;
		const base = emptyManifest(META);
		const result = recordMeasurement({ base, file: FILE, content: CONTENT, rawReport: report("Survived"), at: "t" });
		expect(result.recorded).toBe(false);
		expect(result.reason).toContain("TypeScript API is unavailable");
		expect(result.manifest).toBeUndefined();
	});

	it("keys an absolute-path measurement under the SAME repo-relative key a relative one would use", () => {
		const base = emptyManifest(META);
		const result = recordMeasurement({
			base,
			file: "/repo/root/src/a.ts",
			content: CONTENT,
			rawReport: report("Survived"),
			at: "t",
			cwd: "/repo/root",
		});
		expect(result.recorded).toBe(true);
		expect(Object.keys(must(result.manifest).files)).toEqual([FILE]);
	});
});


// ===========================================
// The sweep's own error path. `cloud-runner.ts` (the per-edit gate's client)
// had the same defect and was fixed first; a live 719-file sweep then reported
// a bare `runner HTTP 500` from THIS copy, which is why both now share
// `describeErrorResponse`.
// ===========================================
describe("requestWholeFileReport — a failing runner is quoted, not summarized", () => {
	function failing(status: number, body: string | null) {
		return () =>
			Promise.resolve({
				ok: false,
				status,
				json: () => Promise.resolve(null),
				...(body === null ? {} : { text: () => Promise.resolve(body) }),
			});
	}

	const base = {
		file: "src/a.ts",
		content: "export const x = 1;\n",
		overlays: [],
		endpoints: ["http://runner.invalid"],
		jobId: "job-1",
		deadlineMs: 5_000,
		requestTimeoutMs: 1_000,
	};

	/** Narrow the union so a passing run cannot silently skip the assertion. */
	async function failureOf(status: number, body: string | null) {
		const out = await requestWholeFileReport({ ...base, fetchImpl: failing(status, body) });
		if (out.ok) throw new Error("expected the request to fail");
		return out;
	}

	it("P1: carries a JSON error body into the reason", async () => {
		const out = await failureOf(500, JSON.stringify({ error: "worktree checkout failed" }));
		expect(out.reason).toContain("worktree checkout failed");
	});

	it("P2: carries a plain-text body too", async () => {
		const out = await failureOf(502, "bad gateway from proxy");
		expect(out.reason).toContain("bad gateway from proxy");
	});

	it("N1: degrades to the bare status when no body can be read", async () => {
		const out = await failureOf(500, null);
		expect(out.reason).toBe("mutation runner HTTP 500");
	});

	it("N2: a non-ok status is a definitive failure, never reported as busy", async () => {
		const out = await failureOf(500, "boom");
		expect(out.busy).toBeUndefined();
	});
});


// ===========================================
// Disconnection. A contended runner frees up; a closed laptop does not, and
// treating them the same burned a full per-file budget (900s in the live sweep)
// on every remaining file.
// ===========================================
describe("requestWholeFileReport — an unreachable host is not a busy one", () => {
	const base = {
		file: "src/a.ts",
		content: "export const x = 1;\n",
		overlays: [],
		jobId: "job-1",
		requestTimeoutMs: 50,
	};

	it("P1: gives up well before the deadline when nothing answers at all", async () => {
		let slept = 0;
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead-1", "http://dead-2"],
			deadlineMs: 900_000,
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async (ms: number) => {
				slept += ms;
			},
		});
		if (out.ok) throw new Error("expected failure");
		expect(out.reason).toContain("runner_unreachable");
		// It must NOT have waited out the 900s deadline.
		expect(slept).toBeLessThan(60_000);
	});

	it("P2: names the endpoints it could not reach, so the operator knows which host to check", async () => {
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://mbp:8790"],
			deadlineMs: 900_000,
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async () => {},
		});
		if (out.ok) throw new Error("expected failure");
		expect(out.reason).toContain("http://mbp:8790");
	});

	it("P3: still refuses to read as a no-tests verdict — busy stays set", async () => {
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead"],
			deadlineMs: 900_000,
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async () => {},
		});
		if (out.ok) throw new Error("expected failure");
		expect(out.busy).toBe(true);
		expect(out.reason).toContain("NOT evidence this file lacks tests");
	});

	it("N1: one reachable-but-busy endpoint keeps the run alive to the deadline", async () => {
		let clock = 0;
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead", "http://busy"],
			deadlineMs: 30_000,
			fetchImpl: (url: string) =>
				url.includes("busy")
					? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null) })
					: Promise.reject(new Error("ECONNREFUSED")),
			now: () => clock,
			sleep: async (ms: number) => {
				clock += ms;
			},
		});
		if (out.ok) throw new Error("expected failure");
		// Reached someone every round, so the early-exit must NOT have fired.
		expect(out.reason).toContain("runner_busy");
	});

	it("N2: a healthy fallback answers even when the preferred endpoint is dead", async () => {
		const out = await requestWholeFileReport({
			...base,
			endpoints: ["http://dead", "http://alive"],
			deadlineMs: 30_000,
			fetchImpl: (url: string) =>
				url.includes("alive")
					? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ files: {} }) })
					: Promise.reject(new Error("ECONNREFUSED")),
			now: () => 0,
			sleep: async () => {},
		});
		expect(out.ok).toBe(true);
	});
});
