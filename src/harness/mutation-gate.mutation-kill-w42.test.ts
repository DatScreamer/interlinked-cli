import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Named exports of "node:fs" are non-configurable, so `vi.spyOn` on the
// namespace throws. Wrap the real implementations in vi.fn() at mock time
// instead so calls/args are still observable via vi.mocked(...).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

import * as fs from "node:fs";
import {
	compareMutation,
	emptyMutationBaseline,
	loadMutationBaseline,
	loadMutationReport,
	mutationBaselinePath,
	saveMutationBaseline,
	type MutationBaseline,
	type MutationReport,
} from "./mutation-gate.js";
import type { MutationGateConfig } from "./check-policy.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mutation-gate-w42-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	vi.mocked(fs.readFileSync).mockClear();
	vi.mocked(fs.writeFileSync).mockClear();
});

// SAFETY: MutationGateConfig only requires min_score for these tests; the
// cast avoids constructing the rest of the real config shape.
const baseConfig: MutationGateConfig = { min_score: 0 } as MutationGateConfig;

// ---------------------------------------------------------------------------
// parseMutationBaseline (symbol c3e8bffbe058bfd5) via loadMutationBaseline
// ---------------------------------------------------------------------------

describe("parseMutationBaseline — positive (must fire)", () => {
	it("drops a per-file entry whose stats value is null instead of discarding the whole baseline (kills e6c8bb7135710c1b)", () => {
		const path = mutationBaselinePath(tmpDir);
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updated_at: "2020-01-01T00:00:00.000Z",
				files: {
					"a.ts": { score: 0.9, killed: 9 },
					"bad.ts": null,
				},
			}),
			"utf-8",
		);
		const baseline = loadMutationBaseline(tmpDir);
		// The valid entry must survive; destructuring `null` must not throw and
		// wipe the whole baseline via the outer catch.
		expect(baseline.files["a.ts"]).toEqual({ score: 0.9, killed: 9 });
		expect(baseline.files["bad.ts"]).toBeUndefined();
	});

	it("drops an entry whose killed field is not a number (kills 4b3d273755073791)", () => {
		const path = mutationBaselinePath(tmpDir);
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				updated_at: "2020-01-01T00:00:00.000Z",
				files: {
					"good.ts": { score: 0.5, killed: 5 },
					"x.ts": { score: 0.5, killed: "nine" },
				},
			}),
			"utf-8",
		);
		const baseline = loadMutationBaseline(tmpDir);
		expect(baseline.files["good.ts"]).toEqual({ score: 0.5, killed: 5 });
		expect(baseline.files["x.ts"]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// loadMutationBaseline (symbol a3a9c139c404969d)
// ---------------------------------------------------------------------------

describe("loadMutationBaseline — positive (must fire)", () => {
	it("does not attempt to read a file that does not exist (kills aacac8418f83115c)", () => {
		const readSpy = vi.mocked(fs.readFileSync);
		const path = mutationBaselinePath(tmpDir);
		expect(fs.existsSync(path)).toBe(false);
		const baseline = loadMutationBaseline(tmpDir);
		expect(baseline).toEqual(emptyMutationBaseline());
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("reads the baseline file with utf-8 encoding (kills 8acb45baf977b51c)", () => {
		const path = mutationBaselinePath(tmpDir);
		fs.mkdirSync(tmpDir, { recursive: true });
		const stored: MutationBaseline = {
			version: 1,
			updated_at: "2020-01-01T00:00:00.000Z",
			files: { "foo.ts": { score: 0.75, killed: 3 } },
		};
		fs.writeFileSync(path, JSON.stringify(stored), "utf-8");
		const readSpy = vi.mocked(fs.readFileSync);
		const baseline = loadMutationBaseline(tmpDir);
		expect(readSpy).toHaveBeenCalledWith(path, "utf-8");
		expect(baseline.files["foo.ts"]).toEqual({ score: 0.75, killed: 3 });
	});
});

// ---------------------------------------------------------------------------
// saveMutationBaseline (symbol eb7bdab28f63cde6)
// ---------------------------------------------------------------------------

describe("saveMutationBaseline — positive (must fire)", () => {
	it("writes the baseline file with utf-8 encoding (kills 15cbb007c8e49399)", () => {
		const writeSpy = vi.mocked(fs.writeFileSync);
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2020-01-01T00:00:00.000Z",
			files: { "bar.ts": { score: 0.6, killed: 6 } },
		};
		saveMutationBaseline(tmpDir, baseline);
		const path = mutationBaselinePath(tmpDir);
		expect(writeSpy).toHaveBeenCalledWith(path, expect.stringContaining("bar.ts"), "utf-8");
		const roundTripped = loadMutationBaseline(tmpDir);
		expect(roundTripped.files["bar.ts"]).toEqual({ score: 0.6, killed: 6 });
	});
});

// ---------------------------------------------------------------------------
// loadMutationReport (symbol fbb01ce1a605927c)
// ---------------------------------------------------------------------------

describe("loadMutationReport — positive (must fire)", () => {
	it("does not attempt to read a report path that does not exist (kills e76a755152bf2c6a)", () => {
		const readSpy = vi.mocked(fs.readFileSync);
		const reportPath = join(tmpDir, "does-not-exist.json");
		const result = loadMutationReport(reportPath);
		expect(result).toBeNull();
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("reads the report file with utf-8 encoding (kills e43045d960e2321e)", () => {
		const reportPath = join(tmpDir, "report.json");
		fs.writeFileSync(reportPath, JSON.stringify({ files: { "a.ts": { killed: 1, survived: 0 } } }), "utf-8");
		const readSpy = vi.mocked(fs.readFileSync);
		const report = loadMutationReport(reportPath);
		expect(readSpy).toHaveBeenCalledWith(reportPath, "utf-8");
		expect(report?.files["a.ts"]).toEqual({ killed: 1, survived: 0 });
	});
});

// ---------------------------------------------------------------------------
// normalizeMutationReport / aggregateMutants (symbols 60477eca1aba80f0, 6c74eb8a7e01581a)
// via loadMutationReport
// ---------------------------------------------------------------------------

function writeReportAndLoad(tmp: string, body: unknown): MutationReport | null {
	const reportPath = join(tmp, "report.json");
	fs.writeFileSync(reportPath, JSON.stringify(body), "utf-8");
	return loadMutationReport(reportPath);
}

describe("normalizeMutationReport nullish-coalescing fields — positive (must fire)", () => {
	it("defaults survived to 0 when absent (kills 1f5dbf06676a1521)", () => {
		const report = writeReportAndLoad(tmpDir, { files: { "a.ts": { killed: 5 } } });
		expect(report?.files["a.ts"]?.survived).toBe(0);
	});

	it("falls back from no_coverage to noCoverage (kills 59fad006087850e9)", () => {
		const report = writeReportAndLoad(tmpDir, {
			files: { "a.ts": { killed: 1, survived: 0, noCoverage: 3 } },
		});
		expect(report?.files["a.ts"]?.no_coverage).toBe(3);
	});

	it("falls back from compile_error to compileError (kills f09a88fa7dc348b7)", () => {
		const report = writeReportAndLoad(tmpDir, {
			files: { "a.ts": { killed: 1, survived: 0, compileError: 2 } },
		});
		expect(report?.files["a.ts"]?.compile_error).toBe(2);
	});

	it("falls back from runtime_error to runtimeError (kills 2c110c892831dc3b)", () => {
		const report = writeReportAndLoad(tmpDir, {
			files: { "a.ts": { killed: 1, survived: 0, runtimeError: 4 } },
		});
		expect(report?.files["a.ts"]?.runtime_error).toBe(4);
	});
});

describe("aggregateMutants timeout counting — positive (must fire)", () => {
	it("counts repeated timeout mutants correctly by accumulating on the defined value (kills 8f7ddd7c594b8ddf)", () => {
		const report = writeReportAndLoad(tmpDir, {
			files: {
				"a.ts": {
					mutants: [{ status: "Timeout" }, { status: "Timeout" }],
				},
			},
		});
		// First increment: (0 ?? 0) + 1 = 1. Second: (1 ?? 0) + 1 = 2.
		// The `&&` mutant computes (1 && 0) + 1 = 1 on the second increment.
		expect(report?.files["a.ts"]?.timeout).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// normalizePath (symbol e79f7f4e37d9ce05) via compareMutation
// ---------------------------------------------------------------------------

describe("normalizePath — positive (must fire)", () => {
	it("converts backslashes to forward slashes rather than stripping them (kills 0f05850cc0911282)", () => {
		const repoRoot = "/some/root";
		const report: MutationReport = { files: { "a\\b.ts": { killed: 1, survived: 0 } } };
		const baseline = emptyMutationBaseline();
		const result = compareMutation(report, baseline, { config: baseConfig, repoRoot });
		const keys = Object.keys(result.nextBaseline.files);
		expect(keys).toContain("a/b.ts");
		expect(keys).not.toContain("ab.ts");
	});

	it("excludes an entry whose normalized relative path is empty (kills bc716d15de9bb161 and 8b9131bc80797b13)", () => {
		const repoRoot = "/some/root";
		// "." resolves to repoRoot itself, so relative(repoRoot, repoRoot) === "".
		const report: MutationReport = { files: { ".": { killed: 1, survived: 0 } } };
		const baseline = emptyMutationBaseline();
		const result = compareMutation(report, baseline, { config: baseConfig, repoRoot });
		expect(result.stats.files_checked).toBe(0);
		expect(result.nextBaseline.files[""]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// compareMutation (symbol ceb2f9e2226d3c6c)
// ---------------------------------------------------------------------------

describe("compareMutation — positive (must fire)", () => {
	it("preserves untouched baseline files via the initial spread (kills cb1c7867335ce2e3)", () => {
		const repoRoot = "/repo";
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2020-01-01T00:00:00.000Z",
			files: { "other.ts": { score: 0.9, killed: 9 } },
		};
		const report: MutationReport = { files: {} };
		const result = compareMutation(report, baseline, { config: baseConfig, repoRoot });
		expect(result.nextBaseline.files["other.ts"]).toEqual({ score: 0.9, killed: 9 });
	});

	it("reports baseline_score 0 for a below-floor new file with no prior entry (kills 41e14999e08509c6)", () => {
		const repoRoot = "/repo";
		// SAFETY: only min_score is read by compareMutation's floor check.
		const config: MutationGateConfig = { min_score: 0.9 } as MutationGateConfig;
		const report: MutationReport = { files: { "new.ts": { killed: 1, survived: 1 } } }; // score 0.5
		const baseline = emptyMutationBaseline();
		const result = compareMutation(report, baseline, { config, repoRoot });
		const finding = result.findings.find((f) => f.name === "mutation_score_below_floor");
		expect(finding).toBeDefined();
		expect(finding?.baseline_score).toBe(0);
	});

	it("builds the exact below-floor message text (kills eb48519cb42bba08, 5ae9654b0a65776d, 2f9170dab0f33d04)", () => {
		const repoRoot = "/repo";
		// SAFETY: only min_score is read by compareMutation's floor message.
		const config: MutationGateConfig = { min_score: 0.8 } as MutationGateConfig;
		const report: MutationReport = { files: { "low.ts": { killed: 1, survived: 1 } } }; // score 0.5
		const baseline = emptyMutationBaseline();
		const result = compareMutation(report, baseline, { config, repoRoot });
		const finding = result.findings.find((f) => f.name === "mutation_score_below_floor");
		expect(finding?.message).toBe(
			"Mutation score for low.ts is 50.0% (floor: 80%). Add tests that kill the surviving mutants.",
		);
	});

	it("does NOT flag a decrease when score + 1e-9 exactly equals prior.score (kills cf8ad95d23ed1c34)", () => {
		const repoRoot = "/repo";
		const priorScore = 0.5 + 1e-9;
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2020-01-01T00:00:00.000Z",
			files: { "edge.ts": { score: priorScore, killed: 5 } },
		};
		// killed=1, survived=1 -> score exactly 0.5, so score + 1e-9 === priorScore.
		// `<` is false at exact equality; the `<=` mutant would flip this to a decrease.
		const report: MutationReport = { files: { "edge.ts": { killed: 1, survived: 1 } } };
		const result = compareMutation(report, baseline, { config: baseConfig, repoRoot });
		const finding = result.findings.find((f) => f.name === "mutation_score_decrease");
		expect(finding).toBeUndefined();
		expect(result.stats.files_decreased).toBe(0);
	});

	it("builds the exact decrease message text (kills 3f47b986b75fa826, b8dc222b05a47ca5, 4aae492a203d2935)", () => {
		const repoRoot = "/repo";
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2020-01-01T00:00:00.000Z",
			files: { "drop.ts": { score: 0.9, killed: 9 } },
		};
		const report: MutationReport = { files: { "drop.ts": { killed: 1, survived: 9 } } }; // score 0.1
		const result = compareMutation(report, baseline, { config: baseConfig, repoRoot });
		const finding = result.findings.find((f) => f.name === "mutation_score_decrease");
		expect(finding?.message).toBe(
			"Mutation score for drop.ts dropped from 90.0% to 10.0%. Investigate new survived mutants before merging.",
		);
	});

	it("keeps the max killed count (high-water mark), not the min (kills 9a02bc35d63b52df)", () => {
		const repoRoot = "/repo";
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2020-01-01T00:00:00.000Z",
			files: { "up.ts": { score: 0.5, killed: 3 } },
		};
		// score 1.0 (improvement), killed=10
		const report: MutationReport = { files: { "up.ts": { killed: 10, survived: 0 } } };
		const result = compareMutation(report, baseline, { config: baseConfig, repoRoot });
		expect(result.nextBaseline.files["up.ts"]?.killed).toBe(10);
	});
});
