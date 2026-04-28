import { beforeEach, describe, expect, it, vi } from "vitest";
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
// skip_test_files: semgrep/gitleaks exclusion
// ===========================================

// Construct fake AWS key at runtime so the harness's own secrets_in_source
// check doesn't fire on this test fixture. This is the exact problem
// skip_test_files solves — once it's live, scanners won't run on test files.
const FAKE_SECRET_LINE = `const key = "${"AKIA"}IOSFODNN7EXAMPLE";`;

describe("skip_test_files", () => {
	it("skips checks with skip_test_files on test files", async () => {
		MOCK_FILE_CONTENT = FAKE_SECRET_LINE;
		const checksWithSkip = {
			secrets_in_source: {
				enabled: true,
				file_types: [".ts"],
				timeout_ms: 1000,
				severity: "error" as const,
				skip_test_files: true,
			},
		};
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/__tests__/auth.test.ts",
					old_string: "old",
					new_string: FAKE_SECRET_LINE,
				},
			}),
			checksWithSkip,
			"/project",
		);
		const secrets = results.filter((r) => r.name === "secrets_in_source");
		expect(secrets).toHaveLength(0);
	});

	it("runs checks without skip_test_files on test files", async () => {
		MOCK_FILE_CONTENT = FAKE_SECRET_LINE;
		const checksWithoutSkip = {
			secrets_in_source: {
				enabled: true,
				file_types: [".ts"],
				timeout_ms: 1000,
				severity: "error" as const,
				// skip_test_files not set
			},
		};
		const results = await runQualityChecks(
			makeEvent({
				tool_input: {
					file_path: "/project/src/__tests__/auth.test.ts",
					old_string: "old",
					new_string: FAKE_SECRET_LINE,
				},
			}),
			checksWithoutSkip,
			"/project",
		);
		const secrets = results.filter((r) => r.name === "secrets_in_source");
		expect(secrets).toHaveLength(1);
	});
});
