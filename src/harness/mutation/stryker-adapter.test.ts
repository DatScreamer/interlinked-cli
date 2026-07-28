import { describe, expect, it } from "vitest";
import { lineColToOffset, mapStrykerStatus, strykerToAdapted } from "./stryker-adapter.js";

function nth<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`expected element ${i}`);
	return v;
}

describe("lineColToOffset", () => {
	const src = "ab\ncde\nf";
	it("handles line 1 (1-based column)", () => {
		expect(lineColToOffset(src, 1, 1)).toBe(0);
		expect(lineColToOffset(src, 1, 2)).toBe(1);
	});
	it("handles later lines", () => {
		expect(lineColToOffset(src, 2, 1)).toBe(3);
		expect(lineColToOffset(src, 3, 1)).toBe(7);
	});
	it("clamps a line beyond EOF to the content length", () => {
		expect(lineColToOffset(src, 99, 1)).toBe(src.length);
	});
});

describe("mapStrykerStatus", () => {
	it.each<[string, string]>([
		["Killed", "killed"],
		["Survived", "survived"],
		["Timeout", "timeout"],
		["NoCoverage", "uncovered"],
		["CompileError", "indeterminate"],
		["whatever", "indeterminate"],
	])("maps %s → %s", (stryker, expected) => {
		expect(mapStrykerStatus(stryker)).toBe(expected);
	});
});

describe("strykerToAdapted", () => {
	const source = "function f(x) {\n  return x > 0;\n}\n";
	const report = {
		files: {
			"src/f.ts": {
				source,
				mutants: [
					{
						id: "1",
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status: "Survived",
						location: { start: { line: 2, column: 12 }, end: { line: 2, column: 13 } },
					},
				],
			},
		},
	};

	it("converts a report to raw mutants with offsets, lexemes, and mapped status", () => {
		const adapted = strykerToAdapted(report);
		expect(adapted).not.toBeNull();
		const file = nth(adapted ?? [], 0);
		expect(file.file).toBe("src/f.ts");
		const m = nth(file.mutants, 0);
		expect(m.status).toBe("survived");
		expect(m.raw.startOffset).toBe(source.indexOf("> 0"));
		expect(m.raw.originalLexeme).toBe(">");
		expect(m.raw.replacement).toBe(">=");
		expect(m.raw.mutator).toBe("EqualityOperator");
	});

	it.each<[string, unknown]>([
		["a non-object report", 42],
		["a report without files", {}],
	])("returns null for %s", (_label, bad) => {
		expect(strykerToAdapted(bad)).toBeNull();
	});

	it("skips files missing source or mutants, and malformed mutants", () => {
		const r = {
			files: {
				"no-source.ts": { mutants: [] },
				"bad-mutants.ts": { source: "x", mutants: "nope" },
				"ok.ts": {
					source: "a>b",
					mutants: [
						{ mutatorName: "X" }, // missing fields → skipped
						{
							mutatorName: "Eq",
							replacement: ">=",
							status: "Killed",
							location: { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } },
						},
					],
				},
			},
		};
		const adapted = strykerToAdapted(r) ?? [];
		expect(adapted.map((f) => f.file)).toEqual(["ok.ts"]);
		const ok = nth(adapted, 0);
		expect(ok.mutants).toHaveLength(1);
		expect(nth(ok.mutants, 0).raw.originalLexeme).toBe(">");
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 19 survivors of 104, nearly all in the VALIDATION guards.
// This is the boundary parser for a foreign engine's JSON — every guard here
// exists to reject a malformed entry, and a guard nothing tests is a guard that
// can silently stop rejecting. A dropped field would surface as a mutant with a
// bogus offset, i.e. a survivor attributed to the wrong line.
// ---------------------------------------------------------------------------

const SOURCE = "function f(x) { return x > 0; }\n";
// Derived, not hand-counted: Stryker columns are 1-based, and getting this
// wrong silently points the fixture at the neighbouring character.
const GT_COL = SOURCE.indexOf(">") + 1;
const LOC = { start: { line: 1, column: GT_COL }, end: { line: 1, column: GT_COL + 1 } };
const goodMutant = {
	mutatorName: "EqualityOperator",
	replacement: ">=",
	status: "Survived",
	location: LOC,
};
const reportWith = (mutants: unknown[]) => ({ files: { "src/a.ts": { source: SOURCE, mutants } } });
const mutantsOf = (report: unknown) => strykerToAdapted(report)?.[0]?.mutants ?? [];

describe("mutant validation — each required field is genuinely required", () => {
	it("accepts a well-formed mutant", () => {
		expect(mutantsOf(reportWith([goodMutant]))).toHaveLength(1);
	});

	for (const field of ["mutatorName", "replacement", "status"] as const) {
		it(`drops a mutant with no ${field}`, () => {
			const { [field]: _omitted, ...rest } = goodMutant;
			expect(mutantsOf(reportWith([rest]))).toHaveLength(0);
		});

		it(`drops a mutant whose ${field} is not a string`, () => {
			expect(mutantsOf(reportWith([{ ...goodMutant, [field]: 42 }]))).toHaveLength(0);
		});
	}

	it("drops a mutant with no location at all", () => {
		const { location: _omitted, ...rest } = goodMutant;
		expect(mutantsOf(reportWith([rest]))).toHaveLength(0);
	});

	it("drops a mutant missing location.start", () => {
		expect(mutantsOf(reportWith([{ ...goodMutant, location: { end: LOC.end } }]))).toHaveLength(0);
	});

	it("drops a mutant missing location.end", () => {
		expect(mutantsOf(reportWith([{ ...goodMutant, location: { start: LOC.start } }]))).toHaveLength(0);
	});

	it("drops a position missing its line", () => {
		const loc = { start: { column: 1 }, end: LOC.end };
		expect(mutantsOf(reportWith([{ ...goodMutant, location: loc }]))).toHaveLength(0);
	});

	it("drops a position missing its column", () => {
		const loc = { start: { line: 1 }, end: LOC.end };
		expect(mutantsOf(reportWith([{ ...goodMutant, location: loc }]))).toHaveLength(0);
	});

	it("drops a position whose line is not a number", () => {
		const loc = { start: { line: "1", column: 1 }, end: LOC.end };
		expect(mutantsOf(reportWith([{ ...goodMutant, location: loc }]))).toHaveLength(0);
	});

	it("skips a non-object entry without discarding its valid neighbours", () => {
		expect(mutantsOf(reportWith([null, "nope", 7, goodMutant]))).toHaveLength(1);
	});

	it("keeps the valid mutants when one entry is malformed", () => {
		expect(mutantsOf(reportWith([{ mutatorName: "M" }, goodMutant]))).toHaveLength(1);
	});
});

describe("report-level validation", () => {
	it("rejects a report that is not an object", () => {
		for (const bad of [null, undefined, 7, "x", []]) expect(strykerToAdapted(bad)).toBeNull();
	});

	it("rejects a report with no files map", () => {
		expect(strykerToAdapted({})).toBeNull();
		expect(strykerToAdapted({ files: "nope" })).toBeNull();
	});

	it("skips a file entry that is not an object", () => {
		expect(strykerToAdapted({ files: { "a.ts": 7 } })).toEqual([]);
	});

	it("skips a file with no source text", () => {
		expect(strykerToAdapted({ files: { "a.ts": { mutants: [] } } })).toEqual([]);
	});

	it("skips a file whose mutants field is not an array", () => {
		expect(strykerToAdapted({ files: { "a.ts": { source: SOURCE, mutants: {} } } })).toEqual([]);
	});

	it("accepts a file with an empty mutant list — measured and clean", () => {
		const out = strykerToAdapted({ files: { "a.ts": { source: SOURCE, mutants: [] } } });
		expect(out).toHaveLength(1);
		expect(nth(out ?? [], 0).mutants).toEqual([]);
	});

	it("carries the original lexeme sliced from the source, not from the report", () => {
		// The lexeme is what the agent reads in the survivor line; taking it from
		// the source is what makes it trustworthy.
		expect(nth(mutantsOf(reportWith([goodMutant])), 0).raw.originalLexeme).toBe(">");
	});
});
