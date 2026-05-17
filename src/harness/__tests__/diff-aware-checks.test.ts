import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { QualityCheckOptions } from "../quality-checks.js";
import type { HarnessEvent } from "../types.js";

// Mock the file system and subprocess calls so runQualityChecks doesn't hit disk
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		// Return true for the source file itself, false for test file candidates
		existsSync: vi.fn((p: string) => {
			if (
				typeof p === "string" &&
				(p.includes(".test.") || p.includes(".spec.") || p.includes("__tests__"))
			) {
				return false;
			}
			return true;
		}),
		readFileSync: vi.fn(() => MOCK_FILE_CONTENT),
	};
});

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", error: null })),
	execSync: vi.fn(() => ""),
}));

// Mock the check engine so subprocess-based checks are no-ops
vi.mock("../check-engine/index.js", () => ({
	configNameToToolId: vi.fn(() => null),
	getOrCreateEngine: vi.fn(() => ({
		runChecks: () => ({
			results: [],
			elapsedMs: 0,
			toolsRun: [],
			toolsSkipped: [],
			metrics: [],
			deduplicatedCount: 0,
		}),
	})),
}));

let MOCK_FILE_CONTENT = "";

import { snapshotDryShingles } from "../checks/dry-baseline.js";
import { runQualityChecks } from "../quality-checks.js";

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: FIXED_TIMESTAMP,
		tool_name: "Edit",
		tool_input: {
			file_path: "/project/src/example.ts",
			old_string: "const x = 1;",
			new_string: "const x = 2;",
		},
		...overrides,
	};
}

const BASIC_CHECKS = {
	typescript: {
		enabled: false,
		file_types: [".ts"],
		timeout_ms: 5000,
		severity: "error" as const,
	},
	biome_lint: {
		enabled: false,
		file_types: [".ts"],
		timeout_ms: 5000,
		severity: "warning" as const,
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	MOCK_FILE_CONTENT = "";
});

// ===========================================
// missing_return_types: baseline subtraction
// ===========================================
describe("diff-aware: missing_return_types baseline subtraction", () => {
	const fileWithTwoMissing = [
		"export function oldFunc(x: number) { return x; }",
		"export function newFunc(y: string) { return y; }",
	].join("\n");

	it("reports all findings when no baseline is provided", async () => {
		MOCK_FILE_CONTENT = fileWithTwoMissing;
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project");
		const mrt = results.filter((r) => r.name === "missing_return_types");
		expect(mrt).toHaveLength(1);
		expect(mrt[0].message).toContain("2 exported function(s)");
	});

	it("filters out pre-existing findings when baseline is provided", async () => {
		MOCK_FILE_CONTENT = fileWithTwoMissing;
		const options: QualityCheckOptions = {
			baseline: {
				missingReturnTypes: new Set(["export function oldFunc(x: number) { return x; }"]),
				complexFunctions: new Set(),
				capturedAt: FIXED_NOW,
				suppressionCount: 0,
				asAnyCastCount: 0,
				nonNullAssertionCount: 0,
			},
			diffAware: {
				enabled: true,
				missing_return_types: "baseline",
			},
		};
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", options);
		const mrt = results.filter((r) => r.name === "missing_return_types");
		expect(mrt).toHaveLength(1);
		expect(mrt[0].message).toContain("1 exported function(s)");
	});

	it("reports all findings when diff_aware is disabled", async () => {
		MOCK_FILE_CONTENT = fileWithTwoMissing;
		const options: QualityCheckOptions = {
			baseline: {
				missingReturnTypes: new Set(["export function oldFunc(x: number) { return x; }"]),
				complexFunctions: new Set(),
				capturedAt: FIXED_NOW,
				suppressionCount: 0,
				asAnyCastCount: 0,
				nonNullAssertionCount: 0,
			},
			diffAware: {
				enabled: false,
			},
		};
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", options);
		const mrt = results.filter((r) => r.name === "missing_return_types");
		expect(mrt).toHaveLength(1);
		expect(mrt[0].message).toContain("2 exported function(s)");
	});

	it("reports all findings when missing_return_types strategy is 'off'", async () => {
		MOCK_FILE_CONTENT = fileWithTwoMissing;
		const options: QualityCheckOptions = {
			baseline: {
				missingReturnTypes: new Set(["export function oldFunc(x: number) { return x; }"]),
				complexFunctions: new Set(),
				capturedAt: FIXED_NOW,
				suppressionCount: 0,
				asAnyCastCount: 0,
				nonNullAssertionCount: 0,
			},
			diffAware: {
				enabled: true,
				missing_return_types: "off",
			},
		};
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", options);
		const mrt = results.filter((r) => r.name === "missing_return_types");
		expect(mrt).toHaveLength(1);
		expect(mrt[0].message).toContain("2 exported function(s)");
	});

	it("suppresses all findings when baseline matches everything", async () => {
		MOCK_FILE_CONTENT = fileWithTwoMissing;
		const options: QualityCheckOptions = {
			baseline: {
				missingReturnTypes: new Set([
					"export function oldFunc(x: number) { return x; }",
					"export function newFunc(y: string) { return y; }",
				]),
				complexFunctions: new Set(),
				capturedAt: FIXED_NOW,
				suppressionCount: 0,
				asAnyCastCount: 0,
				nonNullAssertionCount: 0,
			},
			diffAware: {
				enabled: true,
				missing_return_types: "baseline",
			},
		};
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", options);
		const mrt = results.filter((r) => r.name === "missing_return_types");
		expect(mrt).toHaveLength(0);
	});
});

// ===========================================
// code_clones: baseline subtraction
// ===========================================
describe("diff-aware: code_clones baseline subtraction", () => {
	const cloneBody = `{
		const out: number[] = [];
		for (const row of rows) {
			if (row.enabled) {
				out.push(row.value);
			}
		}
		return out;
	}`;

	const oneClone = `type Row = { enabled: boolean; value: number };
function collectA(rows: Row[]): number[] ${cloneBody}
`;

	const twoClones = `type Row = { enabled: boolean; value: number };
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;

	function baselineFor(
		preContent: string,
		filePath = "/project/src/example.ts",
	): QualityCheckOptions["baseline"] {
		return {
			missingReturnTypes: new Set(),
			complexFunctions: new Set(),
			capturedAt: FIXED_NOW,
			suppressionCount: 0,
			asAnyCastCount: 0,
			nonNullAssertionCount: 0,
			dryCloneBaseline: snapshotDryShingles({
				preContent,
				filePath,
				candidates: [],
			}),
		};
	}

	it("suppresses pre-existing clones when the edit touched unrelated content", async () => {
		MOCK_FILE_CONTENT = `${twoClones}\nconst unrelated = 2;\n`;
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", {
			baseline: baselineFor(`${twoClones}\nconst unrelated = 1;\n`),
			diffAware: { enabled: true },
		});
		expect(results.filter((r) => r.name === "code_clones")).toEqual([]);
	});

	it("suppresses pre-existing clones when the hook path is relative", async () => {
		MOCK_FILE_CONTENT = `${twoClones}\nconst unrelated = 2;\n`;
		const relativeHookPath = "src/example.ts";
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: relativeHookPath,
					old_string: "const unrelated = 1;",
					new_string: "const unrelated = 2;",
				},
			}),
			BASIC_CHECKS,
			"/project",
			{
				baseline: baselineFor(
					`${twoClones}\nconst unrelated = 1;\n`,
					resolve("/project", relativeHookPath),
				),
				diffAware: { enabled: true },
			},
		);
		expect(results.filter((r) => r.name === "code_clones")).toEqual([]);
	});

	it("reports a clone pair newly introduced by the edit", async () => {
		MOCK_FILE_CONTENT = twoClones;
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", {
			baseline: baselineFor(oneClone),
			diffAware: { enabled: true },
		});
		const cloneResults = results.filter((r) => r.name === "code_clones");
		expect(cloneResults).toHaveLength(1);
		expect(cloneResults[0].detail).toContain("collectA()");
	});
});

// ===========================================
// no_test_file: new-file-only gate
// ===========================================
describe("diff-aware: no_test_file new-file-only gate", () => {
	it("suppresses no_test_file for Edit tool (existing file)", async () => {
		MOCK_FILE_CONTENT = "export function foo() { return 1; }";
		const results = await runQualityChecks(
			makeEvent({ tool_name: "Edit" }),
			BASIC_CHECKS,
			"/project",
			{ diffAware: { enabled: true, no_test_file: "new_files_only" } },
		);
		const ntf = results.filter((r) => r.name === "no_test_file");
		expect(ntf).toHaveLength(0);
	});

	it("fires no_test_file for Write tool (new file)", async () => {
		MOCK_FILE_CONTENT = "export function foo() { return 1; }";
		const results = await runQualityChecks(
			makeEvent({ tool_name: "Write" }),
			BASIC_CHECKS,
			"/project",
			{ diffAware: { enabled: true, no_test_file: "new_files_only" } },
		);
		const ntf = results.filter((r) => r.name === "no_test_file");
		expect(ntf).toHaveLength(1);
	});

	it("fires no_test_file for Edit when diff_aware is off", async () => {
		MOCK_FILE_CONTENT = "export function foo() { return 1; }";
		const results = await runQualityChecks(
			makeEvent({ tool_name: "Edit" }),
			BASIC_CHECKS,
			"/project",
			{ diffAware: { enabled: true, no_test_file: "off" } },
		);
		const ntf = results.filter((r) => r.name === "no_test_file");
		expect(ntf).toHaveLength(1);
	});
});

// ===========================================
// complexity: edit-region intersection
// ===========================================
describe("diff-aware: complexity edit-region intersection", () => {
	// Build a file with a complex function at the top and simple code far below.
	// The gap must be >55 lines (edit-region margin is -5/+50) to test suppression.
	const complexFnLines = [
		"export function complexOne(a: number, b: number, c: number, d: number, e: number, f: number, g: number) {",
		"  return a + b + c + d + e + f + g;",
		"}",
	];
	const paddingLines = Array.from({ length: 60 }, (_, i) => `// padding line ${i + 1}`);
	const simpleFnLines = ["", "// simple stuff below", "const x = 1;", "const y = 2;"];
	const fileContent = [...complexFnLines, ...paddingLines, ...simpleFnLines].join("\n");

	it("suppresses complexity finding when edit is outside the complex function", async () => {
		// Use post-edit content: old_string has been replaced by new_string on disk
		MOCK_FILE_CONTENT = fileContent.replace("const x = 1;", "const x = 42;");
		// Edit is at "const x = 1;" which is line 6 — well outside the complex function at line 1
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/example.ts",
					old_string: "const x = 1;",
					new_string: "const x = 42;",
				},
			}),
			BASIC_CHECKS,
			"/project",
			{ diffAware: { enabled: true, complexity: "edit_region" } },
		);
		const cplx = results.filter((r) => r.name === "complexity");
		expect(cplx).toHaveLength(0);
	});

	it("reports complexity finding when edit is inside the complex function", async () => {
		// Use post-edit content: old_string has been replaced by new_string on disk
		MOCK_FILE_CONTENT = fileContent.replace(
			"return a + b + c + d + e + f + g;",
			"return a + b + c + d + e + f + g + 1;",
		);
		// Edit is inside the complex function body
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/example.ts",
					old_string: "return a + b + c + d + e + f + g;",
					new_string: "return a + b + c + d + e + f + g + 1;",
				},
			}),
			BASIC_CHECKS,
			"/project",
			{ diffAware: { enabled: true, complexity: "edit_region" } },
		);
		const cplx = results.filter((r) => r.name === "complexity");
		expect(cplx).toHaveLength(1);
	});

	it("reports all complexity findings for Write tool (entire file is new)", async () => {
		MOCK_FILE_CONTENT = fileContent;
		const results = await runQualityChecks(
			makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/project/src/example.ts",
					content: fileContent,
				},
			}),
			BASIC_CHECKS,
			"/project",
			{ diffAware: { enabled: true, complexity: "edit_region" } },
		);
		const cplx = results.filter((r) => r.name === "complexity");
		expect(cplx).toHaveLength(1);
	});
});

// ===========================================
// secrets_in_source: test-file exclusion
// ===========================================

// Construct the fake AWS key at runtime so the harness's own secrets_in_source
// check doesn't fire on this test file's own source. secrets_in_source skips
// test files unconditionally (synthetic fixture secrets are not real leaks);
// the `skip_test_files` config flag covers the command-based scanners.
const FAKE_SECRET_LINE = `const key = "${"AKIA"}IOSFODNN7EXAMPLE";`;

describe("secrets_in_source test-file exclusion", () => {
	const SECRETS_CHECK = {
		secrets_in_source: {
			enabled: true,
			file_types: [".ts"],
			timeout_ms: 1000,
			severity: "error" as const,
		},
	};

	it("skips test files when skip_test_files is set", async () => {
		MOCK_FILE_CONTENT = FAKE_SECRET_LINE;
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/__tests__/auth.test.ts",
					old_string: "old",
					new_string: FAKE_SECRET_LINE,
				},
			}),
			{
				secrets_in_source: {
					...SECRETS_CHECK.secrets_in_source,
					skip_test_files: true,
				},
			},
			"/project",
		);
		expect(
			results.filter((r) => r.name === "secrets_in_source"),
		).toHaveLength(0);
	});

	it("skips test files even without skip_test_files set", async () => {
		MOCK_FILE_CONTENT = FAKE_SECRET_LINE;
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/__tests__/auth.test.ts",
					old_string: "old",
					new_string: FAKE_SECRET_LINE,
				},
			}),
			SECRETS_CHECK,
			"/project",
		);
		expect(
			results.filter((r) => r.name === "secrets_in_source"),
		).toHaveLength(0);
	});

	it("still flags secrets in non-test source files", async () => {
		MOCK_FILE_CONTENT = FAKE_SECRET_LINE;
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/auth.ts",
					old_string: "old",
					new_string: FAKE_SECRET_LINE,
				},
			}),
			SECRETS_CHECK,
			"/project",
		);
		expect(
			results.filter((r) => r.name === "secrets_in_source"),
		).toHaveLength(1);
	});
});

// ===========================================
// type_density_ratchet — composite type-erasure metric
// ===========================================
describe("type_density_ratchet", () => {
	const zeroDensity = {
		anyAnnotations: 0,
		unknownAnnotations: 0,
		functionType: 0,
		emptyObjectType: 0,
		untypedExportedParams: 0,
		missingExportedReturnType: 0,
	};

	function baselineWith(
		density: Partial<typeof zeroDensity> = {},
	): NonNullable<QualityCheckOptions["baseline"]> {
		return {
			missingReturnTypes: new Set(),
			complexFunctions: new Set(),
			capturedAt: FIXED_NOW,
			suppressionCount: 0,
			asAnyCastCount: 0,
			nonNullAssertionCount: 0,
			typeDensity: { ...zeroDensity, ...density },
		};
	}

	it("fires when bare `: any` annotations increase", async () => {
		MOCK_FILE_CONTENT = "function f(x: any) { return x; }\nfunction g(y: any) { return y; }";
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", {
			baseline: baselineWith({ anyAnnotations: 1 }),
			diffAware: { enabled: false },
		});
		const ratchet = results.filter((r) => r.name === "type_density_ratchet");
		expect(ratchet).toHaveLength(1);
		expect(ratchet[0].message).toContain("`: any`");
		expect(ratchet[0].message).toContain("(1→2)");
	});

	it("fires when missing exported return types increase", async () => {
		MOCK_FILE_CONTENT =
			"export function a(x: number) { return x; }\nexport function b(x: number) { return x; }";
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", {
			baseline: baselineWith({ missingExportedReturnType: 1 }),
			diffAware: { enabled: false },
		});
		const ratchet = results.filter((r) => r.name === "type_density_ratchet");
		expect(ratchet).toHaveLength(1);
		expect(ratchet[0].message).toContain("missing exported return type");
	});

	it("does not fire when counters are unchanged", async () => {
		MOCK_FILE_CONTENT = "function f(x: any) { return x; }";
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", {
			baseline: baselineWith({ anyAnnotations: 1 }),
			diffAware: { enabled: false },
		});
		const ratchet = results.filter((r) => r.name === "type_density_ratchet");
		expect(ratchet).toHaveLength(0);
	});

	it("does not fire when typeDensity baseline is absent (back-compat)", async () => {
		MOCK_FILE_CONTENT = "function f(x: any) { return x; }";
		const results = await runQualityChecks(makeEvent(), BASIC_CHECKS, "/project", {
			baseline: {
				missingReturnTypes: new Set(),
				complexFunctions: new Set(),
				capturedAt: FIXED_NOW,
				suppressionCount: 0,
				asAnyCastCount: 0,
				nonNullAssertionCount: 0,
				// typeDensity intentionally omitted
			},
			diffAware: { enabled: false },
		});
		const ratchet = results.filter((r) => r.name === "type_density_ratchet");
		expect(ratchet).toHaveLength(0);
	});
});
