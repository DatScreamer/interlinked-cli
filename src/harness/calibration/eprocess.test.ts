import { describe, expect, it } from "vitest";
import {
	alarmThreshold,
	createEProcess,
	type EProcessConfig,
	eValue,
	isAnomalous,
	observe,
	runEProcess,
	summarize,
} from "./eprocess.js";

const CFG: EProcessConfig = { p0: 0.05, p1: 0.3, alpha: 0.05 };

describe("e-process — basics", () => {
	it("starts at e-value 1 (logE 0)", () => {
		const s = createEProcess();
		expect(s.logE).toBe(0);
		expect(eValue(s)).toBeCloseTo(1);
		expect(s.n).toBe(0);
	});

	it("a positive raises the e-value, a negative lowers it", () => {
		const up = observe(createEProcess(), true, CFG);
		const down = observe(createEProcess(), false, CFG);
		expect(up.logE).toBeGreaterThan(0);
		expect(down.logE).toBeLessThan(0);
		expect(up.positives).toBe(1);
		expect(down.positives).toBe(0);
	});

	it("alarm threshold is 1/alpha", () => {
		expect(alarmThreshold(CFG)).toBeCloseTo(20);
	});
});

describe("e-process — validity of alarms", () => {
	it("does NOT alarm on a stream at the baseline rate (H0 holds)", () => {
		// ~1 positive in 20 ≈ p0=0.05.
		const obs = [true, ...Array(19).fill(false)];
		const s = runEProcess(obs, CFG);
		expect(isAnomalous(s, CFG)).toBe(false);
	});

	it("does NOT alarm on an all-negative stream (strong evidence for H0)", () => {
		const s = runEProcess(Array(30).fill(false), CFG);
		expect(isAnomalous(s, CFG)).toBe(false);
		expect(eValue(s)).toBeLessThan(1);
	});

	it("ALARMS on a stream whose rate is far above baseline (H1)", () => {
		// 10 positives in 12 ≫ p0 → e-value blows past 20.
		const obs = [...Array(10).fill(true), false, false];
		const s = runEProcess(obs, CFG);
		expect(isAnomalous(s, CFG)).toBe(true);
		expect(eValue(s)).toBeGreaterThan(20);
	});

	it("alarms exactly when logE crosses -log(alpha)", () => {
		const s = { logE: -Math.log(0.05) + 1e-6, n: 5, positives: 5 };
		expect(isAnomalous(s, CFG)).toBe(true);
		const below = { logE: -Math.log(0.05) - 1e-6, n: 5, positives: 5 };
		expect(isAnomalous(below, CFG)).toBe(false);
	});
});

describe("e-process — config normalization (fail-safe)", () => {
	it("corrects a p1 ≤ p0 to a valid alternative above p0", () => {
		// A misconfigured bet must not crash or invert; a positive still raises E.
		const bad: EProcessConfig = { p0: 0.4, p1: 0.1 };
		const s = observe(createEProcess(), true, bad);
		expect(Number.isFinite(s.logE)).toBe(true);
		expect(s.logE).toBeGreaterThan(0);
	});

	it("defaults an out-of-range alpha to 0.05", () => {
		expect(alarmThreshold({ p0: 0.05, p1: 0.3, alpha: 5 })).toBeCloseTo(20);
	});

	it("tolerates rates at the 0/1 boundary without NaN/Infinity", () => {
		const s = observe(createEProcess(), true, { p0: 0, p1: 1 });
		expect(Number.isFinite(s.logE)).toBe(true);
	});
});

describe("e-process — summary", () => {
	it("reports the empirical rate and verdict", () => {
		const s = runEProcess([true, true, false, false], CFG);
		const sum = summarize(s, CFG);
		expect(sum.n).toBe(4);
		expect(sum.positives).toBe(2);
		expect(sum.empiricalRate).toBeCloseTo(0.5);
		expect(sum.threshold).toBeCloseTo(20);
		expect(typeof sum.anomalous).toBe("boolean");
	});
});
