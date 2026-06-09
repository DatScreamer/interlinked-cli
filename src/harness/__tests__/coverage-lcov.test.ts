import { describe, expect, it } from "vitest";
import {
	canonicalToCoverageSummary,
	loadLcovFile,
	parseLcov,
	perFileCoverageFromCanonical,
} from "../coverage-lcov.js";
import { type CoverageBaseline, compareCoverage } from "../coverage-ratchet.js";

// A small, valid two-file LCOV report used by several cases.
const TWO_FILE = [
	"TN:",
	"SF:src/a.ts",
	"FN:1,alpha",
	"FN:8,beta",
	"FNDA:3,alpha",
	"FNDA:0,beta",
	"FNF:2",
	"FNH:1",
	"BRDA:4,0,0,3",
	"BRDA:4,0,1,-",
	"BRF:2",
	"BRH:1",
	"DA:1,3",
	"DA:2,3",
	"DA:3,0",
	"DA:4,3",
	"LF:4",
	"LH:3",
	"end_of_record",
	"SF:src/b.ts",
	"DA:1,1",
	"DA:2,1",
	"LF:2",
	"LH:2",
	"end_of_record",
	"",
].join("\n");

describe("parseLcov — file-level metrics", () => {
	it("parses multiple files with line/branch/function coverage", () => {
		const cov = parseLcov(TWO_FILE);
		expect(cov.source).toBe("lcov");
		expect([...cov.files.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);

		const a = cov.files.get("src/a.ts");
		if (!a) throw new Error("missing src/a.ts");
		// 4 DA lines, 3 with hits > 0 → 75%.
		expect(a.lines).toEqual({ covered: 3, total: 4, pct: 75 });
		// 2 branches, 1 taken (the `-` one is uncovered) → 50%.
		expect(a.branches).toEqual({ covered: 1, total: 2, pct: 50 });
		// 2 functions, 1 hit (alpha) → 50%.
		expect(a.functions).toEqual({ covered: 1, total: 2, pct: 50 });
	});

	it("treats a file with no executable lines as vacuously 100%", () => {
		const cov = parseLcov(["SF:src/types.ts", "end_of_record"].join("\n"));
		const f = cov.files.get("src/types.ts");
		if (!f) throw new Error("missing file");
		expect(f.lines.pct).toBe(100);
		expect(f.lines.total).toBe(0);
		expect(f.branches.pct).toBe(100);
		expect(f.functions.pct).toBe(100);
	});

	it("retains the per-function entries and the raw line-hit map", () => {
		const a = parseLcov(TWO_FILE).files.get("src/a.ts");
		if (!a) throw new Error("missing src/a.ts");
		expect(a.perFunction).toContainEqual({ name: "alpha", line: 1, hits: 3 });
		expect(a.perFunction).toContainEqual({ name: "beta", line: 8, hits: 0 });
		expect(a.lineHits.get(1)).toBe(3);
		expect(a.lineHits.get(3)).toBe(0);
	});
});

describe("parseLcov — format edge cases", () => {
	it("ignores the optional DA checksum (3rd field)", () => {
		const cov = parseLcov(
			["SF:x.ts", "DA:1,5,abc123checksum", "DA:2,0,def", "end_of_record"].join("\n"),
		);
		const f = cov.files.get("x.ts");
		if (!f) throw new Error("missing file");
		expect(f.lines).toEqual({ covered: 1, total: 2, pct: 50 });
	});

	it("normalizes absolute SF paths against cwd", () => {
		const cov = parseLcov(
			["SF:/repo/root/src/deep/mod.ts", "DA:1,1", "end_of_record"].join("\n"),
			{ cwd: "/repo/root" },
		);
		expect(cov.files.has("src/deep/mod.ts")).toBe(true);
	});

	it("keeps function names that contain commas", () => {
		const cov = parseLcov(
			["SF:x.ts", "FN:2,Foo<A, B>.method", "FNDA:1,Foo<A, B>.method", "end_of_record"].join("\n"),
		);
		const f = cov.files.get("x.ts");
		if (!f) throw new Error("missing file");
		expect(f.perFunction[0]?.name).toBe("Foo<A, B>.method");
		expect(f.functions.covered).toBe(1);
	});

	it("merges duplicate file records by summing hits (LCOV merge semantics)", () => {
		const cov = parseLcov(
			[
				"SF:x.ts",
				"DA:1,1",
				"DA:2,0",
				"end_of_record",
				"SF:x.ts",
				"DA:1,2",
				"DA:2,5",
				"end_of_record",
			].join("\n"),
		);
		const f = cov.files.get("x.ts");
		if (!f) throw new Error("missing file");
		expect(f.lineHits.get(1)).toBe(3); // 1 + 2
		expect(f.lineHits.get(2)).toBe(5); // 0 + 5 → now covered
		expect(f.lines).toEqual({ covered: 2, total: 2, pct: 100 });
	});
});

describe("parseLcov — robustness (never throws on arbitrary input)", () => {
	it("returns empty coverage for empty input", () => {
		expect(parseLcov("").files.size).toBe(0);
	});

	it("skips malformed lines and records without SF instead of throwing", () => {
		const garbage = [
			"not an lcov line at all",
			"DA:1,1", // DA before any SF — dropped
			":::::",
			"SF:", // empty path — dropped
			"SF:ok.ts",
			"DA:notanumber,nope",
			"DA:1,1",
			"end_of_record",
		].join("\n");
		const cov = parseLcov(garbage);
		expect(cov.files.has("ok.ts")).toBe(true);
		expect(cov.files.get("ok.ts")?.lines).toEqual({ covered: 1, total: 1, pct: 100 });
	});

	it("tolerates CRLF line endings", () => {
		const cov = parseLcov("SF:x.ts\r\nDA:1,1\r\nend_of_record\r\n");
		expect(cov.files.get("x.ts")?.lines.pct).toBe(100);
	});
});

describe("loadLcovFile", () => {
	it("returns null for a missing file rather than throwing", () => {
		expect(loadLcovFile("/nonexistent/lcov.info")).toBeNull();
	});
});

describe("canonicalToCoverageSummary bridge", () => {
	it("maps canonical coverage into the ratchet's CoverageSummary shape", () => {
		const summary = canonicalToCoverageSummary(parseLcov(TWO_FILE));
		expect(summary["src/a.ts"]?.lines).toEqual({ pct: 75, covered: 3, total: 4 });
		expect(summary["src/a.ts"]?.branches).toEqual({ pct: 50, covered: 1, total: 2 });
		expect(summary["src/b.ts"]?.lines?.pct).toBe(100);
	});
});

describe("end-to-end spine: LCOV → canonical → ratchet", () => {
	it("flags a per-file coverage regression against a baseline", () => {
		// foo.ts: 4/5 lines covered → 80%.
		const lcov = [
			"SF:src/foo.ts",
			"DA:1,1",
			"DA:2,1",
			"DA:3,1",
			"DA:4,1",
			"DA:5,0",
			"end_of_record",
		].join("\n");

		const summary = canonicalToCoverageSummary(parseLcov(lcov));
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files: { "src/foo.ts": { lines_pct: 100, branches_pct: 100 } },
		};

		const result = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 0 },
			repoRoot: process.cwd(),
		});

		const lineFinding = result.findings.find(
			(f) => f.file === "src/foo.ts" && f.metric === "lines",
		);
		expect(lineFinding).toBeDefined();
		expect(lineFinding?.baseline_pct).toBe(100);
		expect(lineFinding?.current_pct).toBe(80);
		expect(result.stats.files_decreased).toBe(1);
	});
});

describe("perFileCoverageFromCanonical (LCOV → per-function CRAP input)", () => {
	it("derives per-function statement_pct from line hits intersected with AST ranges", () => {
		// foo spans lines 1-4; lines 1,2,4 ran, line 3 did not → 3/4 = 75%.
		const lcov = "SF:src/foo.ts\nFN:1,foo\nFNDA:5,foo\nDA:1,5\nDA:2,5\nDA:3,0\nDA:4,5\nend_of_record\n";
		const canonical = parseLcov(lcov, { cwd: "/repo" });
		const cf = canonical.files.get("src/foo.ts");
		if (!cf) throw new Error("expected an LCOV record for src/foo.ts");
		const perFile = perFileCoverageFromCanonical(cf, "src/foo.ts", 123, [
			{ name: "foo", line: 1, endLine: 4 },
		]);
		expect(perFile.filePath).toBe("src/foo.ts");
		expect(perFile.functions).toHaveLength(1);
		expect(perFile.functions[0].statement_pct).toBe(75);
		expect(perFile.functions[0].hits).toBe(5); // from FNDA
	});

	it("yields 0% (and 0 hits) for a function whose range LCOV never recorded", () => {
		const lcov = "SF:src/foo.ts\nDA:1,5\nend_of_record\n";
		const canonical = parseLcov(lcov, { cwd: "/repo" });
		const cf = canonical.files.get("src/foo.ts");
		if (!cf) throw new Error("expected an LCOV record for src/foo.ts");
		const perFile = perFileCoverageFromCanonical(cf, "src/foo.ts", 1, [
			{ name: "ghost", line: 50, endLine: 60 },
		]);
		expect(perFile.functions[0].statement_pct).toBe(0);
		expect(perFile.functions[0].hits).toBe(0);
	});
});

// DUPLICATE-FUNCTION-NAME CONTRACT (finding: name-keyed collapse). LCOV legitimately
// repeats a name within one file (constructors, same-named methods). Keying FN by
// name alone overwrote the line and summed FNDA, collapsing N functions into 1 and
// marking an uncovered duplicate as covered — corrupting coverage/CRAP/ratchet.
describe("parseLcov — duplicate function names", () => {
	const DUP = [
		"SF:src/dup.ts",
		"FN:10,constructor",
		"FN:50,constructor",
		"FNDA:1,constructor",
		"FNDA:0,constructor",
		"FNF:2",
		"FNH:1",
		"end_of_record",
	].join("\n");

	it("keeps two distinct functions by line, hits NOT merged", () => {
		const f = parseLcov(DUP).files.get("src/dup.ts");
		const fns = f?.perFunction ?? [];
		expect(fns).toHaveLength(2);
		expect(fns).toContainEqual({ name: "constructor", line: 10, hits: 1 });
		expect(fns).toContainEqual({ name: "constructor", line: 50, hits: 0 });
		// The uncovered duplicate (line 50) stays uncovered — the collapse bug
		// summed FNDA (1+0) and marked it covered.
		expect(f?.functions).toEqual({ covered: 1, total: 2, pct: 50 });
	});

	it("FNF-vs-count integrity: canonical entry count matches the declared FNF", () => {
		const f = parseLcov(DUP).files.get("src/dup.ts");
		expect(f?.perFunction).toHaveLength(2); // declared FNF:2
	});

	it("merged reports (same SF twice) still SUM hits per (name, line)", () => {
		const merged = [
			"SF:src/m.ts",
			"FN:10,f",
			"FNDA:2,f",
			"end_of_record",
			"SF:src/m.ts",
			"FN:10,f",
			"FNDA:3,f",
			"end_of_record",
		].join("\n");
		const f = parseLcov(merged).files.get("src/m.ts");
		expect(f?.perFunction).toEqual([{ name: "f", line: 10, hits: 5 }]); // 2+3
	});
});
