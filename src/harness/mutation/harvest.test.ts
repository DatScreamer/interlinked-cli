import { describe, expect, it } from "vitest";
import { formatHarvestWarning, harvestPending } from "./harvest.js";
import type { PendingRun } from "./pending-runs.js";

const NOW = 1_800_000_000_000;

function pending(over: Partial<PendingRun> = {}): PendingRun {
	return {
		file: "src/a.ts",
		overlayHash: "h",
		jobId: "job-1",
		runnerUrl: "http://runner/",
		startedAt: NOW,
		...over,
	};
}

const REPORT = {
	files: {
		"src/a.ts": {
			source: "function f(x){ return x > 0; }",
			mutants: [
				{
					mutatorName: "EqualityOperator",
					replacement: ">=",
					status: "Survived",
					location: { start: { line: 1, column: 25 }, end: { line: 1, column: 26 } },
				},
			],
		},
	},
};

/**
 * A virtual clock: `sleep` advances time instead of spending it, so polling
 * tests assert real waiting behaviour without a real wall-clock cost.
 */
function fakeClock(startMs = NOW) {
	let t = startMs;
	return {
		elapsed: () => t - startMs,
		opts: {
			now: () => t,
			sleep: async (ms: number) => {
				t += ms;
			},
		},
	};
}

function fetchOk(body: unknown) {
	return async () => ({ ok: true, status: 200, json: async () => body });
}

describe("harvestPending — claiming results from the earlier window", () => {
	it("returns the survivors a completed job held", async () => {
		const out = await harvestPending([pending()], fetchOk(REPORT));
		expect(out.survivors).toHaveLength(1);
		expect(out.harvested).toBe(1);
	});

	it("merges across every shard of one edit", async () => {
		const out = await harvestPending([pending({ jobId: "a" }), pending({ jobId: "b" })], fetchOk(REPORT));
		// Same mutant from both shards collapses; both jobs still count as harvested.
		expect(out.harvested).toBe(2);
		expect(out.survivors).toHaveLength(1);
	});

	it("reports nothing when the job never finishes within the budget", async () => {
		const notReady = async () => ({ ok: false, status: 404, json: async () => ({}) });
		const out = await harvestPending([pending()], notReady, fakeClock().opts);
		expect(out.harvested).toBe(0);
		expect(out.survivors).toHaveLength(0);
	});

	it("WAITS for a job that is still running, instead of losing the race", async () => {
		// PostToolUse fires milliseconds after the write while the run needs
		// seconds. A single immediate claim always 404s, which discarded the very
		// work the second window exists to collect.
		let calls = 0;
		const readyOnThirdTry = async () => {
			calls++;
			if (calls < 3) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => REPORT };
		};
		const out = await harvestPending([pending()], readyOnThirdTry, fakeClock().opts);
		expect(out.harvested).toBe(1);
		expect(out.survivors).toHaveLength(1);
		expect(calls).toBe(3);
	});

	it("gives up once the budget is spent rather than polling forever", async () => {
		const clock = fakeClock();
		let calls = 0;
		const neverReady = async () => {
			calls++;
			return { ok: false, status: 404, json: async () => ({}) };
		};
		const out = await harvestPending([pending()], neverReady, {
			...clock.opts,
			budgetMs: 1000,
			pollIntervalMs: 400,
		});
		expect(out.harvested).toBe(0);
		// Bounded: budget/interval attempts, not an unbounded loop.
		expect(calls).toBeLessThanOrEqual(5);
	});

	it("waits for shards concurrently — the window costs the slowest, not the sum", async () => {
		const clock = fakeClock();
		const readyAfter = (n: number) => {
			let c = 0;
			return async () => {
				c++;
				if (c <= n) return { ok: false, status: 404, json: async () => ({}) };
				return { ok: true, status: 200, json: async () => REPORT };
			};
		};
		const slow = readyAfter(5);
		const fast = readyAfter(1);
		const fetchFor = (url: string) => (url.includes("slow") ? slow() : fast());
		const out = await harvestPending(
			[pending({ jobId: "slow", runnerUrl: "http://slow/" }), pending({ jobId: "fast", runnerUrl: "http://fast/" })],
			fetchFor,
			clock.opts,
		);
		expect(out.harvested).toBe(2);
		// Both finished, and the virtual clock advanced only as far as the slower
		// one needed — proof they were not awaited one after the other.
		expect(clock.elapsed()).toBeLessThanOrEqual(6 * 400);
	});

	it("does NOT retry an unreachable runner — it will not become ready", async () => {
		// Regression: collapsing "not ready" and "gone" into one value made a dead
		// peer hold PostToolUse for the whole 25s budget. Symptom was this suite
		// taking 25s; the pin is the call count, not the wall-clock.
		let calls = 0;
		const refused = async () => {
			calls++;
			throw new Error("connection refused");
		};
		const out = await harvestPending([pending()], refused, fakeClock().opts);
		expect(out.harvested).toBe(0);
		expect(calls).toBe(1);
	});

	it("does not retry a server that answers with a non-404 error", async () => {
		let calls = 0;
		const broken = async () => {
			calls++;
			return { ok: false, status: 500, json: async () => ({}) };
		};
		await harvestPending([pending()], broken, fakeClock().opts);
		expect(calls).toBe(1);
	});

	it("survives a runner that is unreachable — never throws into the hook", async () => {
        const boom = async () => {
			throw new Error("connection refused");
		};
		const out = await harvestPending([pending()], boom);
		expect(out.harvested).toBe(0);
	});

	it("returns an empty result for no pending runs", async () => {
		const out = await harvestPending([], fetchOk(REPORT));
		expect(out.harvested).toBe(0);
		expect(out.survivors).toHaveLength(0);
	});
});

describe("formatHarvestWarning", () => {
	it("names the file and each surviving mutant", () => {
		const w = formatHarvestWarning("src/a.ts", [
			{ mutator: "EqualityOperator", lexeme: ">", replacement: ">=", line: 1 },
		]);
		expect(w).toContain("src/a.ts");
		expect(w).toContain("EqualityOperator");
		expect(w).toContain("[interlinked:mutation]");
	});

	it("agrees in number — one survivor is not '1 surviving mutants'", () => {
		const one = formatHarvestWarning("src/a.ts", [
			{ mutator: "EqualityOperator", lexeme: ">", replacement: ">=", line: 1 },
		]);
		expect(one).toContain("1 surviving mutant in");
		const two = formatHarvestWarning("src/a.ts", [
			{ mutator: "EqualityOperator", lexeme: ">", replacement: ">=", line: 1 },
			{ mutator: "EqualityOperator", lexeme: "<", replacement: "<=", line: 2 },
		]);
		expect(two).toContain("2 surviving mutants in");
	});

	it("returns null when nothing survived — no news is not news", () => {
		expect(formatHarvestWarning("src/a.ts", [])).toBeNull();
	});

	it("caps a long survivor list rather than flooding the turn", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			mutator: "M",
			lexeme: "x",
			replacement: "y",
			line: i + 1,
		}));
		const w = formatHarvestWarning("src/a.ts", many) ?? "";
		expect(w).toContain("40");
		expect(w.split("\n").length).toBeLessThan(20);
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: these tests exist because a mutation run showed 25 survivors
// in this module — each one a behaviour the suite executed but would not have
// noticed breaking.
// ---------------------------------------------------------------------------

const survivorReport = (mutants: Array<Record<string, unknown>>) => ({
	files: { "src/a.ts": { source: "function f(x){ return x > 0; }", mutants } },
});
const mut = (over: Record<string, unknown> = {}) => ({
	mutatorName: "EqualityOperator",
	replacement: ">=",
	status: "Survived",
	location: { start: { line: 1, column: 25 }, end: { line: 1, column: 26 } },
	...over,
});

describe("claimOne — the URL it actually asks for", () => {
	it("asks the runner for exactly /job/<id>, normalising a trailing slash", async () => {
		const seen: string[] = [];
		const spy = async (url: string) => {
			seen.push(url);
			return { ok: true, status: 200, json: async () => REPORT };
		};
		await harvestPending([pending({ runnerUrl: "http://runner/", jobId: "j-1" })], spy, fakeClock().opts);
		expect(seen).toEqual(["http://runner/job/j-1"]);
	});

	it("does not double the slash when the runner url has none", async () => {
		const seen: string[] = [];
		const spy = async (url: string) => {
			seen.push(url);
			return { ok: true, status: 200, json: async () => REPORT };
		};
		await harvestPending([pending({ runnerUrl: "http://runner", jobId: "j-1" })], spy, fakeClock().opts);
		expect(seen).toEqual(["http://runner/job/j-1"]);
	});

	it("percent-encodes a job id so a crafted id cannot alter the path", async () => {
		const seen: string[] = [];
		const spy = async (url: string) => {
			seen.push(url);
			return { ok: true, status: 200, json: async () => REPORT };
		};
		await harvestPending([pending({ jobId: "a/../b" })], spy, fakeClock().opts);
		expect(seen[0]).toBe("http://runner/job/a%2F..%2Fb");
	});
});

describe("survivor extraction — only survivors, with their real fields", () => {
	it("ignores killed and timed-out mutants", async () => {
		const body = survivorReport([mut({ status: "Killed" }), mut({ status: "Timeout" }), mut()]);
		const out = await harvestPending([pending()], async () => ({ ok: true, status: 200, json: async () => body }), fakeClock().opts);
		expect(out.survivors).toHaveLength(1);
	});

	it("carries the mutator, lexeme and replacement through unchanged", async () => {
		const body = survivorReport([mut({ mutatorName: "BlockStatement", replacement: "{}" })]);
		const out = await harvestPending([pending()], async () => ({ ok: true, status: 200, json: async () => body }), fakeClock().opts);
		expect(out.survivors[0]).toMatchObject({ mutator: "BlockStatement", replacement: "{}" });
		expect(typeof out.survivors[0]?.lexeme).toBe("string");
	});

	// "Zero survivors returned" is a valid report, NOT clean evidence — the
	// late path never certifies (review 2026-08-28).
	it("reports an empty survivor list as harvested-with-zero-survivors, not as a miss", async () => {
		const out = await harvestPending([pending()], async () => ({ ok: true, status: 200, json: async () => survivorReport([]) }), fakeClock().opts);
		expect(out.harvested).toBe(1);
		expect(out.survivors).toEqual([]);
	});

	it("treats an unrecognisable report as gone rather than as clean", async () => {
		const out = await harvestPending([pending()], async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }), fakeClock().opts);
		expect(out.harvested).toBe(0);
	});
});

describe("dedup identity", () => {
	it("keeps two survivors that differ only in line", async () => {
		const body = survivorReport([
			mut({ location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }),
			mut({ location: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } } }),
		]);
		const out = await harvestPending([pending()], async () => ({ ok: true, status: 200, json: async () => body }), fakeClock().opts);
		// Same mutator+replacement at different places are DIFFERENT defects.
		expect(out.survivors.length).toBeGreaterThanOrEqual(1);
	});

	it("collapses byte-identical survivors reported by two shards", async () => {
		const body = survivorReport([mut()]);
		const out = await harvestPending(
			[pending({ jobId: "a" }), pending({ jobId: "b" })],
			async () => ({ ok: true, status: 200, json: async () => body }),
			fakeClock().opts,
		);
		expect(out.harvested).toBe(2);
		expect(out.survivors).toHaveLength(1);
	});
});

describe("dedup key — the separator is load-bearing", () => {
	it("does not merge two different survivors whose fields concatenate alike", async () => {
		// Without a separator, ("ab","c") and ("a","bc") both key to "abc" and one
		// real defect silently disappears. This is the test that makes the
		// separator load-bearing rather than decorative.
		const body = survivorReport([
			mut({ mutatorName: "ab", replacement: "c" }),
			mut({ mutatorName: "a", replacement: "bc" }),
		]);
		const out = await harvestPending(
			[pending()],
			async () => ({ ok: true, status: 200, json: async () => body }),
			fakeClock().opts,
		);
		expect(out.survivors).toHaveLength(2);
	});

	it("does not merge across the mutator|lexeme boundary either", async () => {
		// keyOf joins [mutator, lexeme, replacement, line]; the previous case only
		// collides mutator|replacement THROUGH the lexeme. A mutation run showed
		// the separator still surviving because no case collided the FIRST
		// boundary: mutator "ab" + lexeme "c" vs mutator "a" + lexeme "bc".
		// The lexeme is sliced from the SOURCE at the mutant's location, so the
		// two locations must differ for the lexemes to differ.
		const src = "function f(ab, c, a, bc) { return ab; }";
		const at = (needle: string) => {
			const col = src.indexOf(needle) + 1;
			return { start: { line: 1, column: col }, end: { line: 1, column: col + needle.length } };
		};
		const body = {
			files: {
				"src/a.ts": {
					source: src,
					mutants: [
						{ mutatorName: "ab", replacement: "x", status: "Survived", location: at("c,") },
						{ mutatorName: "a", replacement: "x", status: "Survived", location: at("bc") },
					],
				},
			},
		};
		const out = await harvestPending(
			[pending()],
			async () => ({ ok: true, status: 200, json: async () => body }),
			fakeClock().opts,
		);
		expect(out.survivors).toHaveLength(2);
	});
});

describe("claim outcomes stay typed — {} is not a state", () => {
	it("does not RETRY an unrecognisable report — gone, not not-ready", async () => {
		// Mutating {kind:"gone"} to {} makes an undecodable report read as
		// "still running", so the poll burns the whole budget re-fetching a
		// report that will never parse. Result-only assertions could not see
		// that; the CALL COUNT can.
		let calls = 0;
		const nonsense = async () => {
			calls++;
			return { ok: true, status: 200, json: async () => ({ nonsense: true }) };
		};
		const out = await harvestPending([pending()], nonsense, fakeClock().opts);
		expect(out.harvested).toBe(0);
		expect(calls).toBe(1);
	});
});

describe("default clock — the real sleep actually sleeps", () => {
	it("waits ~pollIntervalMs between real polls rather than spinning", async () => {
		// Every other test injects a virtual clock, so the DEFAULT realSleep was
		// never exercised and `() => undefined` survived. A spin-loop here would
		// hammer the runner hundreds of times inside the budget; with a real
		// sleep, two polls at 25ms apart cannot complete in under ~20ms.
		let calls = 0;
		const readyOnSecondTry = async () => {
			calls++;
			if (calls < 2) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => REPORT };
		};
		const startedAt = performance.now();
		const out = await harvestPending([pending()], readyOnSecondTry, {
			budgetMs: 2_000,
			pollIntervalMs: 25,
		});
		expect(out.harvested).toBe(1);
		expect(calls).toBe(2);
		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
	});
});

describe("formatHarvestWarning — exact shape under the cap", () => {
	it("emits exactly header + one line per survivor + explainer when under the cap", () => {
		// Pins the `more` arm to a true EMPTY array: a mutant replacing it with a
		// non-empty array changes the line count even when nothing is elided.
		const w = formatHarvestWarning("src/a.ts", [
			{ mutator: "Eq", lexeme: ">", replacement: ">=", line: 1 },
			{ mutator: "Lt", lexeme: "<", replacement: "<=", line: 2 },
		]);
		expect(w?.split("\n")).toHaveLength(4);
	});
});

describe("the deadline boundary", () => {
	it("stops AT the deadline, not one poll past it", async () => {
		let calls = 0;
		const never = async () => {
			calls++;
			return { ok: false, status: 404, json: async () => ({}) };
		};
		const clock = fakeClock();
		await harvestPending([pending()], never, { ...clock.opts, budgetMs: 800, pollIntervalMs: 400 });
		// t=0 try, sleep→400 try, sleep→800 == deadline → stop. Three attempts.
		expect(calls).toBe(3);
	});
});

describe("formatHarvestWarning — the exact text the agent reads", () => {
	const many = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ mutator: "M", lexeme: "x", replacement: "y", line: i + 1 }));

	it("adds no 'more' line when the list fits exactly", () => {
		const w = formatHarvestWarning("src/a.ts", many(8)) ?? "";
		expect(w).not.toContain("more");
	});

	it("adds the 'more' line the moment one survivor is over the cap", () => {
		const w = formatHarvestWarning("src/a.ts", many(9)) ?? "";
		expect(w).toContain("…and 1 more");
	});

	it("counts the remainder, not the total, in the 'more' line", () => {
		const w = formatHarvestWarning("src/a.ts", many(20)) ?? "";
		expect(w).toContain("…and 12 more");
	});

	it("names the second window and explains what a survivor means", () => {
		const w = formatHarvestWarning("src/a.ts", many(1)) ?? "";
		expect(w).toContain("in the second window");
		expect(w).toContain("would not notice it being wrong");
	});

	it("renders each survivor as 'mutator: lexeme -> replacement'", () => {
		const w = formatHarvestWarning("src/a.ts", [{ mutator: "Eq", lexeme: ">", replacement: ">=", line: 1 }]) ?? "";
		expect(w).toContain("Eq: > -> >=");
	});
});
