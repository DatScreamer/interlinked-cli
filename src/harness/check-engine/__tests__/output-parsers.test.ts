import { describe, expect, it } from "vitest";
import {
	filterResultsToFile,
	parseBiomeOutput,
	parseEslintOutput,
	parseGitleaksJson,
	parseHadolintJson,
	parseMypyOutput,
	parseNpmAuditJson,
	parseOsvScannerJson,
	parseRuffJson,
	parseSemgrepJson,
	parseShellcheckJson,
	parseTscOutput,
} from "../output-parsers.js";
import { nonNull } from "../../../lib/non-null.js";

describe("parseTscOutput", () => {
	it("parses file-level errors with line/column/ruleId", () => {
		const out = "src/a.ts(12,5): error TS2345: Argument not assignable";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			tool: "tsc",
			severity: "error",
			file: "src/a.ts",
			line: 12,
			column: 5,
			ruleId: "TS2345",
		});
	});

	it("parses project-level errors without a file reference", () => {
		const out = "error TS2688: Cannot find type definition for 'node'.";
		const results = parseTscOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("tsconfig.json");
	});

	it("returns [] on empty output", () => {
		expect(parseTscOutput("")).toEqual([]);
	});
});

describe("parseBiomeOutput", () => {
	it("parses biome lint lines", () => {
		const out = "src/a.ts:10:5 lint/suspicious/noDoubleEquals ━━━━━━";
		const results = parseBiomeOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).tool).toBe("biome");
		expect(nonNull(results[0]).ruleId).toBe("lint/suspicious/noDoubleEquals");
	});

	it("returns [] on empty output", () => {
		expect(parseBiomeOutput("")).toEqual([]);
	});
});

describe("parseEslintOutput", () => {
	it("parses eslint --format unix output with rule id", () => {
		const out = "src/a.ts:5:10: Missing semicolon. [semi]";
		const results = parseEslintOutput(out);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBe("semi");
	});
});

describe("parseMypyOutput", () => {
	it("parses standard mypy output", () => {
		const out = "foo.py:5: error: Incompatible return type [return-value]";
		const results = parseMypyOutput(out);
		expect(results.length).toBeGreaterThan(0);
		expect(nonNull(results[0]).tool).toBe("mypy");
	});

	it("returns [] on empty", () => {
		expect(parseMypyOutput("")).toEqual([]);
	});
});

describe("parseRuffJson", () => {
	it("parses ruff's JSON array format", () => {
		const payload = JSON.stringify([
			{
				filename: "foo.py",
				location: { row: 3, column: 1 },
				code: "E501",
				message: "line too long",
			},
		]);
		const results = parseRuffJson(payload);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBe("E501");
	});

	it("returns [] on malformed JSON", () => {
		expect(parseRuffJson("not json")).toEqual([]);
	});
});

describe("parseSemgrepJson", () => {
	it("parses semgrep results with check_id / start.line", () => {
		const payload = JSON.stringify({
			results: [
				{
					check_id: "demo.rule",
					path: "/proj/src/a.ts",
					start: { line: 10, col: 1 },
					extra: { severity: "ERROR", message: "uh oh" },
				},
			],
		});
		const results = parseSemgrepJson(payload, "/proj");
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).tool).toBe("semgrep");
	});

	it("returns [] on malformed JSON", () => {
		expect(parseSemgrepJson("not json", "/tmp")).toEqual([]);
	});
});

describe("parseGitleaksJson", () => {
	it("parses the gitleaks json array", () => {
		const payload = JSON.stringify([
			{
				File: "src/a.ts",
				StartLine: 7,
				Description: "generic api key",
				RuleID: "generic-api-key",
				Secret: "x",
			},
		]);
		const results = parseGitleaksJson(payload);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).severity).toBe("error");
	});

	it("returns [] on empty / non-array", () => {
		expect(parseGitleaksJson("")).toEqual([]);
		expect(parseGitleaksJson("{}")).toEqual([]);
	});
});

describe("parseNpmAuditJson", () => {
	it("extracts vulnerability counts", () => {
		const payload = JSON.stringify({
			metadata: {
				vulnerabilities: { critical: 2, high: 0, moderate: 1, low: 0, total: 3 },
			},
		});
		const r = parseNpmAuditJson(payload);
		expect(r?.critical).toBe(2);
		expect(r?.moderate).toBe(1);
	});

	it("returns null on malformed JSON", () => {
		expect(parseNpmAuditJson("garbage")).toBeNull();
	});
});

describe("parseOsvScannerJson", () => {
	it("returns null on malformed JSON", () => {
		expect(parseOsvScannerJson("garbage")).toBeNull();
	});

	it("returns null when there are no vulnerabilities", () => {
		expect(parseOsvScannerJson(JSON.stringify({ results: [] }))).toBeNull();
	});

	it("buckets groups[].max_severity into CVSS v3 severity tiers", () => {
		const payload = JSON.stringify({
			results: [
				{
					source: { path: "/p/go.mod", type: "lockfile" },
					packages: [
						{
							package: { name: "a", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-1" }],
							groups: [{ ids: ["GO-1"], max_severity: "9.8" }],
						},
						{
							package: { name: "b", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-2" }],
							groups: [{ ids: ["GO-2"], max_severity: "7.5" }],
						},
						{
							package: { name: "c", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-3" }],
							groups: [{ ids: ["GO-3"], max_severity: "5.0" }],
						},
						{
							package: { name: "d", version: "1", ecosystem: "Go" },
							vulnerabilities: [{ id: "GO-4" }],
							groups: [{ ids: ["GO-4"], max_severity: "2.0" }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r?.tool).toBe("osv-scanner");
		expect(r?.critical).toBe(1);
		expect(r?.high).toBe(1);
		expect(r?.moderate).toBe(1);
		expect(r?.low).toBe(1);
		expect(r?.total).toBe(4);
		expect(r?.detail).toContain("GO-1");
	});

	it("falls back to vulnerabilities[].severity numeric score when max_severity absent", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [{ id: "X", severity: [{ type: "CVSS_V3", score: "8.1" }] }],
							groups: [{ ids: ["X"] }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r?.high).toBe(1);
		expect(r?.total).toBe(1);
	});

	it("CVSS vector strings without max_severity bucket as low (no inline calc)", () => {
		const payload = JSON.stringify({
			results: [
				{
					packages: [
						{
							vulnerabilities: [
								{
									id: "Y",
									severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N" }],
								},
							],
							groups: [{ ids: ["Y"] }],
						},
					],
				},
			],
		});
		const r = parseOsvScannerJson(payload);
		expect(r?.low).toBe(1);
	});

	it("caps topIds at 5", () => {
		const packages = Array.from({ length: 10 }, (_, i) => ({
			vulnerabilities: [{ id: `V-${i}` }],
			groups: [{ ids: [`V-${i}`], max_severity: "5.0" }],
		}));
		const r = parseOsvScannerJson(JSON.stringify({ results: [{ packages }] }));
		expect(r?.total).toBe(10);
		const idsInDetail = (r?.detail ?? "").split(" — ")[1]?.split(", ") ?? [];
		expect(idsInDetail).toHaveLength(5);
	});
});

describe("parseShellcheckJson", () => {
	it("parses shellcheck's { comments: [...] } payload", () => {
		const payload = JSON.stringify({
			comments: [
				{
					file: "a.sh",
					line: 5,
					column: 2,
					level: "warning",
					code: 2086,
					message: "quote this",
				},
			],
		});
		const results = parseShellcheckJson(payload);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).ruleId).toMatch(/^SC\d+/);
	});

	it("returns [] on malformed JSON", () => {
		expect(parseShellcheckJson("not json")).toEqual([]);
	});
});

describe("parseHadolintJson", () => {
	it("parses hadolint's JSON diagnostics", () => {
		const payload = JSON.stringify([
			{
				file: "Dockerfile",
				line: 3,
				column: 1,
				level: "warning",
				code: "DL3003",
				message: "x",
			},
		]);
		const results = parseHadolintJson(payload);
		expect(results.length).toBe(1);
	});
});

describe("filterResultsToFile", () => {
	it("narrows results to a single target file", () => {
		const all = [
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/a.ts",
				line: 1,
				message: "x",
			},
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/b.ts",
				line: 1,
				message: "y",
			},
		];
		const filtered = filterResultsToFile(all, "/p/a.ts");
		expect(filtered.length).toBe(1);
		expect(nonNull(filtered[0]).file).toBe("/p/a.ts");
	});

	it("is an identity when no match", () => {
		const all = [
			{
				tool: "tsc" as const,
				severity: "error" as const,
				file: "/p/a.ts",
				line: 1,
				message: "x",
			},
		];
		expect(filterResultsToFile(all, "/p/other.ts")).toEqual([]);
	});
});
