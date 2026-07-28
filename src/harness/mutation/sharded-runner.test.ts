import { describe, expect, it, vi } from "vitest";
import { MutationNotMeasurableError } from "./cloud-runner.js";
import type { MutationRunner } from "./gate.js";
import { createShardedMutationRunner } from "./sharded-runner.js";

const CONTENT = ["a", "b", "c", "d"].join("\n"); // 4 lines

/** A stub shard runner that records the range it was asked for. */
function stubRunner(
	mutantsByRange: Record<string, number>,
	failRanges: string[] = [],
): { runner: MutationRunner; calls: string[] } {
	const calls: string[] = [];
	const runner: MutationRunner = {
		available: () => true,
		run: async (_file, _overlay, _overlays, range) => {
			const key = range ? `${range.start}-${range.end}` : "all";
			calls.push(key);
			if (failRanges.includes(key)) throw new Error(`shard ${key} exploded`);
			const n = mutantsByRange[key] ?? 0;
			return {
				mutants: Array.from({ length: n }, (_, i) => ({
					raw: {
						file: "f.ts",
						mutator: "M",
						originalLexeme: "x",
						replacement: "y",
						// Offsets must differ per shard, as they do in reality: shards
						// measure disjoint line spans. Reusing 0,1,2 across shards makes
						// distinct findings look like the same mutant to the deduper.
						startOffset: range ? range.start * 1000 + i : i,
					},
					status: "survived" as const,
				})),
			};
		},
	};
	return { runner, calls };
}

describe("createShardedMutationRunner — fan-out", () => {
	it("splits one file across every available shard runner", async () => {
		const a = stubRunner({ "1-2": 1 });
		const b = stubRunner({ "3-4": 2 });
		const sharded = createShardedMutationRunner([a.runner, b.runner]);
		const out = await sharded.run("f.ts", CONTENT);
		expect(a.calls).toEqual(["1-2"]);
		expect(b.calls).toEqual(["3-4"]);
		expect(out.mutants).toHaveLength(3);
	});

	it("merges mutants from all shards into one result", async () => {
		const a = stubRunner({ "1-2": 2 });
		const b = stubRunner({ "3-4": 3 });
		const sharded = createShardedMutationRunner([a.runner, b.runner]);
		expect((await sharded.run("f.ts", CONTENT)).mutants).toHaveLength(5);
	});

	it("runs the whole file unsharded when only one runner is available", async () => {
		// No range is sent, not an explicit 1..N: that keeps a single-runner request
		// byte-identical to the pre-sharding path, so an older runner that knows
		// nothing about ranges behaves exactly as before.
		const only = stubRunner({ all: 4 });
		const sharded = createShardedMutationRunner([only.runner]);
		const out = await sharded.run("f.ts", CONTENT);
		expect(only.calls).toEqual(["all"]);
		expect(out.mutants).toHaveLength(4);
	});
});

describe("createShardedMutationRunner — deduplication", () => {
	it("reports one mutant once even when two shards both measure it", async () => {
		// Reachable whenever a runner ignores the range and measures the whole file.
		// Observed live as 12 real survivors rendered as 24.
		const same = () => ({
			available: () => true,
			run: async () => ({
				mutants: [
					{
						raw: { file: "f.ts", mutator: "M", originalLexeme: "x", replacement: "y", startOffset: 7 },
						status: "survived" as const,
					},
				],
			}),
		});
		const sharded = createShardedMutationRunner([same(), same()]);
		const out = await sharded.run("f.ts", CONTENT);
		expect(out.mutants).toHaveLength(1);
	});

	it("keeps genuinely distinct mutants at the same offset", async () => {
		// Same site, different replacement = different mutant. Must NOT collapse.
		const at = (replacement: string) => ({
			available: () => true,
			run: async () => ({
				mutants: [
					{
						raw: { file: "f.ts", mutator: "M", originalLexeme: "x", replacement, startOffset: 7 },
						status: "survived" as const,
					},
				],
			}),
		});
		const sharded = createShardedMutationRunner([at("y"), at("z")]);
		expect((await sharded.run("f.ts", CONTENT)).mutants).toHaveLength(2);
	});
});

describe("createShardedMutationRunner — fallback (a peer is down)", () => {
	it("still returns the surviving shard's findings when one shard throws", async () => {
		const good = stubRunner({ "1-2": 2 });
		const bad = stubRunner({}, ["3-4"]);
		const sharded = createShardedMutationRunner([good.runner, bad.runner]);
		const out = await sharded.run("f.ts", CONTENT);
		// Partial beats nothing: a survivor found in the healthy half is still real.
		expect(out.mutants).toHaveLength(2);
	});

	it("THROWS when every shard fails — never a forged clean pass", async () => {
		const a = stubRunner({}, ["1-2"]);
		const b = stubRunner({}, ["3-4"]);
		const sharded = createShardedMutationRunner([a.runner, b.runner]);
		await expect(sharded.run("f.ts", CONTENT)).rejects.toThrow();
	});

	it("skips runners reporting themselves unavailable", async () => {
		const up = stubRunner({ all: 1 });
		const down: MutationRunner = { available: () => false, run: vi.fn() };
		const sharded = createShardedMutationRunner([up.runner, down]);
		const out = await sharded.run("f.ts", CONTENT);
		expect(up.calls).toEqual(["all"]); // whole file — only one usable runner
		expect(down.run).not.toHaveBeenCalled();
		expect(out.mutants).toHaveLength(1);
	});

	it("is unavailable when no runner is available", () => {
		const down: MutationRunner = { available: () => false, run: vi.fn() };
		expect(createShardedMutationRunner([down]).available()).toBe(false);
	});

	it("is unavailable when constructed with no runners at all", () => {
		expect(createShardedMutationRunner([]).available()).toBe(false);
	});
});

describe("not-measurable propagation", () => {
	const nm = () => ({
		available: () => true,
		run: async () => {
			throw new MutationNotMeasurableError("no_tests");
		},
	});

	it("propagates the typed reason when every shard agrees there is nothing to measure", async () => {
		// Collapsing this into a generic failure is what made the gate report
		// "the mutation runner failed" for a file that simply had no test.
		const runner = createShardedMutationRunner([nm(), nm()]);
		await expect(runner.run("src/a.ts", "a\nb\nc\n", [])).rejects.toBeInstanceOf(MutationNotMeasurableError);
	});

	it("does NOT claim not-measurable when only some shards say so", async () => {
		const broken = {
			available: () => true,
			run: async () => {
				throw new Error("connection refused");
			},
		};
		const runner = createShardedMutationRunner([nm(), broken]);
		await expect(runner.run("src/a.ts", "a\nb\nc\n", [])).rejects.not.toBeInstanceOf(MutationNotMeasurableError);
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: a mutation run showed 30 survivors of 90 in this module —
// concentrated in the failure-reporting path and the testRun merge, i.e. the
// parts that only run when something has already gone wrong.
// ---------------------------------------------------------------------------

const mutant = (over: Record<string, unknown> = {}) => ({
	raw: { file: "f.ts", mutator: "M", originalLexeme: "x", replacement: "y", startOffset: 0, ...over },
	status: "survived" as const,
});
const okRunner = (mutants: Array<ReturnType<typeof mutant>>, testRun?: unknown): MutationRunner => ({
	available: () => true,
	// SAFETY: the stub returns exactly MutationRunOutput's two shapes; the cast
	// only avoids restating the adapter's mutant type in every fixture.
	run: async () => (testRun ? { mutants, testRun } : { mutants }) as never,
});
const failing = (message: string): MutationRunner => ({
	available: () => true,
	run: async () => {
		throw new Error(message);
	},
});

describe("ShardedRunFailure — the message is the only diagnosis a reader gets", () => {
	it("names how many shards failed", async () => {
		const r = createShardedMutationRunner([failing("boom-a"), failing("boom-b")]);
		await expect(r.run("f.ts", CONTENT, [])).rejects.toThrow(/2 mutation shard\(s\) failed/);
	});

	it("includes each shard's own reason, not just a count", async () => {
		const r = createShardedMutationRunner([failing("boom-a"), failing("boom-b")]);
		await expect(r.run("f.ts", CONTENT, [])).rejects.toThrow(/boom-a.*boom-b/s);
	});

	it("is identifiable by name so callers can branch on it", async () => {
		const r = createShardedMutationRunner([failing("x")]);
		await expect(r.run("f.ts", CONTENT, [])).rejects.toMatchObject({ name: "ShardedRunFailure" });
	});

	it("carries an empty pending list when every shard failed for a real reason", async () => {
		const r = createShardedMutationRunner([failing("x"), failing("y")]);
		await expect(r.run("f.ts", CONTENT, [])).rejects.toMatchObject({ pending: [] });
	});

	it("survives a rejection with no message rather than printing undefined", async () => {
		const weird: MutationRunner = {
			available: () => true,
			run: async () => {
				throw "just a string";
			},
		};
		await expect(createShardedMutationRunner([weird]).run("f.ts", CONTENT, [])).rejects.toThrow(
			/just a string/,
		);
	});
});

describe("testRun merge — a suite verdict describes the suite, not a line range", () => {
	it("propagates a shard's testRun to the merged result", async () => {
		const tr = { overlayGreen: true, redWitnessSatisfied: null };
		const r = createShardedMutationRunner([okRunner([mutant()], tr)]);
		expect((await r.run("f.ts", CONTENT, [])).testRun).toEqual(tr);
	});

	it("propagates a RED verdict — the case that must never be dropped", async () => {
		const red = { overlayGreen: false, redWitnessSatisfied: null };
		const r = createShardedMutationRunner([okRunner([], red), okRunner([mutant()])]);
		expect((await r.run("f.ts", CONTENT, [])).testRun).toEqual(red);
	});

	it("takes the verdict from whichever shard reported one", async () => {
		const tr = { overlayGreen: true, redWitnessSatisfied: null };
		const r = createShardedMutationRunner([okRunner([mutant()]), okRunner([mutant({ startOffset: 9 })], tr)]);
		expect((await r.run("f.ts", CONTENT, [])).testRun).toEqual(tr);
	});

	it("omits testRun entirely when no shard reported one", async () => {
		const r = createShardedMutationRunner([okRunner([mutant()])]);
		expect((await r.run("f.ts", CONTENT, [])).testRun).toBeUndefined();
	});
});

describe("dedup key — the separator is load-bearing here too", () => {
	it("does not merge two mutants whose fields concatenate alike", async () => {
		// ("ab","c") and ("a","bc") collide without a separator, and one real
		// survivor silently disappears from the merged report.
		const r = createShardedMutationRunner([
			okRunner([mutant({ mutator: "ab", replacement: "c" }), mutant({ mutator: "a", replacement: "bc" })]),
		]);
		expect((await r.run("f.ts", CONTENT, [])).mutants).toHaveLength(2);
	});

	it("treats the same mutator at different offsets as different findings", async () => {
		const r = createShardedMutationRunner([okRunner([mutant({ startOffset: 0 }), mutant({ startOffset: 7 })])]);
		expect((await r.run("f.ts", CONTENT, [])).mutants).toHaveLength(2);
	});
});

describe("availability", () => {
	it("is unavailable when every runner is", () => {
		const down: MutationRunner = { available: () => false, run: async () => ({ mutants: [] }) };
		expect(createShardedMutationRunner([down, down]).available()).toBe(false);
	});

	it("is available when even one runner is", () => {
		const down: MutationRunner = { available: () => false, run: async () => ({ mutants: [] }) };
		expect(createShardedMutationRunner([down, okRunner([])]).available()).toBe(true);
	});

	it("is unavailable with no runners at all", () => {
		expect(createShardedMutationRunner([]).available()).toBe(false);
	});

	it("throws rather than fabricating a pass when run with no usable runner", async () => {
		const down: MutationRunner = { available: () => false, run: async () => ({ mutants: [] }) };
		await expect(createShardedMutationRunner([down]).run("f.ts", CONTENT, [])).rejects.toThrow(
			/no mutation runner available/,
		);
	});
});

describe("empty content", () => {
	it("still makes one real whole-file attempt rather than reporting a clean pass", async () => {
		const seen: Array<unknown> = [];
		const spy: MutationRunner = {
			available: () => true,
			run: async (_f, _o, _ov, range) => {
				seen.push(range);
				return { mutants: [] };
			},
		};
		await createShardedMutationRunner([spy]).run("f.ts", "", []);
		expect(seen).toEqual([undefined]);
	});
});
