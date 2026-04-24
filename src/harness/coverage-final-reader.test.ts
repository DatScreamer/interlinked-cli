import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
				statementMap: {},
				s: {},
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(result as never, "src/foo.ts");
		expect(entry?.functions[0].name).toBe("anon@42");
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
