// ===========================================
// tool-check-loop.ts — behavioral coverage
// ===========================================
// Drives runToolCheckLoop (the config-driven PostToolUse per-check dispatch)
// with every sibling module mocked at the import boundary, so no real
// subprocess, disk read, or external tool runs. Each test asserts the real
// aggregated QualityCheckResult[] returned for one branch of the loop.
//
// The two ctx accessors (getSharedContent / getAfterRefs) are plain functions
// supplied per-call, so content/ref injection needs no module mock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, QualityCheckConfig } from "../types.js";
import { runToolCheckLoop, type ToolCheckLoopContext, yieldEventLoop } from "./tool-check-loop.js";

// --- module-boundary mocks ------------------------------------------------

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

vi.mock("../check-engine/index.js", () => ({
	configNameToToolId: vi.fn(),
	getOrCreateEngine: vi.fn(),
}));

vi.mock("../check-engine/output-parsers.js", () => ({
	parseNpmAuditJson: vi.fn(),
	parseOsvScannerJson: vi.fn(),
}));

vi.mock("../checks/shared.js", () => ({
	isGeneratedFile: vi.fn(() => false),
	isTestFile: vi.fn(() => false),
}));

vi.mock("../language-profiles.js", () => ({
	getProfileForFile: vi.fn(),
}));

vi.mock("./dependency-audit.js", () => ({
	resolveDependencyAuditCommand: vi.fn(),
}));

vi.mock("./inline-language-checks.js", () => ({
	runInlineLanguageChecks: vi.fn(() => []),
}));

vi.mock("./lockfile-drift.js", () => ({
	checkLockfileDrift: vi.fn(),
	LOCKFILE_MAP: { "package.json": ["package-lock.json", "yarn.lock"] },
}));

vi.mock("./package-json.js", () => ({
	checkPackageJsonConsistency: vi.fn(() => []),
}));

vi.mock("./project-root.js", () => ({
	findProjectRoot: vi.fn(() => "/proj"),
}));

vi.mock("./secret-detection.js", () => ({
	containsSecrets: vi.fn(() => []),
}));

vi.mock("./software-version-regression.js", () => ({
	collectSoftwareVersionReferences: vi.fn(() => []),
	detectSoftwareVersionRegressions: vi.fn(() => []),
	detectSoftwareVersionFreshnessConcerns: vi.fn(() => []),
	formatSoftwareVersionRegressionDetail: vi.fn(() => "REG-DETAIL"),
	formatSoftwareVersionFreshnessDetail: vi.fn(() => "FRESH-DETAIL"),
}));

vi.mock("./strong-typing.js", () => ({
	findAnyTypes: vi.fn(() => []),
}));

vi.mock("./test-classifier.js", () => ({
	isLikelyTestFile: vi.fn(() => false),
}));

vi.mock("./test-dispatchers.js", () => ({
	TEST_DISPATCHERS: {},
}));

// --- typed handles to the mocks -------------------------------------------

import { spawnSync } from "node:child_process";
import { configNameToToolId, getOrCreateEngine } from "../check-engine/index.js";
import { parseNpmAuditJson, parseOsvScannerJson } from "../check-engine/output-parsers.js";
import { isGeneratedFile, isTestFile } from "../checks/shared.js";
import { getProfileForFile } from "../language-profiles.js";
import { resolveDependencyAuditCommand } from "./dependency-audit.js";
import { runInlineLanguageChecks } from "./inline-language-checks.js";
import { checkLockfileDrift } from "./lockfile-drift.js";
import { checkPackageJsonConsistency } from "./package-json.js";
import { containsSecrets } from "./secret-detection.js";
import {
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
} from "./software-version-regression.js";
import { findAnyTypes } from "./strong-typing.js";
import { isLikelyTestFile } from "./test-classifier.js";
import { TEST_DISPATCHERS } from "./test-dispatchers.js";

const mockSpawnSync = vi.mocked(spawnSync);
const mockConfigNameToToolId = vi.mocked(configNameToToolId);
const mockGetOrCreateEngine = vi.mocked(getOrCreateEngine);
const mockParseNpmAuditJson = vi.mocked(parseNpmAuditJson);
const mockParseOsvScannerJson = vi.mocked(parseOsvScannerJson);
const mockIsGeneratedFile = vi.mocked(isGeneratedFile);
const mockIsTestFile = vi.mocked(isTestFile);
const mockGetProfileForFile = vi.mocked(getProfileForFile);
const mockResolveDependencyAuditCommand = vi.mocked(resolveDependencyAuditCommand);
const mockRunInlineLanguageChecks = vi.mocked(runInlineLanguageChecks);
const mockCheckLockfileDrift = vi.mocked(checkLockfileDrift);
const mockCheckPackageJsonConsistency = vi.mocked(checkPackageJsonConsistency);
const mockContainsSecrets = vi.mocked(containsSecrets);
const mockDetectRegressions = vi.mocked(detectSoftwareVersionRegressions);
const mockDetectFreshness = vi.mocked(detectSoftwareVersionFreshnessConcerns);
const mockFindAnyTypes = vi.mocked(findAnyTypes);
const mockIsLikelyTestFile = vi.mocked(isLikelyTestFile);

// --- shared fixtures ------------------------------------------------------

const baseEvent: HarnessEvent = {
	hook_event: "PostToolUse",
	session_id: "s1",
	agent_source: "claude",
	tool_name: "Write",
	timestamp: "2026-06-01T00:00:00Z",
};

/** A QualityCheckConfig with sane defaults; override per test. */
function cfg(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 1000,
		severity: "warning",
		...over,
	};
}

/** A full ToolCheckLoopContext with overridable fields. */
function makeCtx(over: Partial<ToolCheckLoopContext> = {}): ToolCheckLoopContext {
	return {
		event: { ...baseEvent, tool_input: { file_path: "src/x.ts", content: "ok" } },
		checks: {},
		cwd: "/cwd",
		filePath: "src/x.ts",
		absForTestCheck: "/cwd/src/x.ts",
		testCheckBaseName: "x",
		getSharedContent: () => "const ok = 1;",
		getAfterRefs: () => [],
		tscFilterFile: undefined,
		baseline: undefined,
		outToolMetrics: undefined,
		editedFileInRepo: undefined,
		onCheckBoundary: undefined,
		...over,
	};
}

/** Build a minimal engine whose runChecksAsync resolves to the given report. */
function engineReturning(report: {
	results: { file: string; line: number; message: string }[];
	metrics?: { tool: string; elapsedMs: number; findingCount: number }[];
}) {
	const runChecksAsync = vi.fn().mockResolvedValue({
		results: report.results,
		metrics: report.metrics ?? [],
	});
	// Cast through unknown — the loop only ever calls runChecksAsync.
	mockGetOrCreateEngine.mockReturnValue({ runChecksAsync } as unknown as ReturnType<
		typeof getOrCreateEngine
	>);
	return runChecksAsync;
}

/** Minimal SpawnSync-shaped return. */
function spawnResult(over: Partial<ReturnType<typeof spawnSync>> = {}) {
	return {
		pid: 1,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...over,
	} as unknown as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
	// Reset call history + restore the default-return mocks each test.
	mockSpawnSync.mockReset();
	mockConfigNameToToolId.mockReset();
	mockGetOrCreateEngine.mockReset();
	mockParseNpmAuditJson.mockReset();
	mockParseOsvScannerJson.mockReset();
	mockIsGeneratedFile.mockReset().mockReturnValue(false);
	mockIsTestFile.mockReset().mockReturnValue(false);
	mockGetProfileForFile.mockReset().mockReturnValue(null);
	mockResolveDependencyAuditCommand.mockReset();
	mockRunInlineLanguageChecks.mockReset().mockReturnValue([]);
	mockCheckLockfileDrift.mockReset();
	mockCheckPackageJsonConsistency.mockReset().mockReturnValue([]);
	mockContainsSecrets.mockReset().mockReturnValue([]);
	mockDetectRegressions.mockReset().mockReturnValue([]);
	mockDetectFreshness.mockReset().mockReturnValue([]);
	mockFindAnyTypes.mockReset().mockReturnValue([]);
	mockIsLikelyTestFile.mockReset().mockReturnValue(false);
	// TEST_DISPATCHERS is a plain object; clear any per-test keys.
	for (const k of Object.keys(TEST_DISPATCHERS)) {
		delete (TEST_DISPATCHERS as Record<string, unknown>)[k];
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ==========================================================================
// yieldEventLoop
// ==========================================================================

describe("yieldEventLoop", () => {
	it("resolves after a setImmediate boundary", async () => {
		await expect(yieldEventLoop()).resolves.toBeUndefined();
	});
});

// ==========================================================================
// loop-level skip guards (top of the for-body)
// ==========================================================================

describe("runToolCheckLoop — skip guards", () => {
	it("returns [] for an empty checks map", async () => {
		await expect(runToolCheckLoop(makeCtx())).resolves.toEqual([]);
	});

	it("skips a disabled check (enabled:false)", async () => {
		const containsSecretsSpy = mockContainsSecrets.mockReturnValue(["aws-key"]);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { secrets_in_source: cfg({ enabled: false }) } }),
		);
		expect(out).toEqual([]);
		expect(containsSecretsSpy).not.toHaveBeenCalled();
	});

	it("skips a check whose file_types don't match the file extension", async () => {
		const out = await runToolCheckLoop(
			makeCtx({
				filePath: "src/x.py",
				checks: { secrets_in_source: cfg({ file_types: [".ts"] }) },
			}),
		);
		expect(out).toEqual([]);
		expect(mockContainsSecrets).not.toHaveBeenCalled();
	});

	it("skips a skip_test_files check when the file is a test file", async () => {
		mockIsLikelyTestFile.mockReturnValue(true);
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { gitleaks: cfg({ command: "gitleaks", skip_test_files: true }) },
				editedFileInRepo: true,
			}),
		);
		expect(out).toEqual([]);
		// guard fired before the command branch resolved a tool id
		expect(mockConfigNameToToolId).not.toHaveBeenCalled();
	});

	it("does NOT skip a skip_test_files check for a non-test file", async () => {
		mockIsLikelyTestFile.mockReturnValue(false);
		mockConfigNameToToolId.mockReturnValue("gitleaks" as never);
		const run = engineReturning({ results: [] });
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { gitleaks: cfg({ command: "gitleaks", skip_test_files: true }) },
				editedFileInRepo: true,
			}),
		);
		expect(out).toEqual([]); // engine ran, found nothing
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("skips command-based checks when the edited file is outside the repo", async () => {
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { typescript: cfg({ command: "tsc" }) },
				editedFileInRepo: false,
			}),
		);
		expect(out).toEqual([]);
		expect(mockGetOrCreateEngine).not.toHaveBeenCalled();
	});

	it("still runs inline (no-command) checks for an out-of-repo file", async () => {
		mockContainsSecrets.mockReturnValue(["aws-key"]);
		const out = await runToolCheckLoop(
			makeCtx({
				event: {
					...baseEvent,
					tool_input: { file_path: "src/x.ts", content: "secretish" },
				},
				checks: { secrets_in_source: cfg() },
				editedFileInRepo: false,
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("secrets_in_source");
	});
});

// ==========================================================================
// secrets_in_source branch
// ==========================================================================

describe("runToolCheckLoop — secrets_in_source", () => {
	it("skips when the file is a test file (isTestFile true)", async () => {
		mockIsTestFile.mockReturnValue(true);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { secrets_in_source: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockContainsSecrets).not.toHaveBeenCalled();
	});

	it("pushes a finding when content (from tool_input.content) has secrets", async () => {
		mockContainsSecrets.mockReturnValue(["aws-access-key", "github-token"]);
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: { content: "blob with secrets" } },
				checks: { secrets_in_source: cfg({ severity: "error" }) },
			}),
		);
		expect(out).toEqual([
			{
				name: "secrets_in_source",
				severity: "error",
				message: "Secrets detected in src/x.ts: 2 pattern(s) matched",
				file: "src/x.ts",
			},
		]);
		expect(mockContainsSecrets).toHaveBeenCalledWith("blob with secrets");
	});

	it("falls back to tool_input.new_string when content is absent", async () => {
		mockContainsSecrets.mockReturnValue(["token"]);
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_name: "Edit", tool_input: { new_string: "edited blob" } },
				checks: { secrets_in_source: cfg() },
			}),
		);
		expect(out).toEqual([
			{
				name: "secrets_in_source",
				severity: "warning",
				message: "Secrets detected in src/x.ts: 1 pattern(s) matched",
				file: "src/x.ts",
			},
		]);
		expect(mockContainsSecrets).toHaveBeenCalledWith("edited blob");
	});

	it("no finding when content is empty (skips containsSecrets entirely)", async () => {
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: {} },
				checks: { secrets_in_source: cfg() },
			}),
		);
		expect(out).toEqual([]);
		expect(mockContainsSecrets).not.toHaveBeenCalled();
	});

	it("no finding when containsSecrets returns an empty array", async () => {
		mockContainsSecrets.mockReturnValue([]);
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: { content: "clean" } },
				checks: { secrets_in_source: cfg() },
			}),
		);
		expect(out).toEqual([]);
		expect(mockContainsSecrets).toHaveBeenCalledWith("clean");
	});
});

// ==========================================================================
// strong_typing branch
// ==========================================================================

describe("runToolCheckLoop — strong_typing", () => {
	it("skips .test files", async () => {
		const out = await runToolCheckLoop(
			makeCtx({ filePath: "src/x.test.ts", checks: { strong_typing: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockFindAnyTypes).not.toHaveBeenCalled();
	});

	it("skips .spec files", async () => {
		const out = await runToolCheckLoop(
			makeCtx({ filePath: "src/x.spec.ts", checks: { strong_typing: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockFindAnyTypes).not.toHaveBeenCalled();
	});

	it("skips when shared content is null", async () => {
		const out = await runToolCheckLoop(
			makeCtx({ getSharedContent: () => null, checks: { strong_typing: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockFindAnyTypes).not.toHaveBeenCalled();
	});

	it("skips generated files", async () => {
		mockIsGeneratedFile.mockReturnValue(true);
		const out = await runToolCheckLoop(
			makeCtx({ getSharedContent: () => "// @generated", checks: { strong_typing: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockFindAnyTypes).not.toHaveBeenCalled();
	});

	it("no finding when findAnyTypes returns []", async () => {
		mockFindAnyTypes.mockReturnValue([]);
		const out = await runToolCheckLoop(makeCtx({ checks: { strong_typing: cfg() } }));
		expect(out).toEqual([]);
	});

	it("reports only `any` count (no unknown part) and lists matches", async () => {
		mockFindAnyTypes.mockReturnValue([
			{ kind: "any", line: 3, text: "x: any" },
			{ kind: "any", line: 7, text: "y: any" },
		] as never);
		const out = await runToolCheckLoop(makeCtx({ checks: { strong_typing: cfg() } }));
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("2 `any`");
		expect(out[0]?.message).not.toContain("`unknown`");
		expect(out[0]?.detail).toBe("  L3: x: any\n  L7: y: any");
	});

	it("reports only `unknown` count when no `any` present", async () => {
		mockFindAnyTypes.mockReturnValue([{ kind: "unknown", line: 1, text: "z: unknown" }] as never);
		const out = await runToolCheckLoop(makeCtx({ checks: { strong_typing: cfg() } }));
		expect(out[0]?.message).toContain("1 `unknown`");
		expect(out[0]?.message).not.toContain("`any`");
	});

	it("combines any + unknown counts with ' + '", async () => {
		mockFindAnyTypes.mockReturnValue([
			{ kind: "any", line: 1, text: "a: any" },
			{ kind: "unknown", line: 2, text: "b: unknown" },
		] as never);
		const out = await runToolCheckLoop(makeCtx({ checks: { strong_typing: cfg() } }));
		expect(out[0]?.message).toContain("1 `any` + 1 `unknown`");
	});

	it("truncates to 8 shown matches and appends an overflow line", async () => {
		const matches = Array.from({ length: 10 }, (_v, i) => ({
			kind: "any" as const,
			line: i + 1,
			text: `m${i}: any`,
		}));
		mockFindAnyTypes.mockReturnValue(matches as never);
		const out = await runToolCheckLoop(makeCtx({ checks: { strong_typing: cfg() } }));
		expect(out[0]?.detail).toContain("L8: m7: any");
		expect(out[0]?.detail).not.toContain("L9: m8: any");
		expect(out[0]?.detail).toContain("... and 2 more");
	});
});

// ==========================================================================
// dependency_audit branch
// ==========================================================================

describe("runToolCheckLoop — dependency_audit", () => {
	const auditCtx = (over: Partial<ToolCheckLoopContext> = {}) =>
		makeCtx({
			filePath: "package.json",
			absForTestCheck: "/cwd/package.json",
			testCheckBaseName: "package",
			checks: { dependency_audit: cfg({ file_types: [".json"] }) },
			...over,
		});

	it("skips when resolveDependencyAuditCommand returns null (unknown file)", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue(null);
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toEqual([]);
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("skips silently when the audit tool is missing (ENOENT)", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockSpawnSync.mockReturnValue(
			spawnResult({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) }),
		);
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toEqual([]);
	});

	it("skips when status is 0 (clean)", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: 0 }));
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toEqual([]);
	});

	it("skips when status is null (timeout)", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: null }));
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toEqual([]);
	});

	it("npm-audit parser: surfaces parsed detail on non-zero exit", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stdout: "{json}" }));
		mockParseNpmAuditJson.mockReturnValue({ detail: "3 high severity" } as never);
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toBe("Dependency vulnerabilities found after editing package.json");
		expect(out[0]?.detail).toBe("3 high severity");
		// command resolved against the project-root cwd
		expect(mockSpawnSync).toHaveBeenCalledWith(
			"npm",
			["audit", "--json"],
			expect.objectContaining({ cwd: "/proj", shell: false }),
		);
	});

	it("npm-audit parser: empty detail falls back to the run-command hint", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stdout: "{}" }));
		// summary?.detail ?? "" => "" so the `detail || fallback` kicks in
		mockParseNpmAuditJson.mockReturnValue(null);
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.detail).toBe("Run `npm` for details (parser: npm-audit)");
	});

	it("osv-scanner parser: uses summary.detail", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["osv-scanner", "scan"],
			parser: "osv-scanner",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stdout: "{osv}" }));
		mockParseOsvScannerJson.mockReturnValue({ detail: "CVE-2026-1" } as never);
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.detail).toBe("CVE-2026-1");
	});

	it("osv-scanner parser: skips when summary is null (non-zero but unparsable)", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["osv-scanner", "scan"],
			parser: "osv-scanner",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stdout: "garbage" }));
		mockParseOsvScannerJson.mockReturnValue(null);
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toEqual([]);
	});

	it("other parser (pip-audit): surfaces the stderr tail", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["pip-audit", "--format", "json"],
			parser: "pip-audit",
		});
		mockSpawnSync.mockReturnValue(
			spawnResult({ status: 1, stderr: "l1\nl2\nl3\nl4\nl5\nl6\nl7" }),
		);
		const out = await runToolCheckLoop(auditCtx());
		// only the first 5 stderr lines
		expect(out[0]?.detail).toBe("l1\nl2\nl3\nl4\nl5");
	});

	it("other parser: empty stderr falls back to 'vulnerabilities found'", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue({
			cmd: ["cargo", "audit", "--json"],
			parser: "cargo-audit",
		});
		mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stderr: "" }));
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.detail).toBe("vulnerabilities found");
	});

	it("forwards use_osv_scanner / offline config into the resolver", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue(null);
		const out = await runToolCheckLoop(
			auditCtx({
				checks: {
					dependency_audit: cfg({
						file_types: [".json"],
						use_osv_scanner: false,
						offline: true,
					}),
				},
			}),
		);
		expect(out).toEqual([]); // null resolution → no audit, no finding
		expect(mockResolveDependencyAuditCommand).toHaveBeenCalledWith("package.json", {
			useOsvScanner: false,
			offline: true,
		});
	});
});

// ==========================================================================
// inline_language_checks branch
// ==========================================================================

describe("runToolCheckLoop — inline_language_checks", () => {
	it("skips when there is no language profile", async () => {
		mockGetProfileForFile.mockReturnValue(null);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { inline_language_checks: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockRunInlineLanguageChecks).not.toHaveBeenCalled();
	});

	it("skips when the profile has no inline_checks", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "typescript", inline_checks: [] } as never);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { inline_language_checks: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockRunInlineLanguageChecks).not.toHaveBeenCalled();
	});

	it("skips when shared content is null", async () => {
		mockGetProfileForFile.mockReturnValue({
			id: "python",
			inline_checks: [{ name: "x" }],
		} as never);
		const out = await runToolCheckLoop(
			makeCtx({ getSharedContent: () => null, checks: { inline_language_checks: cfg() } }),
		);
		expect(out).toEqual([]);
		expect(mockRunInlineLanguageChecks).not.toHaveBeenCalled();
	});

	it("maps each inline finding into a result row", async () => {
		mockGetProfileForFile.mockReturnValue({
			id: "python",
			inline_checks: [{ name: "x" }],
		} as never);
		mockRunInlineLanguageChecks.mockReturnValue([
			{
				name: "py_eval",
				severity: "warning",
				message: "avoid eval",
				file: "src/x.ts",
				detail: "L4",
			},
			{
				name: "py_exec",
				severity: "error",
				message: "avoid exec",
				file: "src/x.ts",
				detail: "L9",
			},
		]);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { inline_language_checks: cfg() } }),
		);
		expect(out).toEqual([
			{
				name: "py_eval",
				severity: "warning",
				message: "avoid eval",
				file: "src/x.ts",
				detail: "L4",
			},
			{
				name: "py_exec",
				severity: "error",
				message: "avoid exec",
				file: "src/x.ts",
				detail: "L9",
			},
		]);
	});
});

// ==========================================================================
// affected_tests branch
// ==========================================================================

describe("runToolCheckLoop — affected_tests", () => {
	it("skips when there is no language profile", async () => {
		mockGetProfileForFile.mockReturnValue(null);
		const out = await runToolCheckLoop(makeCtx({ checks: { affected_tests: cfg() } }));
		expect(out).toEqual([]);
	});

	it("skips when the edited file is itself a test file", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "typescript", inline_checks: [] } as never);
		mockIsLikelyTestFile.mockReturnValue(true);
		const dispatcher = vi.fn();
		(TEST_DISPATCHERS as Record<string, unknown>).typescript = dispatcher;
		const out = await runToolCheckLoop(makeCtx({ checks: { affected_tests: cfg() } }));
		expect(out).toEqual([]);
		expect(dispatcher).not.toHaveBeenCalled();
	});

	it("skips when no dispatcher is registered for the language id", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "ruby", inline_checks: [] } as never);
		mockIsLikelyTestFile.mockReturnValue(false);
		const out = await runToolCheckLoop(makeCtx({ checks: { affected_tests: cfg() } }));
		expect(out).toEqual([]);
	});

	it("invokes the dispatcher with resolved paths and maps its results", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "typescript", inline_checks: [] } as never);
		mockIsLikelyTestFile.mockReturnValue(false);
		const dispatcher = vi.fn().mockReturnValue([
			{
				name: "affected_tests",
				severity: "error",
				message: "2 tests failed",
				file: "src/x.ts",
				detail: "fail detail",
			},
		]);
		(TEST_DISPATCHERS as Record<string, unknown>).typescript = dispatcher;

		const out = await runToolCheckLoop(
			makeCtx({
				filePath: "src/feature.ts",
				cwd: "/cwd",
				checks: { affected_tests: cfg({ timeout_ms: 4321, severity: "error" }) },
			}),
		);

		expect(dispatcher).toHaveBeenCalledTimes(1);
		const arg = dispatcher.mock.calls[0]?.[0];
		expect(arg).toMatchObject({
			filePath: "src/feature.ts",
			absPath: "/cwd/src/feature.ts",
			checkCwd: "/proj",
			timeoutMs: 4321,
			severity: "error",
			checkName: "affected_tests",
		});
		expect(out).toEqual([
			{
				name: "affected_tests",
				severity: "error",
				message: "2 tests failed",
				file: "src/x.ts",
				detail: "fail detail",
			},
		]);
	});

	it("uses an already-absolute filePath unchanged", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "typescript", inline_checks: [] } as never);
		const dispatcher = vi.fn().mockReturnValue([]);
		(TEST_DISPATCHERS as Record<string, unknown>).typescript = dispatcher;
		await runToolCheckLoop(
			makeCtx({ filePath: "/abs/path/feature.ts", checks: { affected_tests: cfg() } }),
		);
		expect(dispatcher.mock.calls[0]?.[0]?.absPath).toBe("/abs/path/feature.ts");
	});
});

// ==========================================================================
// lockfile_drift branch
// ==========================================================================

describe("runToolCheckLoop — lockfile_drift", () => {
	const lockCtx = () =>
		makeCtx({
			filePath: "package.json",
			absForTestCheck: "/cwd/package.json",
			testCheckBaseName: "package",
			checks: { lockfile_drift: cfg({ file_types: [".json"] }) },
		});

	it("no finding when not drifted", async () => {
		mockCheckLockfileDrift.mockReturnValue({
			drifted: false,
			manifest: "package.json",
			reason: "none",
		});
		const out = await runToolCheckLoop(lockCtx());
		expect(out).toEqual([]);
	});

	it("reports a missing lockfile (missing branch message + expected-list detail)", async () => {
		mockCheckLockfileDrift.mockReturnValue({
			drifted: true,
			manifest: "package.json",
			reason: "missing",
		});
		const out = await runToolCheckLoop(lockCtx());
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toBe(
			"No lockfile found for package.json. Run the package manager's install command to generate one.",
		);
		expect(out[0]?.detail).toBe("Expected one of: package-lock.json, yarn.lock");
	});

	it("reports a stale lockfile (stale branch message + run-install detail)", async () => {
		mockCheckLockfileDrift.mockReturnValue({
			drifted: true,
			manifest: "package.json",
			lockfile: "package-lock.json",
			reason: "stale",
		});
		const out = await runToolCheckLoop(lockCtx());
		expect(out[0]?.message).toBe(
			"package-lock.json is stale — package.json was modified but the lockfile was not regenerated.",
		);
		expect(out[0]?.detail).toContain("Run `npm install`");
		expect(out[0]?.detail).toContain("update package-lock.json");
	});

	it("missing detail falls back to empty expected-list when manifest not in LOCKFILE_MAP", async () => {
		mockCheckLockfileDrift.mockReturnValue({
			drifted: true,
			manifest: "Gemfile",
			reason: "missing",
		});
		const out = await runToolCheckLoop(lockCtx());
		// LOCKFILE_MAP mock has no "Gemfile" key → "Expected one of: "
		expect(out[0]?.detail).toBe("Expected one of: ");
	});
});

// ==========================================================================
// package_json_consistency branch
// ==========================================================================

describe("runToolCheckLoop — package_json_consistency", () => {
	const pkgCtx = () =>
		makeCtx({
			filePath: "package.json",
			absForTestCheck: "/cwd/package.json",
			testCheckBaseName: "package",
			getSharedContent: () => "{}",
			checks: { package_json_consistency: cfg({ file_types: [".json"] }) },
		});

	it("skips when shared content is null", async () => {
		mockCheckPackageJsonConsistency.mockReturnValue([{ kind: "duplicate", detail: "d" }] as never);
		const out = await runToolCheckLoop(
			makeCtx({
				filePath: "package.json",
				getSharedContent: () => null,
				checks: { package_json_consistency: cfg({ file_types: [".json"] }) },
			}),
		);
		expect(out).toEqual([]);
		expect(mockCheckPackageJsonConsistency).not.toHaveBeenCalled();
	});

	it("no finding when there are no issues", async () => {
		mockCheckPackageJsonConsistency.mockReturnValue([]);
		const out = await runToolCheckLoop(pkgCtx());
		expect(out).toEqual([]);
	});

	it("reports duplicates only", async () => {
		mockCheckPackageJsonConsistency.mockReturnValue([
			{ kind: "duplicate", detail: "foo in deps+devDeps" },
		] as never);
		const out = await runToolCheckLoop(pkgCtx());
		expect(out[0]?.message).toContain("1 duplicate(s)");
		expect(out[0]?.message).not.toContain("invalid version");
		expect(out[0]?.detail).toBe("  foo in deps+devDeps");
	});

	it("reports invalid versions only", async () => {
		mockCheckPackageJsonConsistency.mockReturnValue([
			{ kind: "invalid_semver", detail: "bar@zzz" },
		] as never);
		const out = await runToolCheckLoop(pkgCtx());
		expect(out[0]?.message).toContain("1 invalid version(s)");
		expect(out[0]?.message).not.toContain("duplicate");
	});

	it("reports both kinds joined and truncates detail past 10 with overflow", async () => {
		const issues = [
			{ kind: "duplicate", detail: "dup0" },
			...Array.from({ length: 11 }, (_v, i) => ({
				kind: "invalid_semver" as const,
				detail: `bad${i}`,
			})),
		];
		mockCheckPackageJsonConsistency.mockReturnValue(issues as never);
		const out = await runToolCheckLoop(pkgCtx());
		expect(out[0]?.message).toContain("1 duplicate(s), 11 invalid version(s)");
		expect(out[0]?.detail).toContain("  dup0");
		expect(out[0]?.detail).toContain("... and 2 more"); // 12 issues, 10 shown
		expect(out[0]?.detail).not.toContain("bad10");
	});
});

// ==========================================================================
// software_version_regression / freshness_sensitive_reference branch
// ==========================================================================

describe("runToolCheckLoop — software version / freshness", () => {
	const svCtx = (over: Partial<ToolCheckLoopContext> = {}) =>
		makeCtx({
			checks: { software_version_regression: cfg() },
			getSharedContent: () => "after content",
			...over,
		});

	it("skips when post content is null", async () => {
		const out = await runToolCheckLoop(
			svCtx({ getSharedContent: () => null }),
		);
		expect(out).toEqual([]);
		expect(mockDetectRegressions).not.toHaveBeenCalled();
	});

	it("reports a regression when software_version_regression and regressions found", async () => {
		mockDetectRegressions.mockReturnValue([
			{ after: { anchor: "react", version: "17" } },
		] as never);
		const out = await runToolCheckLoop(
			svCtx({ baseline: { softwareVersions: [{ anchor: "react", version: "18" }] as never } }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("software_version_regression");
		expect(out[0]?.message).toContain("1 possible software version regression(s)");
		expect(out[0]?.detail).toBe("REG-DETAIL");
	});

	it("does NOT report regression detail under the freshness check name", async () => {
		mockDetectRegressions.mockReturnValue([
			{ after: { anchor: "react", version: "17" } },
		] as never);
		const out = await runToolCheckLoop(
			svCtx({
				checks: { freshness_sensitive_reference: cfg() },
				baseline: { softwareVersions: [] as never },
			}),
		);
		// freshness branch with no freshness concerns → nothing
		expect(out).toEqual([]);
	});

	it("reports a freshness concern under freshness_sensitive_reference", async () => {
		mockDetectFreshness.mockReturnValue([
			{ ref: { anchor: "node", version: "20" } },
		] as never);
		const out = await runToolCheckLoop(
			svCtx({
				checks: { freshness_sensitive_reference: cfg() },
				baseline: { softwareVersions: [] as never },
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("freshness_sensitive_reference");
		expect(out[0]?.message).toContain("1 freshness-sensitive software reference(s)");
		expect(out[0]?.detail).toBe("FRESH-DETAIL");
	});

	it("filters out freshness concerns that overlap a regression (anchor\\0version key)", async () => {
		// Same anchor+version appears in both → freshness one is dropped.
		mockDetectRegressions.mockReturnValue([
			{ after: { anchor: "vue", version: "2" } },
		] as never);
		mockDetectFreshness.mockReturnValue([
			{ ref: { anchor: "vue", version: "2" } },
		] as never);
		const out = await runToolCheckLoop(
			svCtx({
				checks: { freshness_sensitive_reference: cfg() },
				baseline: { softwareVersions: [] as never },
			}),
		);
		expect(out).toEqual([]);
	});

	it("reconstructs beforeRefs by reverting new_string→old_string when no baseline", async () => {
		const event = {
			...baseEvent,
			tool_name: "Edit",
			tool_input: { old_string: "old", new_string: "new" },
		};
		const out = await runToolCheckLoop(
			svCtx({
				event,
				baseline: undefined,
				getSharedContent: () => "prefix new suffix",
			}),
		);
		// No regressions from the mock → no finding row.
		expect(out).toEqual([]);
		// detectSoftwareVersionRegressions(beforeRefs, afterRefs); beforeRefs comes
		// from collectSoftwareVersionReferences(reverted). The mock returns [] for
		// both, but the call must have happened with two array args.
		expect(mockDetectRegressions).toHaveBeenCalledWith([], []);
	});

	it("reconstructs beforeRefs from the bare old_string when new_string is absent", async () => {
		const event = {
			...baseEvent,
			tool_name: "Edit",
			tool_input: { old_string: "only-old" },
		};
		const out = await runToolCheckLoop(svCtx({ event, baseline: undefined }));
		expect(out).toEqual([]);
		expect(mockDetectRegressions).toHaveBeenCalledTimes(1);
	});

	it("uses empty beforeRefs when neither old_string nor new_string is present", async () => {
		const out = await runToolCheckLoop(
			svCtx({ event: { ...baseEvent, tool_input: {} }, baseline: undefined }),
		);
		expect(out).toEqual([]);
		expect(mockDetectRegressions).toHaveBeenCalledWith([], []);
	});

	it("does not push a regression row when regressions is empty", async () => {
		mockDetectRegressions.mockReturnValue([]);
		const out = await runToolCheckLoop(
			svCtx({ baseline: { softwareVersions: [] as never } }),
		);
		expect(out).toEqual([]);
	});
});

// ==========================================================================
// check.command branch (delegated to the check engine)
// ==========================================================================

describe("runToolCheckLoop — command/engine branch", () => {
	it("skips when configNameToToolId returns undefined", async () => {
		mockConfigNameToToolId.mockReturnValue(undefined);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { custom_tool: cfg({ command: "whatever" }), editedFileInRepo: true } as never }),
		);
		expect(out).toEqual([]);
		expect(mockGetOrCreateEngine).not.toHaveBeenCalled();
	});

	it("skips when the resolved tool id is dep-audit (handled by dependency_audit)", async () => {
		mockConfigNameToToolId.mockReturnValue("dep-audit" as never);
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { dependency_audit_alias: cfg({ command: "x" }) },
				editedFileInRepo: true,
			}),
		);
		expect(out).toEqual([]);
		expect(mockGetOrCreateEngine).not.toHaveBeenCalled();
	});

	it("no finding when the engine returns zero results", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		const run = engineReturning({ results: [] });
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out).toEqual([]);
		// non-tsc, no tscFilterFile → filterToFile true, targetFile is the file path
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				projectRoot: "/proj",
				mode: "file",
				targetFile: "src/x.ts",
				filterToFile: true,
			}),
			expect.objectContaining({ tools: ["biome"], timeoutMs: 1000 }),
		);
	});

	it("aggregates engine findings into one result with file(line): message detail", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		engineReturning({
			results: [
				{ file: "src/x.ts", line: 3, message: "no-double-equals" },
				{ file: "src/x.ts", line: 9, message: "no-unused" },
			],
		});
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: "biome",
			severity: "warning",
			message: "biome found issues in src/x.ts",
			file: "src/x.ts",
		});
		expect(out[0]?.detail).toBe("src/x.ts(3): no-double-equals\nsrc/x.ts(9): no-unused");
	});

	it("truncates engine findings to 15 and appends an overflow line", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		const results = Array.from({ length: 18 }, (_v, i) => ({
			file: "src/x.ts",
			line: i,
			message: `m${i}`,
		}));
		engineReturning({ results });
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out[0]?.detail).toContain("src/x.ts(14): m14");
		expect(out[0]?.detail).not.toContain("src/x.ts(15): m15");
		expect(out[0]?.detail).toContain("... (3 more)");
	});

	it("tsc without smart-filter: filterToFile false, targetFile is the edited file", async () => {
		mockConfigNameToToolId.mockReturnValue("tsc" as never);
		const run = engineReturning({ results: [] });
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { typescript: cfg({ command: "tsc" }) },
				editedFileInRepo: true,
				tscFilterFile: undefined,
			}),
		);
		expect(out).toEqual([]);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ filterToFile: false, targetFile: "src/x.ts" }),
			expect.anything(),
		);
	});

	it("tsc WITH smart-filter: filterToFile true, targetFile resolved under project root", async () => {
		mockConfigNameToToolId.mockReturnValue("tsc" as never);
		const run = engineReturning({ results: [] });
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { typescript: cfg({ command: "tsc" }) },
				editedFileInRepo: true,
				tscFilterFile: "sub/only.ts",
			}),
		);
		expect(out).toEqual([]);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ filterToFile: true, targetFile: "/proj/sub/only.ts" }),
			expect.anything(),
		);
	});

	it("collects per-tool metrics into outToolMetrics when provided", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		engineReturning({
			results: [{ file: "src/x.ts", line: 1, message: "m" }],
			metrics: [{ tool: "biome", elapsedMs: 42, findingCount: 1 }],
		});
		const outMetrics: { tool: string; ms: number; finding_count: number }[] = [];
		await runToolCheckLoop(
			makeCtx({
				checks: { biome: cfg({ command: "biome" }) },
				editedFileInRepo: true,
				outToolMetrics: outMetrics,
			}),
		);
		expect(outMetrics).toEqual([{ tool: "biome", ms: 42, finding_count: 1 }]);
	});

	it("does not touch metrics when outToolMetrics is undefined", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		engineReturning({
			results: [],
			metrics: [{ tool: "biome", elapsedMs: 5, findingCount: 0 }],
		});
		// undefined outToolMetrics — just assert it doesn't throw and returns [].
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out).toEqual([]);
	});
});

// ==========================================================================
// catch / error isolation + onCheckBoundary instrumentation
// ==========================================================================

describe("runToolCheckLoop — error isolation & boundaries", () => {
	it("swallows a thrown timeout error and continues (returns no finding)", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		const runChecksAsync = vi.fn().mockRejectedValue(new Error("ETIMEDOUT: tsc timed out"));
		mockGetOrCreateEngine.mockReturnValue({ runChecksAsync } as never);
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out).toEqual([]);
	});

	it("swallows a non-timeout thrown error and continues", async () => {
		mockContainsSecrets.mockImplementation(() => {
			throw new Error("boom");
		});
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: { content: "x" } },
				checks: { secrets_in_source: cfg() },
			}),
		);
		expect(out).toEqual([]);
	});

	it("swallows a non-Error throw (String(err) branch)", async () => {
		// A non-Error rejection value held in a variable — exercises the
		// `String(err)` fallback in the catch (err is not an Error instance).
		const nonError: unknown = "plain string failure";
		mockContainsSecrets.mockImplementation(() => {
			throw nonError;
		});
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: { content: "x" } },
				checks: { secrets_in_source: cfg() },
			}),
		);
		expect(out).toEqual([]);
	});

	it("one failing check does not block a later passing check", async () => {
		mockContainsSecrets.mockImplementation(() => {
			throw new Error("boom");
		});
		mockFindAnyTypes.mockReturnValue([{ kind: "any", line: 1, text: "a: any" }] as never);
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: { content: "x" } },
				checks: {
					secrets_in_source: cfg(),
					strong_typing: cfg(),
				},
				getSharedContent: () => "const a: any = 1;",
			}),
		);
		// secrets threw; strong_typing still produced its finding
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("strong_typing");
	});

	it("fires onCheckBoundary with yield_<name> then inline_<name> per check", async () => {
		const boundaries: string[] = [];
		await runToolCheckLoop(
			makeCtx({
				checks: { secrets_in_source: cfg() },
				event: { ...baseEvent, tool_input: { content: "clean" } },
				onCheckBoundary: (n) => boundaries.push(n),
			}),
		);
		expect(boundaries).toEqual(["yield_secrets_in_source", "inline_secrets_in_source"]);
	});

	it("fires the inline_<name> boundary even when the check throws", async () => {
		mockContainsSecrets.mockImplementation(() => {
			throw new Error("boom");
		});
		const boundaries: string[] = [];
		await runToolCheckLoop(
			makeCtx({
				checks: { secrets_in_source: cfg() },
				event: { ...baseEvent, tool_input: { content: "x" } },
				onCheckBoundary: (n) => boundaries.push(n),
			}),
		);
		expect(boundaries).toContain("inline_secrets_in_source");
	});
});

// ==========================================================================
// ordering / multi-check aggregation
// ==========================================================================

describe("runToolCheckLoop — multi-check aggregation", () => {
	it("returns findings in check (push) order across multiple branches", async () => {
		mockContainsSecrets.mockReturnValue(["k"]);
		mockFindAnyTypes.mockReturnValue([{ kind: "any", line: 1, text: "a: any" }] as never);
		const out = await runToolCheckLoop(
			makeCtx({
				event: { ...baseEvent, tool_input: { content: "secretish" } },
				checks: {
					secrets_in_source: cfg(),
					strong_typing: cfg(),
				},
				getSharedContent: () => "const a: any = 1;",
			}),
		);
		expect(out.map((r) => r.name)).toEqual(["secrets_in_source", "strong_typing"]);
	});
});

// ==========================================================================
// fallback right-hand-sides / ternary alternates (the `|| cwd`, `|| ""`,
// `|| undefined`, and conditional-else paths)
// ==========================================================================

describe("runToolCheckLoop — fallback branches", () => {
	it("dependency_audit: findProjectRoot null → cwd, and slash-less name → pop fallback", async () => {
		mockGetProfileForFile.mockReturnValue(null);
		const { findProjectRoot } = await import("./project-root.js");
		vi.mocked(findProjectRoot).mockReturnValueOnce(null);
		mockResolveDependencyAuditCommand.mockReturnValue(null);
		const out = await runToolCheckLoop(
			makeCtx({
				// no "/" → `filePath.split("/").pop()` is the whole string (still truthy
				// here, but exercises the right-hand operand evaluation); the real
				// `|| ""` fallback for an empty pop is unreachable for a non-empty path,
				// so we instead drive findProjectRoot's `|| cwd` fallback.
				filePath: "package.json",
				absForTestCheck: "/cwd/package.json",
				testCheckBaseName: "package",
				checks: { dependency_audit: cfg({ file_types: [".json"] }) },
			}),
		);
		expect(out).toEqual([]);
		// resolver called with the full slash-less name, cwd fell back to ctx.cwd
		expect(mockResolveDependencyAuditCommand).toHaveBeenCalledWith(
			"package.json",
			expect.any(Object),
		);
	});

	it("dependency_audit: empty filename via trailing slash hits the pop `|| \"\"` fallback", async () => {
		mockResolveDependencyAuditCommand.mockReturnValue(null);
		const out = await runToolCheckLoop(
			makeCtx({
				// trailing slash → split("/").pop() === "" → `|| ""` evaluates RHS
				filePath: "pkgdir/",
				absForTestCheck: "/cwd/pkgdir/",
				testCheckBaseName: "pkgdir",
				checks: { dependency_audit: cfg({ file_types: ["/"] }) },
			}),
		);
		expect(out).toEqual([]);
		expect(mockResolveDependencyAuditCommand).toHaveBeenCalledWith("", expect.any(Object));
	});

	it("affected_tests: extensionless file → `-len || undefined` slice end", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "typescript", inline_checks: [] } as never);
		mockIsLikelyTestFile.mockReturnValue(false);
		const dispatcher = vi.fn().mockReturnValue([]);
		(TEST_DISPATCHERS as Record<string, unknown>).typescript = dispatcher;
		await runToolCheckLoop(
			makeCtx({
				// "Makefile" matches file_types [""] and has no extension, so
				// `-extForTests.length` is -0 (falsy) → slice end = undefined.
				filePath: "Makefile",
				checks: { affected_tests: cfg({ file_types: [""] }) },
			}),
		);
		expect(dispatcher).toHaveBeenCalledTimes(1);
		// extensionless: baseForTests is the whole basename
		expect(dispatcher.mock.calls[0]?.[0]?.absPath).toBe("/cwd/Makefile");
	});

	it("affected_tests: findProjectRoot null → cwd fallback as checkCwd", async () => {
		mockGetProfileForFile.mockReturnValue({ id: "typescript", inline_checks: [] } as never);
		mockIsLikelyTestFile.mockReturnValue(false);
		const { findProjectRoot } = await import("./project-root.js");
		vi.mocked(findProjectRoot).mockReturnValueOnce(null);
		const dispatcher = vi.fn().mockReturnValue([]);
		(TEST_DISPATCHERS as Record<string, unknown>).typescript = dispatcher;
		await runToolCheckLoop(
			makeCtx({ filePath: "src/a.ts", cwd: "/fallbackcwd", checks: { affected_tests: cfg() } }),
		);
		expect(dispatcher.mock.calls[0]?.[0]?.checkCwd).toBe("/fallbackcwd");
	});

	it("lockfile_drift: absolute filePath taken as-is (isAbsolute true branch)", async () => {
		mockCheckLockfileDrift.mockReturnValue({
			drifted: false,
			manifest: "package.json",
			reason: "none",
		});
		const out = await runToolCheckLoop(
			makeCtx({
				filePath: "/abs/package.json",
				absForTestCheck: "/abs/package.json",
				testCheckBaseName: "package",
				checks: { lockfile_drift: cfg({ file_types: [".json"] }) },
			}),
		);
		expect(out).toEqual([]); // not drifted → no finding
		expect(mockCheckLockfileDrift).toHaveBeenCalledWith("/abs/package.json");
	});

	it("software version: postContent NOT containing new_string → `: postContent` alternate", async () => {
		const event = {
			...baseEvent,
			tool_name: "Edit",
			tool_input: { old_string: "old", new_string: "ABSENT-NEW" },
		};
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { software_version_regression: cfg() },
				event,
				baseline: undefined,
				// post content has neither new_string → reverted === postContent
				getSharedContent: () => "totally different content",
			}),
		);
		expect(out).toEqual([]); // no regressions from mock
		// still calls detect with two array args (beforeRefs from reverted===post)
		expect(mockDetectRegressions).toHaveBeenCalledWith([], []);
	});

	it("command branch: findProjectRoot null → cwd fallback as engine projectRoot", async () => {
		mockConfigNameToToolId.mockReturnValue("biome" as never);
		const { findProjectRoot } = await import("./project-root.js");
		vi.mocked(findProjectRoot).mockReturnValueOnce(null);
		const run = engineReturning({ results: [] });
		const out = await runToolCheckLoop(
			makeCtx({
				cwd: "/fallbackcwd",
				checks: { biome: cfg({ command: "biome" }) },
				editedFileInRepo: true,
			}),
		);
		expect(out).toEqual([]);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: "/fallbackcwd" }),
			expect.anything(),
		);
	});

	it("unknown check name with NO command falls through every branch (else-if false)", async () => {
		// Matches none of the named branches and has no `check.command`, so the
		// final `else if (check.command)` is false and nothing runs.
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { some_unknown_inline_check: cfg() },
				editedFileInRepo: true,
			}),
		);
		expect(out).toEqual([]);
		expect(mockGetOrCreateEngine).not.toHaveBeenCalled();
	});
});
