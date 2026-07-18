import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	benchPointsFrom,
	benchRegressions,
	fuzzFailuresFrom,
	readHeavyReports,
} from "./session-start-heavy-reports.js";

describe("fuzzFailuresFrom", () => {
	it("extracts failed count and failed file names", () => {
		const r = {
			numFailedTests: 2,
			testResults: [
				{ status: "failed", name: "src/a.test.ts" },
				{ status: "passed", name: "src/b.test.ts" },
				{ status: "failed", name: "src/c.test.ts" },
			],
		};
		expect(fuzzFailuresFrom(r)).toEqual({ failed: 2, files: ["src/a.test.ts", "src/c.test.ts"] });
	});
	it("is safe on junk input", () => {
		expect(fuzzFailuresFrom(null)).toEqual({ failed: 0, files: [] });
		expect(fuzzFailuresFrom({})).toEqual({ failed: 0, files: [] });
	});
});

describe("benchPointsFrom", () => {
	it("recursively collects {name, mean} points from a nested shape", () => {
		const r = { files: [{ groups: [{ benchmarks: [{ name: "hot", mean: 1.5 }] }] }] };
		expect(benchPointsFrom(r).get("hot")).toBe(1.5);
	});
});

describe("benchRegressions", () => {
	it("flags a mean rising past the 20% threshold", () => {
		const cur = new Map([
			["slow", 1.3],
			["stable", 1.05],
			["new", 2.0],
		]);
		const out = benchRegressions({ slow: 1.0, stable: 1.0 }, cur);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("slow");
	});
});

describe("readHeavyReports", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "heavy-reports-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeReport(kind: "fuzz" | "bench", name: string, data: unknown): void {
		const dir = join(cwd, ".interlinked", `${kind}-reports`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), JSON.stringify(data));
	}

	it("surfaces fuzz failures, records them, and consumes the report", () => {
		writeReport("fuzz", "s1.json", { numFailedTests: 1, testResults: [{ status: "failed", name: "p.test.ts" }] });
		let recorded = 0;
		const warnings = readHeavyReports(cwd, (n) => {
			recorded = n;
		});
		expect(warnings.some((w) => w.includes("[interlinked:fuzz]") && w.includes("p.test.ts"))).toBe(true);
		expect(recorded).toBe(1);
		// consumed
		expect(existsSync(join(cwd, ".interlinked", "fuzz-reports", "s1.json"))).toBe(false);
	});

	it("returns no fuzz warning when the run passed", () => {
		writeReport("fuzz", "s2.json", { numFailedTests: 0, testResults: [] });
		expect(readHeavyReports(cwd)).toEqual([]);
	});

	it("surfaces a bench regression vs a stored baseline and updates it", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, ".interlinked", "bench-baseline.json"), JSON.stringify({ hot: 1.0 }));
		writeReport("bench", "s3.json", { benchmarks: [{ name: "hot", mean: 1.5 }] });
		const warnings = readHeavyReports(cwd);
		expect(warnings.some((w) => w.includes("[interlinked:bench]") && w.includes("hot"))).toBe(true);
		// baseline updated to the new run
		expect(JSON.parse(readFileSync(join(cwd, ".interlinked", "bench-baseline.json"), "utf-8")).hot).toBe(1.5);
	});

	it("returns [] and never throws when there are no reports", () => {
		expect(readHeavyReports(cwd)).toEqual([]);
	});
});
