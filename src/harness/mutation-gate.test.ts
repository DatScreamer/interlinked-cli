import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MutationGateConfig } from "./check-policy.js";
import {
	compareMutation,
	emptyMutationBaseline,
	loadMutationBaseline,
	loadMutationReport,
	type MutationBaseline,
	type MutationReport,
	mutationBaselinePath,
	mutationScore,
	saveMutationBaseline,
} from "./mutation-gate.js";

const DEFAULT_CONFIG: MutationGateConfig = {
	enabled: true,
	min_score: 0.6,
	schedule: "weekly",
};

describe("mutationScore", () => {
	it("returns 0 for a file with no mutants", () => {
		expect(mutationScore({ killed: 0, survived: 0 })).toBe(0);
	});

	it("returns 1 when all mutants are killed", () => {
		expect(mutationScore({ killed: 10, survived: 0 })).toBe(1);
	});

	it("returns 0.5 on a 1-1 split", () => {
		expect(mutationScore({ killed: 5, survived: 5 })).toBeCloseTo(0.5);
	});

	it("excludes timeouts and compile errors from the denominator", () => {
		expect(
			mutationScore({ killed: 4, survived: 1, timeout: 5, compile_error: 10 }),
		).toBeCloseTo(0.8);
	});
});

describe("loadMutationBaseline / saveMutationBaseline round trip", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-baseline-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty baseline when file missing", () => {
		expect(loadMutationBaseline(tmp).files).toEqual({});
	});

	it("round-trips a baseline through disk", () => {
		const b: MutationBaseline = {
			version: 1,
			updated_at: "2026-04-22",
			files: { "src/foo.ts": { score: 0.9, killed: 27 } },
		};
		saveMutationBaseline(tmp, b);
		expect(loadMutationBaseline(tmp)).toEqual(b);
	});

	it("recovers from malformed baseline", () => {
		writeFileSync(mutationBaselinePath(tmp), "{ not json", "utf-8");
		expect(loadMutationBaseline(tmp).files).toEqual({});
	});
});

describe("loadMutationReport — Stryker shape normalization", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-report-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("aggregates Stryker-style mutant arrays", () => {
		const p = join(tmp, "stryker.json");
		writeFileSync(
			p,
			JSON.stringify({
				files: {
					"src/foo.ts": {
						mutants: [
							{ status: "Killed" },
							{ status: "Killed" },
							{ status: "Survived" },
							{ status: "Timeout" },
						],
					},
				},
			}),
		);
		const report = loadMutationReport(p);
		expect(report?.files["src/foo.ts"]).toEqual({
			killed: 2,
			survived: 1,
			timeout: 1,
			no_coverage: 0,
			compile_error: 0,
			runtime_error: 0,
		});
	});

	it("accepts flat kill/survived counts as well", () => {
		const p = join(tmp, "flat.json");
		writeFileSync(
			p,
			JSON.stringify({
				files: { "src/foo.ts": { killed: 8, survived: 2 } },
			}),
		);
		const report = loadMutationReport(p);
		expect(report?.files["src/foo.ts"]?.killed).toBe(8);
	});

	it("returns null on malformed JSON", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "nope", "utf-8");
		expect(loadMutationReport(p)).toBeNull();
	});
});

describe("compareMutation — floor check", () => {
	it("flags files below the configured score floor", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 4, survived: 6 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings.some((f) => f.name === "mutation_score_below_floor")).toBe(true);
		expect(res.stats.files_below_floor).toBe(1);
	});

	it("does NOT flag a file with zero total mutants (no signal)", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 0, survived: 0 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
	});

	it("does NOT flag files at or above the floor", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } }, // 0.8
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
	});
});

describe("compareMutation — ratchet (decrease detection)", () => {
	it("flags a per-file score decrease as error", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.9, killed: 9 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } }, // 0.8
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		const decrease = res.findings.find((f) => f.name === "mutation_score_decrease");
		expect(decrease).toBeDefined();
		expect(decrease?.severity).toBe("error");
		expect(res.stats.files_decreased).toBe(1);
	});

	it("preserves the high-water mark after a decrease", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.9, killed: 9 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } },
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({ score: 0.9, killed: 9 });
	});

	it("advances the baseline when score improves", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.7, killed: 7 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 9, survived: 1 } }, // 0.9
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"].score).toBe(0.9);
		expect(res.stats.files_improved).toBe(1);
	});
});

describe("compareMutation — changedFiles scoping", () => {
	it("limits evaluation to listed paths", () => {
		const report: MutationReport = {
			files: {
				"src/foo.ts": { killed: 0, survived: 10 },
				"src/bar.ts": { killed: 0, survived: 10 },
			},
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
			changedFiles: ["src/foo.ts"],
		});
		expect(res.stats.files_checked).toBe(1);
		expect(res.findings.every((f) => f.file === "src/foo.ts")).toBe(true);
	});
});

describe("compareMutation — path normalization", () => {
	it("normalizes absolute paths to repo-relative", () => {
		const report: MutationReport = {
			files: { "/repo/src/foo.ts": { killed: 9, survived: 1 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toBeDefined();
	});

	it("drops paths outside the repo root", () => {
		const report: MutationReport = {
			files: { "/other/foo.ts": { killed: 9, survived: 1 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(0);
	});
});

describe("file I/O edge cases", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-io-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("saveMutationBaseline creates missing directories", () => {
		const deep = join(tmp, ".interlinked", "deep");
		saveMutationBaseline(deep, emptyMutationBaseline());
		const contents = JSON.parse(readFileSync(mutationBaselinePath(deep), "utf-8"));
		expect(contents.version).toBe(1);
	});

	it("loadMutationReport returns null when file is missing", () => {
		expect(loadMutationReport(join(tmp, "none.json"))).toBeNull();
	});
});
