import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	__resetCoverageFinalCache,
	coverageForFile,
	loadCoverageFinal,
} from "./coverage-final-reader.js";

// ==================================================================
// Fixtures
// ==================================================================

interface IstanbulFixture {
	[path: string]: {
		path: string;
		fnMap: Record<
			string,
			{ name: string; decl: { start: { line: number }; end: { line: number } } }
		>;
		f: Record<string, number>;
		statementMap: Record<
			string,
			{ start: { line: number; column: number }; end: { line: number; column: number } }
		>;
		s: Record<string, number>;
	};
}

function buildFixture(repoRoot: string): IstanbulFixture {
	const absPath = join(repoRoot, "src/foo.ts");
	return {
		[absPath]: {
			path: absPath,
			fnMap: {
				"0": {
					name: "covered",
					decl: { start: { line: 1 }, end: { line: 3 } },
				},
				"1": {
					name: "uncovered",
					decl: { start: { line: 10 }, end: { line: 12 } },
				},
			},
			f: { "0": 5, "1": 0 },
			statementMap: {
				"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
				"1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
				"2": { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
				"3": { start: { line: 10, column: 0 }, end: { line: 10, column: 10 } },
				"4": { start: { line: 11, column: 0 }, end: { line: 11, column: 10 } },
				"5": { start: { line: 12, column: 0 }, end: { line: 12, column: 10 } },
			},
			s: { "0": 5, "1": 5, "2": 0, "3": 0, "4": 0, "5": 0 },
		},
	};
}

// ==================================================================
// Setup / teardown
// ==================================================================

let tmp: string;
let coveragePath: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "crap-cov-"));
	mkdirSync(join(tmp, "coverage"), { recursive: true });
	coveragePath = join(tmp, "coverage", "coverage-final.json");
	__resetCoverageFinalCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(fixture: unknown): void {
	writeFileSync(coveragePath, JSON.stringify(fixture), "utf-8");
}

// ==================================================================
// Tests
// ==================================================================

describe("loadCoverageFinal", () => {
	it("returns null when the file is missing", () => {
		expect(loadCoverageFinal(join(tmp, "does-not-exist.json"), tmp)).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		writeFileSync(coveragePath, "{ broken", "utf-8");
		expect(loadCoverageFinal(coveragePath, tmp)).toBeNull();
	});

	it("returns null for non-object JSON", () => {
		writeFileSync(coveragePath, "42", "utf-8");
		expect(loadCoverageFinal(coveragePath, tmp)).toBeNull();
	});

	it("parses a minimal fixture into per-function coverage", () => {
		writeFixture(buildFixture(tmp));
		const result = loadCoverageFinal(coveragePath, tmp);
		expect(result).not.toBeNull();
		const entry = coverageForFile(result as Map<string, unknown> as never, "src/foo.ts");
		expect(entry).toBeDefined();
		expect(entry?.functions.map((f) => f.name)).toEqual(["covered", "uncovered"]);
	});

	it("populates per-LINE coverage from the statement map — flags an uncovered statement INSIDE a covered function (finding 5)", () => {
		writeFixture(buildFixture(tmp));
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as Map<string, unknown> as never, "src/foo.ts");
		// Function "covered" (lines 1-3) has f=5 hits — per-FUNCTION coverage calls it
		// covered. But statement "2" (line 3) has s=0, so per-LINE correctly flags line 3.
		expect(entry?.uncoveredLines?.has(3)).toBe(true); // uncovered stmt in a covered fn
		expect(entry?.uncoveredLines?.has(10)).toBe(true); // uncovered fn body
		expect(entry?.coveredLines?.has(1)).toBe(true); // executed statement
		expect(entry?.coveredLines?.has(3)).toBe(false);
	});

	it("a ZERO-hit MULTI-LINE statement marks EVERY spanned line uncovered; a covered one marks only its start (finding 2026-06)", () => {
		const absPath = join(tmp, "src/multi.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {},
				f: {},
				statementMap: {
					// Uncovered call spanning lines 20-22 — its continuation lines were
					// previously in NEITHER set, so an edit touching line 21 slipped through.
					"0": { start: { line: 20, column: 0 }, end: { line: 22, column: 1 } },
					// Covered declaration spanning 30-32 (`const f = () => {…}` shape):
					// only its START line is covered — marking the full range would mask
					// uncovered inner statements via covered-wins.
					"1": { start: { line: 30, column: 0 }, end: { line: 32, column: 1 } },
				},
				s: { "0": 0, "1": 4 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as Map<string, unknown> as never, "src/multi.ts");
		expect(entry?.uncoveredLines?.has(20)).toBe(true);
		expect(entry?.uncoveredLines?.has(21)).toBe(true); // continuation line now flagged
		expect(entry?.uncoveredLines?.has(22)).toBe(true);
		expect(entry?.coveredLines?.has(30)).toBe(true); // covered: start line only
		expect(entry?.coveredLines?.has(31)).toBe(false);
		expect(entry?.uncoveredLines?.has(31)).toBe(false); // and NOT uncovered either
	});

	it("computes statement_pct from overlapping statement ranges", () => {
		writeFixture(buildFixture(tmp));
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as Map<string, unknown> as never, "src/foo.ts");
		const covered = entry?.functions.find((f) => f.name === "covered");
		const uncovered = entry?.functions.find((f) => f.name === "uncovered");
		// "covered": 3 statements (lines 1–3), 2 executed (lines 1–2) → ~66.7%
		expect(covered?.statement_pct).toBeCloseTo((2 / 3) * 100, 1);
		// "uncovered": 3 statements (lines 10–12), 0 executed
		expect(uncovered?.statement_pct).toBe(0);
	});

	it("preserves raw function hit counts", () => {
		writeFixture(buildFixture(tmp));
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as Map<string, unknown> as never, "src/foo.ts");
		expect(entry?.functions.find((f) => f.name === "covered")?.hits).toBe(5);
		expect(entry?.functions.find((f) => f.name === "uncovered")?.hits).toBe(0);
	});

	it("caches by mtime — unchanged file returns the same reference", () => {
		writeFixture(buildFixture(tmp));
		const a = loadCoverageFinal(coveragePath, tmp);
		const b = loadCoverageFinal(coveragePath, tmp);
		expect(a).toBe(b); // identity comparison
	});

	it("re-parses when mtime changes", () => {
		writeFixture(buildFixture(tmp));
		const a = loadCoverageFinal(coveragePath, tmp);
		// Set mtime to a fixed far-future timestamp — deterministically different
		// from the real mtime of a file written seconds ago.
		const forcedMtime = new Date("2099-01-01T00:00:00Z");
		utimesSync(coveragePath, forcedMtime, forcedMtime);
		const b = loadCoverageFinal(coveragePath, tmp);
		expect(a).not.toBe(b);
	});

	it("normalizes paths and skips entries outside the repo root", () => {
		const outside = "/tmp/some-other-repo/src/bar.ts";
		const fixture = {
			[outside]: {
				path: outside,
				fnMap: {
					"0": { name: "foo", decl: { start: { line: 1 }, end: { line: 1 } } },
				},
				f: { "0": 1 },
				statementMap: {},
				s: {},
			},
		};
		writeFixture(fixture);
		const result = loadCoverageFinal(coveragePath, tmp);
		expect(result).not.toBeNull();
		// The outside file should not appear under the tmp repo root.
		expect(result?.has("src/bar.ts")).toBe(false);
	});

	it("falls back to anon@line when the function has no name", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {
					"0": { name: "", decl: { start: { line: 42 }, end: { line: 50 } } },
				},
				f: { "0": 1 },
				// At least one statement must fall inside 42–50: a function the
				// report carries no statement for is treated as unmeasured and
				// omitted entirely, which would leave nothing to name here.
				statementMap: { "0": { start: { line: 43 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as never, "src/foo.ts");
		expect(nonNull(entry?.functions[0]).name).toBe("anon@42");
	});

	it("N: omits a function the report carries no statement for (unknown ≠ 0%)", () => {
		// Istanbul routinely emits an fnMap entry whose line range no longer holds
		// any statement — the source moved since the run. Reporting 0% there is
		// indistinguishable from real zero coverage and drove CRAP to its ceiling
		// for well-tested functions, so the entry is dropped instead.
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {
					"0": { name: "ghost", decl: { start: { line: 42 }, end: { line: 50 } } },
					"1": { name: "real", decl: { start: { line: 1 }, end: { line: 5 } } },
				},
				f: { "0": 0, "1": 3 },
				statementMap: { "0": { start: { line: 2 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as never, "src/foo.ts");
		expect(entry?.functions.map((f) => f.name)).toEqual(["real"]);
	});
});

describe("coverageForFile", () => {
	it("returns undefined for an unknown file", () => {
		writeFixture(buildFixture(tmp));
		const result = loadCoverageFinal(coveragePath, tmp);
		expect(coverageForFile(result as never, "src/other.ts")).toBeUndefined();
	});

	it("normalizes backslash path separators", () => {
		writeFixture(buildFixture(tmp));
		const result = loadCoverageFinal(coveragePath, tmp);
		// Windows-style lookup should still find the POSIX-keyed entry.
		expect(coverageForFile(result as never, "src\\foo.ts")).toBeDefined();
	});
});
