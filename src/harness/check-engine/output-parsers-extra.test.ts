import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	parseCargoJson,
	parseGolangciLintJson,
	parseOsvScannerJson,
	parseRuffJson,
} from "./output-parsers-extra.js";

describe("parseOsvScannerJson", () => {
	it("returns null when the parsed JSON has no usable 'results' shape", () => {
		expect(parseOsvScannerJson(JSON.stringify(null))).toBeNull();
		expect(parseOsvScannerJson(JSON.stringify({}))).toBeNull();
		expect(parseOsvScannerJson(JSON.stringify({ results: "not-an-array" }))).toBeNull();
	});

	it("skips a 'result' entry with no packages field entirely", () => {
		expect(parseOsvScannerJson(JSON.stringify({ results: [{}] }))).toBeNull();
	});

	it("skips a package with no vulnerabilities field, and a vulnerability with no id", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						// No `vulnerabilities` key at all (buildVulnScoreMap's `?? []`).
						{ groups: [{ ids: ["X"], max_severity: "9.9" }] },
						// A vulnerability entry with no `id` — skipped by `!v.id continue`.
						{ vulnerabilities: [{ severity: [{ score: "9.9" }] }], groups: [{ ids: [] }] },
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ critical: 1, low: 1, total: 2 });
	});

	it("skips a package with no groups field entirely", () => {
		const payload = JSON.stringify({
			results: [{ packages: [{ vulnerabilities: [{ id: "A" }] }] }],
		});
		expect(parseOsvScannerJson(payload)).toBeNull();
	});

	it("buckets every CVSS tier (critical/high/moderate/low) from groups[].max_severity", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{ vulnerabilities: [{ id: "A" }], groups: [{ ids: ["A"], max_severity: "9.8" }] },
						{ vulnerabilities: [{ id: "B" }], groups: [{ ids: ["B"], max_severity: "7.5" }] },
						{ vulnerabilities: [{ id: "C" }], groups: [{ ids: ["C"], max_severity: "5.0" }] },
						{ vulnerabilities: [{ id: "D" }], groups: [{ ids: ["D"], max_severity: "2.0" }] },
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ critical: 1, high: 1, moderate: 1, low: 1, total: 4 });
	});

	it("falls back to per-vuln severity score when max_severity is absent/invalid, preferring the max among a group's ids", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [
								{ id: "A", severity: [{ score: "5.0" }] },
								{ id: "B", severity: [{ score: "9.0" }] },
								{ id: "C", severity: [{ score: "1.0" }] },
							],
							// "missing" has no vulnScore entry (exercises the s===undefined
							// skip); "not-a-number" has an unparseable max_severity (exercises
							// the Number.isNaN(n) skip in resolveGroupScore).
							groups: [{ ids: ["missing", "A", "B", "C"], max_severity: "not-a-number" }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		// Highest of A/B/C is B's 9.0 -> critical bucket.
		expect(r).toMatchObject({ critical: 1, total: 1 });
	});

	it("buckets a group with no ids and no max_severity as low (score stays null)", () => {
		const payload = JSON.stringify({
			results: [{ packages: [{ vulnerabilities: [], groups: [{}] }] }],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ low: 1, total: 1 });
	});

	it("extractNumericScore skips a missing score and a non-numeric score, using the first valid one", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [
								{
									id: "X",
									severity: [{}, { score: "not-a-number" }, { score: "9.1" }],
								},
							],
							groups: [{ ids: ["X"] }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r).toMatchObject({ critical: 1, total: 1 });
	});
});

describe("parseRuffJson", () => {
	it("prefers finding.row/finding.column when present", () => {
		const payload = JSON.stringify([
			{ filename: "a.py", row: 3, column: 1, code: "E1", message: "m1" },
		]);
		const results = parseRuffJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({ line: 3, column: 1 });
	});

	it("falls back to finding.location.row/column when row/column are absent", () => {
		const payload = JSON.stringify([
			{ filename: "a.py", location: { row: 7, column: 4 }, code: "E2", message: "m2" },
		]);
		const results = parseRuffJson(payload);
		expect(nonNull(results[0])).toMatchObject({ line: 7, column: 4 });
	});

	it("defaults line to 0 and column to undefined when neither row nor location is present", () => {
		const payload = JSON.stringify([{ filename: "a.py", code: "E3", message: "m3" }]);
		const results = parseRuffJson(payload);
		expect(nonNull(results[0])).toMatchObject({ line: 0 });
		expect(nonNull(results[0]).column).toBeUndefined();
	});

	it("defaults file to '' when filename is absent", () => {
		const payload = JSON.stringify([{ row: 1, code: "E4", message: "m4" }]);
		const results = parseRuffJson(payload);
		expect(nonNull(results[0]).file).toBe("");
	});
});

describe("parseCargoJson", () => {
	it("parses an error-level compiler-message with a full span, and maps a non-error level to warning with defaults", () => {
		const lines = [
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "error",
					spans: [{ file_name: "a.rs", line_start: 5, column_start: 2 }],
					message: "boom",
					code: { code: "E001" },
				},
			}),
			JSON.stringify({
				reason: "compiler-message",
				message: {
					level: "warning",
					spans: [{}],
				},
			}),
		];
		const results = parseCargoJson(lines.join("\n"), "cargo-check");
		expect(results).toHaveLength(2);
		expect(nonNull(results[0])).toMatchObject({
			tool: "cargo-check",
			severity: "error",
			file: "a.rs",
			line: 5,
			column: 2,
			message: "boom",
			ruleId: "E001",
		});
		expect(nonNull(results[1])).toMatchObject({
			tool: "cargo-check",
			severity: "warning",
			file: "",
			line: 0,
			message: "",
			ruleId: undefined,
		});
	});
});

describe("parseGolangciLintJson", () => {
	it("reads file/line from issue.Pos when present", () => {
		const payload = JSON.stringify({
			Issues: [{ FromLinter: "govet", Text: "bad", Pos: { Filename: "a.go", Line: 10, Column: 2 } }],
		});
		const results = parseGolangciLintJson(payload);
		expect(nonNull(results[0])).toMatchObject({ file: "a.go", line: 10, column: 2 });
	});

	it("defaults file to '' and line to 0 when issue.Pos is entirely absent", () => {
		const payload = JSON.stringify({ Issues: [{ FromLinter: "govet", Text: "bad" }] });
		const results = parseGolangciLintJson(payload);
		expect(nonNull(results[0])).toMatchObject({ file: "", line: 0 });
		expect(nonNull(results[0]).column).toBeUndefined();
	});
});
