// Tests for the leaf istanbul→canonical-element-set helpers, targeting the
// malformed-input branches the happy-path fixture in vitest.test.ts doesn't
// exercise (missing locations, non-record loc shapes, hits-key omissions).
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalPath, isRecord, istanbulToElementSets } from "./vitest-istanbul.js";

// ==================================================================
// isRecord
// ==================================================================

describe("isRecord", () => {
	it("accepts plain objects", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
	});

	it("rejects arrays, null, and primitives", () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(1)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
	});
});

// ==================================================================
// canonicalPath
// ==================================================================

describe("canonicalPath", () => {
	it("resolves symlinks for a path that exists", () => {
		expect(canonicalPath(process.cwd())).toBe(realpathSync(process.cwd()));
	});

	it("returns the input unchanged when realpathSync throws", () => {
		const p = "/definitely/not/a/real/path/xyz-123";
		expect(canonicalPath(p)).toBe(p);
	});
});

// ==================================================================
// istanbulToElementSets — malformed-shape branch coverage
// ==================================================================

describe("istanbulToElementSets — top-level data shape", () => {
	it("returns an empty map when data is not a record", () => {
		expect(istanbulToElementSets(null, "/repo").size).toBe(0);
		expect(istanbulToElementSets([1, 2], "/repo").size).toBe(0);
	});

	it("skips an entry whose value is not a record", () => {
		const sets = istanbulToElementSets({ "src/a.ts": "not-an-object" }, "/repo");
		expect(sets.size).toBe(0);
	});

	it("unwraps a {data: …} envelope when the top-level statementMap is absent", () => {
		const inner = {
			statementMap: { "0": { start: { line: 1, column: 0 } } },
			s: { "0": 1 },
		};
		const sets = istanbulToElementSets({ "src/a.ts": { data: inner } }, "/repo");
		expect(sets.get("src/a.ts")?.lines.get(1)).toBe(1);
	});

	it("skips an entry whose unwrapped candidate is missing statementMap or s", () => {
		const missingS = istanbulToElementSets({ "src/a.ts": { statementMap: {} } }, "/repo");
		expect(missingS.size).toBe(0);
		const missingStatementMap = istanbulToElementSets({ "src/a.ts": { s: {} } }, "/repo");
		expect(missingStatementMap.size).toBe(0);
	});

	it("uses the object key as the file path when fc.path is not a string", () => {
		const sets = istanbulToElementSets(
			{
				"src/keyed.ts": {
					statementMap: { "0": { start: { line: 1, column: 0 } } },
					s: { "0": 2 },
				},
			},
			"/repo",
		);
		expect(sets.get("src/keyed.ts")?.lines.get(1)).toBe(2);
	});

	it("skips a file whose resolved path falls outside the project root", () => {
		const sets = istanbulToElementSets(
			{
				"/elsewhere/out.ts": {
					path: "/elsewhere/out.ts",
					statementMap: { "0": { start: { line: 1, column: 0 } } },
					s: { "0": 1 },
				},
			},
			process.cwd(),
		);
		expect(sets.size).toBe(0);
	});

	it("skips a file whose raw path is an empty string", () => {
		const sets = istanbulToElementSets(
			{
				"": {
					path: "",
					statementMap: { "0": { start: { line: 1, column: 0 } } },
					s: { "0": 1 },
				},
			},
			"/repo",
		);
		expect(sets.size).toBe(0);
	});

	it("resolves a relative fc.path directly (non-absolute branch)", () => {
		const sets = istanbulToElementSets(
			{
				k: {
					path: "src/rel.ts",
					statementMap: { "0": { start: { line: 1, column: 0 } } },
					s: { "0": 9 },
				},
			},
			"/repo",
		);
		expect(sets.get("src/rel.ts")?.lines.get(1)).toBe(9);
	});
});

describe("istanbulToElementSets — statement/line malformed shapes", () => {
	const FILE = "src/stmt.ts";

	it("skips statements with a non-record loc, a missing start, and a non-number line", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					statementMap: {
						good: { start: { line: 1, column: 0 } },
						notRecordLoc: "garbage",
						noStart: { foo: "bar" },
						nonNumberLine: { start: { line: "x" } },
					},
					s: { good: 5, notRecordLoc: 1, noStart: 1, nonNumberLine: 1 },
				},
			},
			"/repo",
		);
		const m = sets.get(FILE);
		expect(m?.lines.size).toBe(1);
		expect(m?.lines.get(1)).toBe(5);
	});

	it("skips a statement whose hit count is not a number", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					statementMap: { "0": { start: { line: 1, column: 0 } } },
					s: { "0": "not-a-number" },
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.lines.size).toBe(0);
	});

	it("keys a statement by line:0 when the location has no column", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					statementMap: { "0": { start: { line: 7 } } },
					s: { "0": 4 },
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.statements?.get("7:0")).toBe(4);
	});

	it("omits the statements field entirely when every entry is malformed", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					statementMap: { "0": "garbage" },
					s: { "0": 1 },
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.statements).toBeUndefined();
	});
});

describe("istanbulToElementSets — branch malformed shapes", () => {
	const FILE = "src/branch.ts";
	const base = {
		statementMap: { "0": { start: { line: 1, column: 0 } } },
		s: { "0": 1 },
	};

	it("returns no branches when branchMap or b is missing", () => {
		const noBranchMap = istanbulToElementSets({ [FILE]: { ...base, b: {} } }, "/repo");
		expect(noBranchMap.get(FILE)?.branches.size).toBe(0);
		const noB = istanbulToElementSets({ [FILE]: { ...base, branchMap: {} } }, "/repo");
		expect(noB.get(FILE)?.branches.size).toBe(0);
	});

	it("skips a non-record branch entry and one whose hits are not an array", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					branchMap: {
						notRecord: "garbage",
						noHits: { line: 2, locations: [] },
					},
					b: {
						// notRecord: absent — skipped before this is read
						// noHits: intentionally absent from `b` → not an array
					},
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.branches.size).toBe(0);
	});

	it("falls back to [] locations and locLine(branch.loc)??0 when line/locations are absent", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					branchMap: {
						b0: {}, // no line, no loc, no locations
					},
					b: { b0: [3, "bad"] },
				},
			},
			"/repo",
		);
		const branches = sets.get(FILE)?.branches;
		// hits[0]=3 kept, keyed at fallback line 0 since locations[0] is undefined
		expect(branches?.get("0:b0:0")).toBe(3);
		// hits[1] is non-numeric → skipped entirely
		expect(branches?.has("0:b0:1")).toBe(false);
	});

	it("uses branch.line as the fallback when locations[i] has no location", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					branchMap: {
						b0: { line: 9, locations: [] },
					},
					b: { b0: [1] },
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.branches.get("9:b0:0")).toBe(1);
	});

	it("prefers locations[i]'s own line over the fallback when present", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					branchMap: {
						b0: { line: 9, locations: [{ start: { line: 12, column: 0 } }] },
					},
					b: { b0: [1] },
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.branches.get("12:b0:0")).toBe(1);
	});
});

describe("istanbulToElementSets — function malformed shapes", () => {
	const FILE = "src/fn.ts";
	const base = {
		statementMap: { "0": { start: { line: 1, column: 0 } } },
		s: { "0": 1 },
	};

	it("returns no functions when fnMap or f is missing", () => {
		const noFnMap = istanbulToElementSets({ [FILE]: { ...base, f: {} } }, "/repo");
		expect(noFnMap.get(FILE)?.functions.size).toBe(0);
		const noF = istanbulToElementSets({ [FILE]: { ...base, fnMap: {} } }, "/repo");
		expect(noF.get(FILE)?.functions.size).toBe(0);
	});

	it("skips a non-record function entry and one whose hits are not a number", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					fnMap: {
						notRecord: "garbage",
						badHits: { name: "x", decl: { start: { line: 2, column: 0 } } },
					},
					f: { badHits: "nope" },
				},
			},
			"/repo",
		);
		expect(sets.get(FILE)?.functions.size).toBe(0);
	});

	it("falls back to an anonymous name when fn.name is missing or empty", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					fnMap: {
						missing: { decl: { start: { line: 3, column: 0 } } },
						empty: { name: "", decl: { start: { line: 4, column: 0 } } },
					},
					f: { missing: 1, empty: 2 },
				},
			},
			"/repo",
		);
		const fns = sets.get(FILE)?.functions;
		expect(fns?.get("(anonymous_missing)@3")).toBe(1);
		expect(fns?.get("(anonymous_empty)@4")).toBe(2);
	});

	it("falls back decl → loc → 0 for the declaration line", () => {
		const sets = istanbulToElementSets(
			{
				[FILE]: {
					...base,
					fnMap: {
						viaLoc: { name: "viaLoc", loc: { start: { line: 5, column: 0 } } },
						viaZero: { name: "viaZero" },
					},
					f: { viaLoc: 1, viaZero: 1 },
				},
			},
			"/repo",
		);
		const fns = sets.get(FILE)?.functions;
		expect(fns?.get("viaLoc@5")).toBe(1);
		expect(fns?.get("viaZero@0")).toBe(1);
	});
});
