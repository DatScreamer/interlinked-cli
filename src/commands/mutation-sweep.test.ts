import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearManifestCache } from "../harness/mutation/manifest.js";
import type { MeasureOneResult } from "./mutation-measure-support.js";
import {
	laneEndpoints,
	mutationSweepCommand,
	renderSweepLine,
	renderSweepSummary,
	runPool,
	selectSweepTargets,
	summarizeSweep,
	unqualifiedOnly,
} from "./mutation-sweep.js";

function target(file: string, open: number) {
	return { file, open, uncovered: 0, qualified: false };
}

function result(file: string, over: Partial<MeasureOneResult> = {}): MeasureOneResult {
	return {
		file,
		status: "measured",
		mutants: 10,
		survivors: 2,
		survivorList: [],
		record: { recorded: true, before: { mutants: 10, survivors: 5 }, after: { mutants: 10, survivors: 2 } },
		notes: [],
		...over,
	};
}

describe("selectSweepTargets", () => {
	const rows = [target("a.ts", 9), target("b.ts", 7), target("c.ts", 5), target("d.ts", 3), target("e.ts", 1)];

	it("P1: keeps the ranked order it was given", () => {
		expect(selectSweepTargets(rows, {}).map((t) => t.file)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
	});

	it("P2: --limit truncates from the worst end, where the work is", () => {
		expect(selectSweepTargets(rows, { limit: 2 }).map((t) => t.file)).toEqual(["a.ts", "b.ts"]);
	});

	it("P3: a shard takes every n-th file, so two machines split the heavy ones", () => {
		expect(selectSweepTargets(rows, { shard: { index: 0, count: 2 } }).map((t) => t.file)).toEqual([
			"a.ts",
			"c.ts",
			"e.ts",
		]);
	});

	it("P4: shard applies BEFORE limit, so --limit means 'this machine measures N'", () => {
		const picked = selectSweepTargets(rows, { shard: { index: 1, count: 2 }, limit: 1 });
		expect(picked.map((t) => t.file)).toEqual(["b.ts"]);
	});

	it("N1: an empty work-list selects nothing rather than throwing", () => {
		expect(selectSweepTargets([], { limit: 5 })).toEqual([]);
	});

	it("N2: a limit at or above the list length is the identity", () => {
		expect(selectSweepTargets(rows, { limit: 99 })).toHaveLength(5);
	});
});

describe("summarizeSweep", () => {
	it("P1: counts each terminal status separately", () => {
		const s = summarizeSweep([
			result("a.ts"),
			result("b.ts", { status: "busy" }),
			result("c.ts", { status: "error", reason: "boom" }),
			result("d.ts", { status: "not_measurable", reason: "no_tests" }),
		]);
		expect(s).toMatchObject({ measured: 1, busy: 1, errors: 1, notMeasurable: 1 });
	});

	it("P2: sums the survivor delta only over files that actually re-measured", () => {
		const s = summarizeSweep([
			result("a.ts"), // 5 -> 2
			result("b.ts", { record: { recorded: true, before: { mutants: 4, survivors: 4 }, after: { mutants: 4, survivors: 1 } } }),
			result("c.ts", { status: "busy", record: null }),
		]);
		expect(s.survivorsBefore).toBe(9);
		expect(s.survivorsAfter).toBe(3);
	});

	it("P3: a file with no record contributes no delta", () => {
		const s = summarizeSweep([result("a.ts", { record: null })]);
		expect(s.survivorsBefore).toBe(0);
		expect(s.survivorsAfter).toBe(0);
	});

	it("N1: an empty sweep summarizes to zeros, not NaN", () => {
		const s = summarizeSweep([]);
		expect(s).toMatchObject({ measured: 0, busy: 0, errors: 0, survivorsBefore: 0, survivorsAfter: 0 });
	});

	it("N2: local refusals are counted as errors, not as measurements", () => {
		const s = summarizeSweep([
			result("a.ts", { status: "unreadable", reason: "gone" }),
			result("b.ts", { status: "no_runner", reason: "none" }),
			result("c.ts", { status: "red_suite", reason: "RED" }),
		]);
		expect(s.measured).toBe(0);
		expect(s.errors).toBe(3);
	});
});

describe("renderSweepLine", () => {
	it("P1: a measured file shows the before → after survivor movement", () => {
		expect(renderSweepLine(result("src/a.ts"))).toContain("5 → 2");
	});

	it("P2: a busy runner is reported as not measured, never as a clean result", () => {
		const line = renderSweepLine(result("src/a.ts", { status: "busy", reason: "all endpoints busy" }));
		expect(line).toMatch(/busy/i);
		expect(line).not.toMatch(/→/);
	});

	it("P3: a failure carries the runner's reason", () => {
		expect(renderSweepLine(result("src/a.ts", { status: "error", reason: "npm install failed" }))).toContain(
			"npm install failed",
		);
	});

	it("N1: a measured file with no record still renders its absolute counts", () => {
		const line = renderSweepLine(result("src/a.ts", { record: null }));
		expect(line).toContain("2");
		expect(line).toContain("src/a.ts");
	});
});

describe("renderSweepSummary", () => {
	it("P1: states the net survivor movement across the sweep", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts")]), { shard: { index: 0, count: 2 } });
		expect(text).toContain("5 → 2");
		expect(text).toContain("1/2");
	});

	it("N1: a sweep that measured nothing says so instead of claiming success", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts", { status: "busy" })]), {});
		expect(text).toMatch(/0 measured|nothing measured/i);
	});
});


describe("unqualifiedOnly — what makes a long sweep restartable", () => {
	const rows = [
		{ file: "done.ts", open: 92, uncovered: 0, qualified: true },
		{ file: "todo.ts", open: 5, uncovered: 0, qualified: false },
	];

	it("P1: drops files already measured under the current regime", () => {
		expect(unqualifiedOnly(rows).map((t) => t.file)).toEqual(["todo.ts"]);
	});

	it("P2: a qualified file is skipped even though it still has survivors — real debt survives re-measurement", () => {
		expect(unqualifiedOnly(rows).some((t) => t.file === "done.ts")).toBe(false);
	});

	it("P3: selectSweepTargets applies it before sharding, so both boxes skip the same finished work", () => {
		const picked = selectSweepTargets(rows, { unqualifiedOnly: true, shard: { index: 0, count: 1 } });
		expect(picked.map((t) => t.file)).toEqual(["todo.ts"]);
	});

	it("N1: without the flag every file stays in the list", () => {
		expect(selectSweepTargets(rows, {}).map((t) => t.file)).toEqual(["done.ts", "todo.ts"]);
	});

	it("N2: an all-qualified list selects nothing rather than falling back to everything", () => {
		expect(selectSweepTargets([rows[0]!], { unqualifiedOnly: true })).toEqual([]);
	});
});


describe("runPool — N workers pulling one queue", () => {
	it("P1: runs items concurrently up to the lane count", async () => {
		let inFlight = 0;
		let peak = 0;
		await runPool([1, 2, 3, 4, 5, 6], 3, async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
		});
		expect(peak).toBe(3);
	});

	it("P2: keeps results in INPUT order even when they finish out of order", async () => {
		const out = await runPool([30, 1, 20, 2], 4, async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out).toEqual([30, 1, 20, 2]);
	});

	it("P3: a slow lane does not hold back the queue — a fast worker takes more items", async () => {
		const byLane = [0, 0];
		await runPool(Array.from({ length: 10 }, (_, i) => i), 2, async (_item, lane) => {
			byLane[lane] = (byLane[lane] ?? 0) + 1;
			await new Promise((r) => setTimeout(r, lane === 0 ? 1 : 20));
		});
		// The fast lane must have claimed strictly more work than the slow one;
		// a static split would have given them five each.
		expect(byLane[0]!).toBeGreaterThan(byLane[1]!);
	});

	it("P4: every item runs exactly once", async () => {
		const seen: number[] = [];
		await runPool([1, 2, 3, 4, 5], 3, async (n) => {
			seen.push(n);
		});
		// Numeric comparator: the default sort is lexicographic, so a queue of ten
		// or more items would compare [10, 9] as [10, 9] and pass or fail by luck.
		expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	});

	it("N1: more lanes than items does not spawn idle workers or throw", async () => {
		const out = await runPool([7], 8, async (n) => n * 2);
		expect(out).toEqual([14]);
	});

	it("N2: an empty queue completes immediately with an empty result", async () => {
		expect(await runPool([], 4, async () => 1)).toEqual([]);
	});

	it("N3: one lane is plain sequential execution", async () => {
		const order: number[] = [];
		await runPool([1, 2, 3], 1, async (n) => {
			order.push(n);
			await new Promise((r) => setTimeout(r, 1));
		});
		expect(order).toEqual([1, 2, 3]);
	});
});


describe("laneEndpoints — surviving a runner that disconnects", () => {
	const three = ["http://a", "http://b", "http://c"];

	it("P1: each lane prefers its own runner, so two lanes never open on the same one", () => {
		expect(laneEndpoints(three, 0)[0]).toBe("http://a");
		expect(laneEndpoints(three, 1)[0]).toBe("http://b");
		expect(laneEndpoints(three, 2)[0]).toBe("http://c");
	});

	it("P2: every lane still carries every runner as a fallback", () => {
		for (let lane = 0; lane < three.length; lane++) {
			expect([...laneEndpoints(three, lane)].sort()).toEqual([...three].sort());
		}
	});

	it("P3: the fallback order rotates, so a dead first choice does not send every lane to the same second choice", () => {
		expect(laneEndpoints(three, 0)[1]).toBe("http://b");
		expect(laneEndpoints(three, 1)[1]).toBe("http://c");
		expect(laneEndpoints(three, 2)[1]).toBe("http://a");
	});

	it("N1: a single runner has no fallback to add", () => {
		expect(laneEndpoints(["http://only"], 0)).toEqual(["http://only"]);
	});

	it("N2: an empty endpoint list stays empty rather than throwing", () => {
		expect(laneEndpoints([], 0)).toEqual([]);
	});
});

// ===========================================
// mutationSweepCommand — the CLI dispatch: manifest load, endpoint/selection
// resolution, dry-run, and the pooled sweep itself. `measureOneFile` is
// injected so these tests never touch the network or a real runner.
// ===========================================
describe("mutationSweepCommand", () => {
	let cwd: string;
	let logs: string[];
	let errs: string[];

	function survivedManifest(files: Record<string, { mutantId: string }[]>) {
		const out: Record<string, unknown> = {};
		for (const [file, mutants] of Object.entries(files)) {
			out[file] = {
				s1: {
					symbolId: "s1",
					qualifiedName: "fn",
					symbolHash: "h",
					instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
					mutants: Object.fromEntries(
						mutants.map((m) => [
							m.mutantId,
							{
								mutantId: m.mutantId,
								siteId: `site-${m.mutantId}`,
								mutator: "BooleanLiteral",
								originalLexeme: "true",
								replacement: "false",
								ordinalWithinSymbol: 0,
								status: "survived",
								firstSeen: "2026-08-01T00:00:00.000Z",
							},
						]),
					),
				},
			};
		}
		return {
			version: 1,
			generation: 1,
			authoritativeAt: "2026-08-09T00:00:00.000Z",
			engine: "stryker",
			engineVersion: "8",
			dependencyGraphVersion: "1",
			environmentHash: "env",
			files: out,
		};
	}

	function writeManifest(manifest: unknown) {
		writeFileSync(join(cwd, ".interlinked", "mutation-manifest.json"), JSON.stringify(manifest));
		clearManifestCache();
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mutation-sweep-cmd-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "here.ts"), "export const x = 1;\n");
		writeFileSync(join(cwd, "src", "there.ts"), "export const y = 2;\n");
		logs = [];
		errs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			errs.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		clearManifestCache();
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	function reported(): { summary: ReturnType<typeof summarizeSweep>; results: MeasureOneResult[] } {
		return JSON.parse(logs.join("\n"));
	}

	it("P1: a missing manifest is an error exit, not a silent empty sweep", async () => {
		await mutationSweepCommand({ cwd, json: true, runnerUrl: ["http://runner.invalid"] });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/no mutation manifest/i);
	});

	it("P2: an invalid --shard is refused before the manifest is even read", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand({ cwd, json: true, shard: "9/2", runnerUrl: ["http://runner.invalid"] });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--shard must be/);
	});

	it("P3: --dry-run selects targets and reports them without invoking measureOne", async () => {
		writeManifest(
			survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [{ mutantId: "m2" }] }),
		);
		let called = false;
		await mutationSweepCommand({ cwd, json: true, dryRun: true }, async (): Promise<MeasureOneResult> => {
			called = true;
			return { file: "unused", status: "measured", mutants: 0, survivors: 0, survivorList: [], record: null, notes: [] };
		});
		expect(called).toBe(false);
		const payload = reported() as unknown as { dryRun: boolean; selected: unknown[]; total: number };
		expect(payload.dryRun).toBe(true);
		expect(payload.selected).toHaveLength(2);
		expect(payload.total).toBe(2);
	});

	it("P4: no configured runner (and none passed) is a clear error, not a silent 0-file sweep", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand({ cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/no mutation runner configured/i);
	});

	it("P5: an explicit --runner-url is used and reaches measureOneFile's runnerUrls", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const seenUrls: string[][] = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid", "http://b.invalid"] },
			async (args): Promise<MeasureOneResult> => {
				seenUrls.push(args.runnerUrls ?? []);
				return {
					file: args.file,
					status: "measured",
					mutants: 1,
					survivors: 0,
					survivorList: [],
					record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
					notes: [],
				};
			},
		);
		expect(seenUrls[0]).toEqual(["http://a.invalid", "http://b.invalid"]);
		expect(process.exitCode).toBe(0);
	});

	it("P6: passes record:true and surface:'sweep' to every measured file — a sweep that never records changes nothing", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const argsSeen: Array<{ record: boolean | undefined; surface: string | undefined }> = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => {
				argsSeen.push({ record: args.record, surface: args.surface });
				return {
					file: args.file,
					status: "measured",
					mutants: 1,
					survivors: 0,
					survivorList: [],
					record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
					notes: [],
				};
			},
		);
		expect(argsSeen).toEqual([{ record: true, surface: "sweep" }]);
	});

	it("P7: excludes stale (deleted) files from the sweep — they cannot be re-measured", async () => {
		writeManifest(
			survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/deleted.ts": [{ mutantId: "m2" }] }),
		);
		const files: string[] = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => {
				files.push(args.file);
				return {
					file: args.file,
					status: "measured",
					mutants: 1,
					survivors: 0,
					survivorList: [],
					record: null,
					notes: [],
				};
			},
		);
		expect(files).toEqual(["src/here.ts"]);
	});

	it("P8: a --file filter narrows the sweep to one path", async () => {
		writeFileSync(join(cwd, "src", "alpha.ts"), "export const a = 1;\n");
		writeFileSync(join(cwd, "src", "beta.ts"), "export const b = 2;\n");
		writeManifest(
			survivedManifest({ "src/alpha.ts": [{ mutantId: "m1" }], "src/beta.ts": [{ mutantId: "m2" }] }),
		);
		const files: string[] = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"], file: "alpha.ts" },
			async (args): Promise<MeasureOneResult> => {
				files.push(args.file);
				return { file: args.file, status: "measured", mutants: 1, survivors: 0, survivorList: [], record: null, notes: [] };
			},
		);
		expect(files).toEqual(["src/alpha.ts"]);
	});

	it("N1: measurement errors set a nonzero exit code — a CI caller must not read a failed sweep as progress", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "error",
				reason: "boom",
				mutants: 0,
				survivors: 0,
				survivorList: [],
				record: null,
				notes: [],
			}),
		);
		expect(process.exitCode).toBe(1);
	});

	it("N2: a sweep that measures nothing (all busy) also exits nonzero", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "busy",
				reason: "503",
				mutants: 0,
				survivors: 0,
				survivorList: [],
				record: null,
				notes: [],
			}),
		);
		expect(process.exitCode).toBe(1);
	});

	it("N3: normal (non-json) mode prints a progress line to stderr per file, not just at the end", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "measured",
				mutants: 1,
				survivors: 0,
				survivorList: [],
				record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
				notes: [],
			}),
		);
		expect(errs.some((l) => l.includes("src/here.ts"))).toBe(true);
		expect(errs.some((l) => /sweeping \d+ of \d+/.test(l))).toBe(true);
	});
});
