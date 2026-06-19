import { describe, expect, it } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import {
	COMMIT_CYCLOMATIC_CAP,
	type ChangedSource,
	coverageViolation,
	crapViolation,
	cyclomaticViolation,
	hasPerLineData,
	isTypeOnlySource,
	missingCoverageViolation,
} from "./commit-gate-scan.js";

const SRC: ChangedSource = { relPath: "src/m.ts", language: "ts" };

function perFn(functions: PerFileCoverage["functions"]): PerFileCoverage {
	return { filePath: "src/m.ts", mtime: 0, functions };
}

describe("hasPerLineData", () => {
	it("is true for a per-line (coverage.py) report, false for per-function", () => {
		expect(hasPerLineData({ ...perFn([]), uncoveredLines: new Set([1]) })).toBe(true);
		expect(hasPerLineData(perFn([]))).toBe(false);
	});
});

describe("coverageViolation", () => {
	it("flags an uncovered function (per-function report)", () => {
		const v = coverageViolation(SRC, perFn([{ name: "f", line: 2, endLine: 4, hits: 0, statement_pct: 0 }]));
		expect(v?.kind).toBe("uncovered");
		expect(v?.detail).toContain("`f`");
	});
	it("allows a fully-covered function", () => {
		expect(coverageViolation(SRC, perFn([{ name: "f", line: 2, endLine: 4, hits: 3, statement_pct: 100 }]))).toBeNull();
	});
});

describe("missingCoverageViolation (finding 4)", () => {
	it("is always a whole-file uncovered violation naming the untested file", () => {
		const v = missingCoverageViolation(SRC);
		expect(v.kind).toBe("uncovered");
		expect(v.file).toBe("src/m.ts");
		expect(v.detail).toMatch(/absent from the coverage report|untested/i);
	});
});

describe("cyclomaticViolation", () => {
	it("flags a function over the cap and allows one at/under it", () => {
		const over: FunctionComplexityEntry = { name: "big", line: 1, endLine: 9, cyclomatic: COMMIT_CYCLOMATIC_CAP + 1, language: "js_ts" };
		const ok: FunctionComplexityEntry = { name: "ok", line: 1, endLine: 3, cyclomatic: COMMIT_CYCLOMATIC_CAP, language: "js_ts" };
		expect(cyclomaticViolation(SRC, [over])?.kind).toBe("cyclomatic");
		expect(cyclomaticViolation(SRC, [ok])).toBeNull();
	});

	it("honors an explicit (configured) cap, not just the shipped default", () => {
		// A cyclomatic-11 function is fine under the default cap (25) but OVER a repo
		// that ran `interlinked caps set cyclomatic 10`. The commit gate threads the
		// EFFECTIVE per-repo cap (maxCyclomaticFor) here, so it must compare against
		// the passed cap, not a hard-coded 25 (finding 2026-06, round 8).
		const fn: FunctionComplexityEntry = { name: "mid", line: 1, endLine: 9, cyclomatic: 11, language: "js_ts" };
		expect(cyclomaticViolation(SRC, [fn])).toBeNull(); // default cap (25) → fine
		const v = cyclomaticViolation(SRC, [fn], 10); // configured cap 10 → over
		expect(v?.kind).toBe("cyclomatic");
		expect(v?.detail).toContain("(cap 10)");
	});
});

describe("crapViolation", () => {
	it("flags a complex, under-covered function (CRAP ≥ threshold)", () => {
		const cmplx: FunctionComplexityEntry[] = [{ name: "big", line: 1, endLine: 3, cyclomatic: 10, language: "js_ts" }];
		const cov = perFn([{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 }]);
		expect(crapViolation(SRC, cmplx, cov, 30)?.kind).toBe("crap");
	});
});

// THE missing-coverage EXEMPTION (finding 2026-06): only a genuinely type-only file
// escapes the block. Anything unrecognized counts as EXECUTABLE — narrow, never wide.
describe("isTypeOnlySource", () => {
	it("true for type-only files (interfaces / type aliases / type imports / re-exports)", () => {
		expect(
			isTypeOnlySource(
				[
					'import type { A } from "./a";',
					'import { B } from "./b";',
					"export interface T {",
					"\ta: number;",
					"\tb: string;",
					"}",
					"export type U = T | null;",
					'export * from "./shared";',
					'export { B } from "./b";',
				].join("\n"),
			),
		).toBe(true);
	});

	it("true for empty / comment-only files and multi-line type aliases", () => {
		expect(isTypeOnlySource("")).toBe(true);
		expect(isTypeOnlySource("// just a note\n/* and a block\ncomment */\n")).toBe(true);
		expect(isTypeOnlySource("type Wide =\n\t| string\n\t| number;\n")).toBe(true);
		expect(isTypeOnlySource('declare module "x" {\n\tconst y: number;\n}\n')).toBe(true);
	});

	it("false for top-level executable statements (the finding's bypass shapes)", () => {
		expect(isTypeOnlySource('console.log("side effect");\n')).toBe(false);
		expect(isTypeOnlySource("startServer();\n")).toBe(false);
		expect(isTypeOnlySource("export const x = compute();\n")).toBe(false);
	});

	it("false for function/class/enum declarations and side-effect imports", () => {
		expect(isTypeOnlySource("export function f() {\n\treturn 1;\n}\n")).toBe(false);
		expect(isTypeOnlySource("class C {}\n")).toBe(false);
		expect(isTypeOnlySource("export enum Color {\n\tRed,\n}\n")).toBe(false); // enums emit runtime code
		expect(isTypeOnlySource('import "./polyfill";\n')).toBe(false); // runs at load
	});

	it("a single executable line among types makes the file executable", () => {
		expect(isTypeOnlySource('export interface T { a: number }\nconsole.log("x");\n')).toBe(false);
	});
});
