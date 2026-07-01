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
