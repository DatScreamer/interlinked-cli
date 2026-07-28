// ===========================================
// Check Engine — Unit Tests
// ===========================================

import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { deduplicateResults } from "../index.js";
import {
	filterResultsToFile,
	parseBiomeOutput,
	parseCargoJson,
	parseClangTidyOutput,
	parseEslintOutput,
	parseGccOutput,
	parseGitleaksJson,
	parseGoBuildOutput,
	parseGolangciLintJson,
	parseMypyOutput,
	parseNpmAuditJson,
	parseOxlintJson,
	parseRuffJson,
	parseSemgrepJson,
	parseTscOutput,
} from "../output-parsers.js";
import type { CheckResult } from "../types.js";

// -------------------------------------------
// parseTscOutput
// -------------------------------------------

describe("parseTscOutput", () => {
	it("parses standard tsc error output", () => {
		const output = [
			"src/foo.ts(42,5): error TS2345: Argument of type 'string' is not assignable.",
			"src/bar.ts(10,1): error TS1234: Some other error.",
			"Found 2 errors.",
		].join("\n");

		const results = parseTscOutput(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "tsc",
			severity: "error",
			file: "src/foo.ts",
			line: 42,
			column: 5,
			message: "TS2345: Argument of type 'string' is not assignable.",
			ruleId: "TS2345",
		});
		expect(nonNull(results[1]).file).toBe("src/bar.ts");
		expect(nonNull(results[1]).line).toBe(10);
	});

	it("returns empty for clean output", () => {
		expect(parseTscOutput("")).toHaveLength(0);
		expect(parseTscOutput("No errors found.\n")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseBiomeOutput
// -------------------------------------------

describe("parseBiomeOutput", () => {
	it("parses biome lint output", () => {
		const output = [
			"src/foo.ts:15:3 lint/suspicious/noDoubleEquals ━━━━━━━━━",
			"src/bar.ts:8:1 format ━━━━━━━━━",
		].join("\n");

		const results = parseBiomeOutput(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "biome",
			severity: "warning",
			file: "src/foo.ts",
			line: 15,
			column: 3,
			message: "lint/suspicious/noDoubleEquals",
			ruleId: "lint/suspicious/noDoubleEquals",
		});
		expect(nonNull(results[1]).message).toBe("format");
	});

	it("returns empty for clean output", () => {
		expect(parseBiomeOutput("Checked 5 files in 10ms.\n")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseEslintOutput
// -------------------------------------------

describe("parseEslintOutput", () => {
	it("parses eslint unix format output", () => {
		const output = "src/foo.ts:10:5: 'x' is never used [no-unused-vars]\n";
		const results = parseEslintOutput(output);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/foo.ts");
		expect(nonNull(results[0]).line).toBe(10);
		expect(nonNull(results[0]).ruleId).toBe("no-unused-vars");
	});
});

// -------------------------------------------
// parseSemgrepJson
// -------------------------------------------

describe("parseSemgrepJson", () => {
	it("parses semgrep JSON output", () => {
		const output = JSON.stringify({
			results: [
				{
					path: "/project/src/handler.ts",
					start: { line: 42, col: 5 },
					check_id: "javascript.lang.security.detect-eval",
					extra: { message: "Detected eval usage" },
				},
			],
		});

		const results = parseSemgrepJson(output, "/project");
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("src/handler.ts");
		expect(nonNull(results[0]).ruleId).toBe("javascript.lang.security.detect-eval");
	});

	it("returns empty for invalid JSON", () => {
		expect(parseSemgrepJson("not json", "/project")).toHaveLength(0);
	});

	it("returns empty for no results", () => {
		expect(parseSemgrepJson(JSON.stringify({ results: [] }), "/project")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseGitleaksJson
// -------------------------------------------

describe("parseGitleaksJson", () => {
	it("parses gitleaks JSON output", () => {
		const output = JSON.stringify([
			{
				File: "src/config.ts",
				StartLine: 5,
				RuleID: "aws-access-key-id",
				Description: "AWS Access Key",
			},
		]);

		const results = parseGitleaksJson(output);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).severity).toBe("error");
		expect(nonNull(results[0]).ruleId).toBe("aws-access-key-id");
	});

	it("returns empty for invalid JSON", () => {
		expect(parseGitleaksJson("not json")).toHaveLength(0);
	});

	it("returns empty for non-array JSON", () => {
		expect(parseGitleaksJson(JSON.stringify({ error: "oops" }))).toHaveLength(0);
	});
});

// -------------------------------------------
// parseNpmAuditJson
// -------------------------------------------

describe("parseNpmAuditJson", () => {
	it("parses npm audit JSON output", () => {
		const output = JSON.stringify({
			metadata: {
				vulnerabilities: { critical: 1, high: 3, moderate: 2, low: 0 },
			},
		});

		const result = parseNpmAuditJson(output);
		expect(result).not.toBeNull();
		expect(result!.total).toBe(6);
		expect(result!.critical).toBe(1);
		expect(result!.high).toBe(3);
		expect(result!.detail).toBe("1 critical, 3 high, 2 moderate");
	});

	it("returns null for zero vulnerabilities", () => {
		const output = JSON.stringify({
			metadata: {
				vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
			},
		});
		expect(parseNpmAuditJson(output)).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		expect(parseNpmAuditJson("not json")).toBeNull();
	});
});

// -------------------------------------------
// filterResultsToFile
// -------------------------------------------

describe("filterResultsToFile", () => {
	const results: CheckResult[] = [
		{ tool: "tsc", severity: "error", file: "src/foo.ts", line: 1, message: "err1" },
		{ tool: "tsc", severity: "error", file: "src/bar.ts", line: 2, message: "err2" },
		{ tool: "tsc", severity: "error", file: "src/foo.ts", line: 3, message: "err3" },
	];

	it("filters to matching file", () => {
		const filtered = filterResultsToFile(results, "src/foo.ts");
		expect(filtered).toHaveLength(2);
		expect(filtered.every((r) => r.file === "src/foo.ts")).toBe(true);
	});

	it("matches by suffix", () => {
		const filtered = filterResultsToFile(results, "foo.ts");
		expect(filtered).toHaveLength(2);
	});

	it("returns empty when no match", () => {
		expect(filterResultsToFile(results, "src/baz.ts")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseMypyOutput
// -------------------------------------------

describe("parseMypyOutput", () => {
	it("parses standard mypy error output", () => {
		const output = [
			"app/main.py:42: error: Incompatible types in assignment  [assignment]",
			'app/utils.py:10: warning: Unused "type: ignore" comment  [unused-ignore]',
		].join("\n");

		const results = parseMypyOutput(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "mypy",
			severity: "error",
			file: "app/main.py",
			line: 42,
			message: "Incompatible types in assignment",
			ruleId: "assignment",
		});
		expect(nonNull(results[1]).severity).toBe("warning");
		expect(nonNull(results[1]).ruleId).toBe("unused-ignore");
	});

	it("returns empty for clean output", () => {
		expect(parseMypyOutput("Success: no issues found in 15 source files\n")).toHaveLength(0);
	});

	it("handles lines without error code brackets", () => {
		const output = "app/main.py:5: error: Missing return statement\n";
		const results = parseMypyOutput(output);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).ruleId).toBeUndefined();
	});

	it("skips note-level messages", () => {
		const output = 'app/main.py:5: note: Revealed type is "builtins.str"\n';
		expect(parseMypyOutput(output)).toHaveLength(0);
	});
});

// -------------------------------------------
// parseRuffJson
// -------------------------------------------

describe("parseRuffJson", () => {
	it("parses ruff JSON output", () => {
		const output = JSON.stringify([
			{
				filename: "app/main.py",
				row: 15,
				column: 1,
				code: "F401",
				message: "os imported but unused",
			},
			{ filename: "app/utils.py", row: 8, column: 5, code: "E501", message: "Line too long" },
		]);

		const results = parseRuffJson(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "ruff",
			severity: "warning",
			file: "app/main.py",
			line: 15,
			column: 1,
			message: "F401: os imported but unused",
			ruleId: "F401",
		});
	});

	it("returns empty for invalid JSON", () => {
		expect(parseRuffJson("not json")).toHaveLength(0);
	});

	it("returns empty for empty array", () => {
		expect(parseRuffJson("[]")).toHaveLength(0);
	});

	it("returns empty for non-array JSON", () => {
		expect(parseRuffJson(JSON.stringify({ error: "oops" }))).toHaveLength(0);
	});
});

// -------------------------------------------
// parseCargoJson
// -------------------------------------------

describe("parseCargoJson", () => {
	it("parses cargo check/clippy NDJSON output", () => {
		const lines = [
			JSON.stringify({
				reason: "compiler-artifact",
				target: { name: "mylib" },
			}),
			JSON.stringify({
				reason: "compiler-message",
				message: {
					message: "unused variable: `x`",
					level: "warning",
					code: { code: "unused_variables" },
					spans: [{ file_name: "src/main.rs", line_start: 10, column_start: 9 }],
				},
			}),
			JSON.stringify({
				reason: "compiler-message",
				message: {
					message: "cannot find value `y`",
					level: "error",
					code: { code: "E0425" },
					spans: [{ file_name: "src/lib.rs", line_start: 5, column_start: 1 }],
				},
			}),
		].join("\n");

		const results = parseCargoJson(lines, "cargo-check");
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "cargo-check",
			severity: "warning",
			file: "src/main.rs",
			line: 10,
			column: 9,
			message: "unused variable: `x`",
			ruleId: "unused_variables",
		});
		expect(nonNull(results[1]).severity).toBe("error");
		expect(nonNull(results[1]).ruleId).toBe("E0425");
	});

	it("uses provided toolId for cargo-clippy", () => {
		const line = JSON.stringify({
			reason: "compiler-message",
			message: {
				message: "redundant clone",
				level: "warning",
				code: { code: "clippy::redundant_clone" },
				spans: [{ file_name: "src/main.rs", line_start: 1, column_start: 1 }],
			},
		});

		const results = parseCargoJson(line, "cargo-clippy");
		expect(nonNull(results[0]).tool).toBe("cargo-clippy");
	});

	it("skips messages with no spans", () => {
		const line = JSON.stringify({
			reason: "compiler-message",
			message: { message: "aborting due to previous error", level: "error", spans: [] },
		});
		expect(parseCargoJson(line, "cargo-check")).toHaveLength(0);
	});

	it("returns empty for non-JSON", () => {
		expect(parseCargoJson("   Compiling mylib v0.1.0\n", "cargo-check")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseGoBuildOutput
// -------------------------------------------

describe("parseGoBuildOutput", () => {
	it("parses go build error output", () => {
		const output =
			"main.go:15:10: undefined: someFunc\nutils.go:8:1: syntax error: unexpected }\n";
		const results = parseGoBuildOutput(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "go-build",
			severity: "error",
			file: "main.go",
			line: 15,
			column: 10,
			message: "undefined: someFunc",
		});
		expect(nonNull(results[1]).file).toBe("utils.go");
	});

	it("returns empty for clean build", () => {
		expect(parseGoBuildOutput("")).toHaveLength(0);
	});

	it("ignores non-matching lines", () => {
		expect(parseGoBuildOutput("# mypackage\n")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseGolangciLintJson
// -------------------------------------------

describe("parseGolangciLintJson", () => {
	it("parses golangci-lint JSON output", () => {
		const output = JSON.stringify({
			Issues: [
				{
					FromLinter: "govet",
					Text: "printf: Sprintf format has no verbs",
					Pos: { Filename: "main.go", Line: 42, Column: 5 },
				},
				{
					FromLinter: "errcheck",
					Text: "Error return value not checked",
					Pos: { Filename: "handler.go", Line: 10, Column: 1 },
				},
			],
		});

		const results = parseGolangciLintJson(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "golangci-lint",
			severity: "warning",
			file: "main.go",
			line: 42,
			column: 5,
			message: "govet: printf: Sprintf format has no verbs",
			ruleId: "govet",
		});
	});

	it("returns empty for invalid JSON", () => {
		expect(parseGolangciLintJson("not json")).toHaveLength(0);
	});

	it("returns empty for no issues", () => {
		expect(parseGolangciLintJson(JSON.stringify({ Issues: [] }))).toHaveLength(0);
	});

	it("returns empty when Issues is missing", () => {
		expect(parseGolangciLintJson(JSON.stringify({}))).toHaveLength(0);
	});
});

// -------------------------------------------
// parseGccOutput
// -------------------------------------------

describe("parseGccOutput", () => {
	it("parses gcc/clang error and warning output", () => {
		const output = [
			"main.c:10:5: error: expected ';' after expression",
			"utils.h:3:1: warning: unused variable 'x' [-Wunused-variable]",
		].join("\n");

		const results = parseGccOutput(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "c-compile",
			severity: "error",
			file: "main.c",
			line: 10,
			column: 5,
			message: "expected ';' after expression",
			ruleId: undefined,
		});
		expect(nonNull(results[1]).severity).toBe("warning");
		expect(nonNull(results[1]).ruleId).toBe("-Wunused-variable");
	});

	it("parses fatal error", () => {
		const output = "main.c:1:10: fatal error: 'missing.h' file not found\n";
		const results = parseGccOutput(output);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).severity).toBe("error");
	});

	it("handles C++ file extensions", () => {
		const output = "main.cpp:5:3: error: use of undeclared identifier\n";
		const results = parseGccOutput(output);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).file).toBe("main.cpp");
	});

	it("returns empty for clean compile", () => {
		expect(parseGccOutput("")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseClangTidyOutput
// -------------------------------------------

describe("parseClangTidyOutput", () => {
	it("parses clang-tidy output", () => {
		const output =
			"main.cpp:15:10: warning: use of 'strcpy' is insecure [bugprone-not-null-terminated-result]\n";
		const results = parseClangTidyOutput(output);
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			tool: "clang-tidy",
			severity: "warning",
			file: "main.cpp",
			line: 15,
			column: 10,
			message: "use of 'strcpy' is insecure",
			ruleId: "bugprone-not-null-terminated-result",
		});
	});

	it("parses error severity", () => {
		const output = "main.c:1:1: error: unknown type name 'foo' [clang-diagnostic-error]\n";
		const results = parseClangTidyOutput(output);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).severity).toBe("error");
	});

	it("skips note-level messages", () => {
		const output =
			"main.c:5:1: note: previous definition is here [misc-definitions-in-headers]\n";
		expect(parseClangTidyOutput(output)).toHaveLength(0);
	});

	it("returns empty for clean output", () => {
		expect(parseClangTidyOutput("")).toHaveLength(0);
	});
});

// -------------------------------------------
// parseOxlintJson
// -------------------------------------------

describe("parseOxlintJson", () => {
	it("parses oxlint JSON output", () => {
		const output = JSON.stringify({
			diagnostics: [
				{
					message: "Catch parameter '_err' is caught but never used.",
					code: "eslint(no-unused-vars)",
					severity: "warning",
					filename: "src/commands/send.ts",
					labels: [{ span: { offset: 943, length: 4, line: 33, column: 12 } }],
				},
				{
					message: "Use of eval is not allowed",
					code: "eslint(no-eval)",
					severity: "error",
					filename: "src/utils.ts",
					labels: [{ span: { offset: 100, length: 4, line: 5, column: 1 } }],
				},
			],
		});

		const results = parseOxlintJson(output);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			tool: "oxlint",
			severity: "warning",
			file: "src/commands/send.ts",
			line: 33,
			column: 12,
			message: "Catch parameter '_err' is caught but never used.",
			ruleId: "eslint(no-unused-vars)",
		});
		expect(nonNull(results[1]).severity).toBe("error");
		expect(nonNull(results[1]).ruleId).toBe("eslint(no-eval)");
	});

	it("returns empty for invalid JSON", () => {
		expect(parseOxlintJson("not json")).toHaveLength(0);
	});

	it("returns empty for empty diagnostics", () => {
		expect(parseOxlintJson(JSON.stringify({ diagnostics: [] }))).toHaveLength(0);
	});

	it("returns empty when diagnostics is missing", () => {
		expect(parseOxlintJson(JSON.stringify({}))).toHaveLength(0);
	});
});

// -------------------------------------------
// deduplicateResults
// -------------------------------------------

describe("deduplicateResults", () => {
	it("removes exact duplicates from different tools", () => {
		const results: CheckResult[] = [
			{
				tool: "biome",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "unused variable 'x'",
			},
			{
				tool: "eslint",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "unused variable 'x'",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(1);
		expect(removedCount).toBe(1);
		// Keeps the first (higher-priority tool)
		expect(nonNull(deduplicated[0]).tool).toBe("biome");
	});

	it("keeps higher severity when duplicates differ in severity", () => {
		const results: CheckResult[] = [
			{
				tool: "biome",
				severity: "warning",
				file: "src/foo.ts",
				line: 5,
				message: "some issue",
			},
			{
				tool: "eslint",
				severity: "error",
				file: "src/foo.ts",
				line: 5,
				message: "some issue",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(1);
		expect(removedCount).toBe(1);
		expect(nonNull(deduplicated[0]).severity).toBe("error");
		expect(nonNull(deduplicated[0]).tool).toBe("eslint");
	});

	it("does not deduplicate findings on different lines", () => {
		const results: CheckResult[] = [
			{
				tool: "biome",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "unused variable 'x'",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "src/foo.ts",
				line: 20,
				message: "unused variable 'x'",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(2);
		expect(removedCount).toBe(0);
	});

	it("does not deduplicate findings in different files", () => {
		const results: CheckResult[] = [
			{ tool: "tsc", severity: "error", file: "src/a.ts", line: 1, message: "Type error" },
			{ tool: "tsc", severity: "error", file: "src/b.ts", line: 1, message: "Type error" },
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(2);
		expect(removedCount).toBe(0);
	});

	it("normalizes whitespace and casing for dedup", () => {
		const results: CheckResult[] = [
			{
				tool: "biome",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "Unused  variable   'x'",
			},
			{
				tool: "eslint",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "unused variable 'x'",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(1);
		expect(removedCount).toBe(1);
	});

	it("strips leading rule ID prefixes for dedup", () => {
		const results: CheckResult[] = [
			{
				tool: "biome",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "lint/suspicious/noDoubleEquals: Use === instead",
			},
			{
				tool: "eslint",
				severity: "warning",
				file: "src/foo.ts",
				line: 10,
				message: "Use === instead",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(1);
		expect(removedCount).toBe(1);
	});

	it("returns zero removedCount when no duplicates", () => {
		const results: CheckResult[] = [
			{
				tool: "tsc",
				severity: "error",
				file: "src/foo.ts",
				line: 1,
				message: "Type 'string' not assignable",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "src/bar.ts",
				line: 5,
				message: "Unused import",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(2);
		expect(removedCount).toBe(0);
	});

	it("handles empty input", () => {
		const { deduplicated, removedCount } = deduplicateResults([]);
		expect(deduplicated).toHaveLength(0);
		expect(removedCount).toBe(0);
	});

	it("deduplicates cargo-check and cargo-clippy overlap", () => {
		const results: CheckResult[] = [
			{
				tool: "cargo-check",
				severity: "warning",
				file: "src/main.rs",
				line: 10,
				message: "unused variable: `x`",
				ruleId: "unused_variables",
			},
			{
				tool: "cargo-clippy",
				severity: "warning",
				file: "src/main.rs",
				line: 10,
				message: "unused variable: `x`",
				ruleId: "unused_variables",
			},
		];
		const { deduplicated, removedCount } = deduplicateResults(results);
		expect(deduplicated).toHaveLength(1);
		expect(removedCount).toBe(1);
		// cargo-check comes first in registry, so it wins on tie
		expect(nonNull(deduplicated[0]).tool).toBe("cargo-check");
	});
});
