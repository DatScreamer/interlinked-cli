import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageRatchetConfig } from "./check-policy.js";
import {
	baselinePath,
	type CoverageBaseline,
	type CoverageSummary,
	compareCoverage,
	emptyBaseline,
	loadBaseline,
	loadCoverageSummary,
	saveBaseline,
} from "./coverage-ratchet.js";

const STRICT_CONFIG: CoverageRatchetConfig = {
	enabled: true,
	per_file: true,
	allow_decrease_pct: 0,
};

function mkSummary(entries: Record<string, { lines: number; branches: number }>): CoverageSummary {
	const summary: CoverageSummary = {};
	for (const [path, { lines, branches }] of Object.entries(entries)) {
		summary[path] = {
			lines: { pct: lines },
			branches: { pct: branches },
		};
	}
	return summary;
}

describe("emptyBaseline", () => {
	it("has version 1 and empty files map", () => {
		const b = emptyBaseline();
		expect(b.version).toBe(1);
		expect(b.files).toEqual({});
	});
});

describe("loadBaseline / saveBaseline round trip", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-ratchet-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an empty baseline when no file exists", () => {
		const b = loadBaseline(tmp);
		expect(b.files).toEqual({});
	});

	it("writes and reads a baseline", () => {
		const b: CoverageBaseline = {
			version: 1,
			updated_at: "2026-04-22T00:00:00Z",
			files: { "src/foo.ts": { lines_pct: 80, branches_pct: 60 } },
		};
		saveBaseline(tmp, b);
		expect(loadBaseline(tmp)).toEqual(b);
	});

	it("gracefully handles a malformed baseline file", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(baselinePath(tmp), "{ not json", "utf-8");
		expect(loadBaseline(tmp).files).toEqual({});
	});

	it("creates the directory when saving into a nonexistent one", () => {
		const deep = join(tmp, ".interlinked", "nested");
		const b = emptyBaseline();
		saveBaseline(deep, b);
		expect(JSON.parse(readFileSync(baselinePath(deep), "utf-8")).version).toBe(1);
	});
});

describe("loadCoverageSummary", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-summary-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when the file is missing", () => {
		expect(loadCoverageSummary(join(tmp, "nonexistent.json"))).toBeNull();
	});

	it("returns null when JSON is malformed", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "nope", "utf-8");
		expect(loadCoverageSummary(p)).toBeNull();
	});

	it("parses a well-formed summary", () => {
		const p = join(tmp, "summary.json");
		writeFileSync(p, JSON.stringify({ "src/foo.ts": { lines: { pct: 90 } } }));
		const summary = loadCoverageSummary(p);
		expect(summary?.["src/foo.ts"]?.lines.pct).toBe(90);
	});
});

describe("compareCoverage — first-run behavior", () => {
	it("treats all files as new when baseline is empty, emits no findings", () => {
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
		expect(res.stats.files_new).toBe(1);
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({ lines_pct: 80, branches_pct: 60 });
	});

	it("skips the synthetic `total` bucket", () => {
		const summary: CoverageSummary = {
			...mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } }),
			total: { lines: { pct: 50 }, branches: { pct: 50 } },
		};
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(1);
		expect(res.nextBaseline.files.total).toBeUndefined();
	});
});

describe("compareCoverage — decrease detection", () => {
	it("flags a decreased per-file lines coverage with strict config", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toHaveLength(1);
		expect(res.findings[0].metric).toBe("lines");
		expect(res.findings[0].baseline_pct).toBe(90);
		expect(res.findings[0].current_pct).toBe(80);
		expect(res.findings[0].delta_pct).toBe(-10);
	});

	it("flags both lines and branches when both drop", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 70 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 85, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		const metrics = res.findings.map((f) => f.metric).sort();
		expect(metrics).toEqual(["branches", "lines"]);
		expect(res.stats.files_decreased).toBe(1);
	});

	it("respects allow_decrease_pct tolerance", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 88, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 5 },
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
	});
});

describe("compareCoverage — baseline advancement", () => {
	it("advances the baseline when coverage improves", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 70, branches_pct: 50 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 85, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({
			lines_pct: 85,
			branches_pct: 60,
		});
		expect(res.stats.files_improved).toBe(1);
	});

	it("preserves the high-water mark when coverage decreases", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		// The lines metric decreased — baseline stays at 90, not lowered.
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({
			lines_pct: 90,
			branches_pct: 60,
		});
	});
});

describe("compareCoverage — changedFiles filter", () => {
	it("only evaluates paths in the changedFiles allowlist", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: {
				"src/foo.ts": { lines_pct: 90, branches_pct: 60 },
				"src/bar.ts": { lines_pct: 90, branches_pct: 60 },
			},
		};
		const summary = mkSummary({
			"src/foo.ts": { lines: 50, branches: 50 },
			"src/bar.ts": { lines: 50, branches: 50 },
		});
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
			changedFiles: ["src/foo.ts"],
		});
		expect(res.stats.files_checked).toBe(1);
		expect(res.findings.every((f) => f.file === "src/foo.ts")).toBe(true);
	});
});

describe("compareCoverage — path normalization", () => {
	it("normalizes absolute paths to repo-relative", () => {
		const summary = mkSummary({ "/repo/src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toBeDefined();
	});

	it("rejects paths that fall outside repoRoot", () => {
		const summary = mkSummary({ "/other/project/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(0);
	});
});
