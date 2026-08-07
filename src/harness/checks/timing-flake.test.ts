import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTimingFlake } from "./timing-flake.js";

const F = "src/thing.test.ts";

/** Every `*.test.ts` under src/, for the dogfood corpus case below. */
function allTestFiles(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (!/node_modules/.test(p)) allTestFiles(p, out);
		} else if (/\.test\.ts$/.test(p)) out.push(p);
	}
	return out;
}

describe("checkTimingFlake — positive (must fire)", () => {
	it("P1: flags a fixed sleep followed by an assertion", () => {
		// The real shape from tsgo-runner-watch.test.ts: wait a guessed duration
		// for a spawned subprocess, then assert on what it produced.
		const src = [
			'it("reads subprocess output", async () => {',
			"  wp.start();",
			"  await sleep(300);",
			"  expect(internal.passInProgress).toBe(false);",
			"});",
		].join("\n");
		const hits = checkTimingFlake(src, F);
		expect(hits.length).toBe(1);
		expect(hits[0]?.line).toBe(3);
		expect(hits[0]?.text).toContain("300ms");
	});

	it("P2: flags a bare setTimeout-based wait before an assertion", () => {
		const src = [
			'it("waits", async () => {',
			"  await new Promise((r) => setTimeout(r, 250));",
			"  expect(out).toEqual([1]);",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F).length).toBe(1);
	});

	it("P3: flags each of several independent fixed waits", () => {
		const src = [
			'it("a", async () => {',
			"  await sleep(200);",
			"  expect(a).toBe(1);",
			"});",
			'it("b", async () => {',
			"  await delay(500);",
			"  expect(b).toBe(2);",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F).length).toBe(2);
	});
});

describe("checkTimingFlake — negative (must not fire)", () => {
	it("N1: does not fire when the test polls for the condition", () => {
		// The fix applied to tsgo-runner-watch.test.ts — the ceiling bounds only
		// failure, so load cannot turn a correct run into a failure.
		const src = [
			'it("reads subprocess output", async () => {',
			"  const deadline = Date.now() + 10_000;",
			"  while (Date.now() < deadline && !done()) {",
			"    await sleep(25);",
			"  }",
			"  expect(done()).toBe(true);",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F)).toEqual([]);
	});

	it("N2: does not fire when the file controls the clock with fake timers", () => {
		const src = [
			"vi.useFakeTimers();",
			'it("debounces", async () => {',
			"  await sleep(1000);",
			"  expect(calls).toBe(1);",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F)).toEqual([]);
	});

	it("N3: does not fire for a short event-loop yield", () => {
		const src = ['it("yields", async () => {', "  await sleep(5);", "  expect(x).toBe(1);", "});"].join(
			"\n",
		);
		expect(checkTimingFlake(src, F)).toEqual([]);
	});

	it("N4: does not fire when the wait is not followed by an assertion", () => {
		const src = [
			'it("just settles", async () => {',
			"  await sleep(300);",
			"  await teardown();",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F)).toEqual([]);
	});

	it("N5: does not blame a wait in one test for an assertion in the next", () => {
		const src = [
			'it("a", async () => {',
			"  await sleep(300);",
			"});",
			'it("b", () => {',
			"  expect(b).toBe(2);",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F)).toEqual([]);
	});

	it("N6: does not fire outside test files", () => {
		const src = ["async function poll() {", "  await sleep(300);", "  expect(x).toBe(1);", "}"].join(
			"\n",
		);
		expect(checkTimingFlake(src, "src/thing.ts")).toEqual([]);
	});

	it("C1: corpus — reports the tree's real fixed-wait count without exploding", () => {
		// Calibration case, per the Check Evidence Contract: a detector tuned only
		// against hand-written fixtures can be wildly miscalibrated against real
		// code (`halstead_difficulty` shipped at a ceiling that fired 2226 times
		// before recalibration). This pins the actual repo-wide count so a future
		// loosening of the regexes shows up as a diff rather than as silent noise.
		const files = allTestFiles("src");
		expect(files.length).toBeGreaterThan(500);
		const hits = files.flatMap((f) => checkTimingFlake(readFileSync(f, "utf8"), f));
		// Deep-audit cadence, not a per-edit gate: a handful across ~1100 test
		// files is a reviewable list. A jump into the hundreds means the detector
		// broke, not that the repo did.
		expect(hits.length).toBeLessThan(60);
	});

	it("N7: does not fire for a duration read from a named constant", () => {
		// A named window is a documented decision, not a scheduling guess.
		const src = [
			'it("expires", async () => {',
			"  await sleep(TTL_MS);",
			"  expect(cache.get(k)).toBeUndefined();",
			"});",
		].join("\n");
		expect(checkTimingFlake(src, F)).toEqual([]);
	});
});
