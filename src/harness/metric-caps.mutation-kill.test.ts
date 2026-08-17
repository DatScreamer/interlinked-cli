// Targeted mutation-kill cases for src/harness/metric-caps.ts survivors.
// See scratch/fleet-r3/CONTRACT-W6.md (LEAN MODE) and
// scratch/fleet-r3/receipts/src_harness_metric-caps.ts.jsonl for the full
// per-mutant disposition (including suspected-equivalent structural
// arguments for mutants with no test here).
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeMetricForAgent,
	loadMetricCaps,
	METRIC_CAPS_REL,
	metricDef,
	resetMetricCapsCache,
} from "./metric-caps.js";

function writeCaps(cwd: string, obj: unknown): void {
	writeFileSync(join(cwd, METRIC_CAPS_REL), JSON.stringify(obj), "utf8");
}

describe("metric-caps — mutation-kill", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metric-caps-mk-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		resetMetricCapsCache();
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		resetMetricCapsCache();
	});

	describe("describeMetricForAgent — exact message assembly", () => {
		// test-contract: public-api — the message is the agent-facing contract
		// ("no agent ever confused about what these metrics are", module header);
		// every word/word-order/punctuation choice in the assembly is load-bearing,
		// so pin the FULL string, not a substring, for a "lower" (cap-worded) metric.
		it("assembles the exact 'lower is stricter' (cap) sentence for lines", () => {
			const d = metricDef("lines");
			const msg = describeMetricForAgent("lines", 500);
			expect(msg).toBe(
				`What "lines" means: ${d.definition} ` +
					`Current cap: 500 lines (lower is stricter; configurable — ${d.howToConfigure}). ` +
					`Fix: ${d.fixHint}`,
			);
		});

		// test-contract: public-api — same assembly, opposite branch: a "higher"
		// (floor-worded) metric must say "floor", not "cap", and use its own unit.
		it("assembles the exact 'higher is stricter' (floor) sentence for coverage", () => {
			const d = metricDef("coverage");
			const msg = describeMetricForAgent("coverage", 80);
			expect(msg).toBe(
				`What "coverage" means: ${d.definition} ` +
					`Current floor: 80 % (higher is stricter; configurable — ${d.howToConfigure}). ` +
					`Fix: ${d.fixHint}`,
			);
		});
	});

	describe("loadMetricCaps — cache correctness", () => {
		// test-contract: invariant — a genuinely absent file must be re-evaluated
		// every call, never papered over by a stale/mis-keyed cache entry; two
		// consecutive reads of a still-absent file each produce their OWN fresh
		// {} (never a reused cached reference from a phantom "file existed" state).
		it("an absent file returns a fresh {} object on every call, never a cached reference", () => {
			const a = loadMetricCaps(cwd);
			const b = loadMetricCaps(cwd);
			expect(a).toEqual({});
			expect(b).toEqual({});
			expect(b).not.toBe(a);
		});

		// test-contract: boundary — mtimeMs is a valid (non-negative) timestamp at
		// exactly the Unix epoch; a file legitimately timestamped at mtime 0 is
		// still "present" and must be parsed normally, not treated as absent.
		it("an mtime of exactly epoch-zero is still read as present", () => {
			writeCaps(cwd, { max_cyclomatic: 11 });
			utimesSync(join(cwd, METRIC_CAPS_REL), 0, 0);
			expect(loadMetricCaps(cwd).max_cyclomatic).toBe(11);
		});

		// test-contract: invariant — the module docstring promises "repeated
		// hot-path calls stay ~free" via an mtime-aware cache; two calls with an
		// unchanged mtime must return the SAME object reference (served from
		// cache), not a freshly re-parsed (merely deep-equal) one.
		it("two reads at an unchanged mtime return the identical cached object reference", () => {
			writeCaps(cwd, { max_cyclomatic: 9 });
			const a = loadMetricCaps(cwd);
			const b = loadMetricCaps(cwd);
			expect(a).toEqual({ max_cyclomatic: 9 });
			expect(b).toBe(a);
		});
	});

	describe("normalizeOverrides (via loadMetricCaps) — validation boundaries", () => {
		// test-contract: boundary — the module comment states caps "must be
		// strictly positive"; an explicit 0 must be dropped for every
		// lower-is-stricter cap, and a genuinely valid positive override must
		// still take effect (both directions of the same > 0 boundary).
		it("a cap of exactly 0 is dropped for lines/cyclomatic/cognitive; a valid positive cognitive override is kept", () => {
			writeCaps(cwd, { max_lines: 0, max_cyclomatic: 0, max_cognitive: 0 });
			const zeroed = loadMetricCaps(cwd);
			expect(zeroed.max_lines).toBeUndefined();
			expect(zeroed.max_cyclomatic).toBeUndefined();
			expect(zeroed.max_cognitive).toBeUndefined();

			writeCaps(cwd, { max_cognitive: 12 });
			resetMetricCapsCache();
			expect(loadMetricCaps(cwd).max_cognitive).toBe(12);
		});

		// test-contract: boundary — min_coverage has no secondary ">0" gate (0 is
		// a valid floor), so an omitted key must leave the property genuinely
		// ABSENT, not present-with-value-undefined (distinguishable only via key
		// presence, since both read back as `undefined` through property access).
		it("an omitted min_coverage key is absent from the result, not set to undefined", () => {
			writeCaps(cwd, { max_lines: 100 });
			const o = loadMetricCaps(cwd);
			expect("min_coverage" in o).toBe(false);
		});

		// test-contract: boundary — readPositive's own type/sign guard is the
		// only thing protecting min_coverage (no downstream >0 re-check like the
		// other four caps have); a numeric-LOOKING string must not be coerced,
		// and a negative number must not slip through as a valid floor.
		it("min_coverage drops a numeric-looking string and a negative number", () => {
			writeCaps(cwd, { min_coverage: "5" });
			expect(loadMetricCaps(cwd).min_coverage).toBeUndefined();

			writeCaps(cwd, { min_coverage: -5 });
			resetMetricCapsCache();
			expect(loadMetricCaps(cwd).min_coverage).toBeUndefined();
		});
	});

	describe("resetMetricCapsCache — actually clears", () => {
		// test-contract: public-api — the exported reset function's entire
		// contract is "the next read re-evaluates from disk"; a stale in-memory
		// entry for an unchanged file must not survive a reset (else `interlinked
		// caps set` would appear to not take effect without a daemon restart).
		it("a stale cache entry is not reused after reset, even at an unchanged mtime", () => {
			writeCaps(cwd, { max_cyclomatic: 7 });
			const a = loadMetricCaps(cwd);
			expect(a.max_cyclomatic).toBe(7);

			resetMetricCapsCache();
			const b = loadMetricCaps(cwd);
			expect(b).not.toBe(a);
			expect(b.max_cyclomatic).toBe(7);
		});
	});
});
