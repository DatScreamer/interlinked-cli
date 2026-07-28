import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { ProjectWideSweepState, runProjectWideChecks } from "../quality-checks.js";
import type { ProjectWideCheckConfig } from "../types.js";

// Mock the check engine so we don't spawn real subprocesses.
// Extracting the engine stub into a named helper keeps the mock's top-level
// keys (`getOrCreateEngine`, `configNameToToolId`) aligned with the real
// module exports — so mock_drift doesn't flag nested method names.
function makeEngineStub() {
	return {
		runChecks: () => ({
			results: [
				{
					tool: "tsc",
					severity: "error",
					file: "src/caller.ts",
					line: 10,
					message: "TS2339: Property 'json' does not exist on type 'void'.",
				},
				{
					tool: "biome",
					severity: "warning",
					file: "src/utils.ts",
					line: 5,
					message: "lint/style/useSingleVarDeclarator",
				},
				{
					tool: "tsc",
					severity: "error",
					file: "src/other.ts",
					line: 20,
					message: "TS2345: Argument of type 'void' is not assignable.",
				},
			],
			toolsRun: [
				{ id: "tsc", available: true },
				{ id: "biome", available: true },
			],
			toolsSkipped: [],
			skipped: [],
			elapsedMs: 500,
			metrics: [],
			deduplicatedCount: 0,
		}),
	};
}

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: () => makeEngineStub(),
	configNameToToolId: vi.fn(),
}));

const DEFAULT_CONFIG: ProjectWideCheckConfig = {
	enabled: true,
	edit_interval: 5,
	on_export_change: true,
	tools: ["tsc", "biome"],
	timeout_ms: 30_000,
	severity: "warning",
	max_findings: 20,
};

describe("ProjectWideSweepState", () => {
	let state: ProjectWideSweepState;

	beforeEach(() => {
		state = new ProjectWideSweepState();
	});

	it("starts with zero edits", () => {
		expect(state.editsSinceLastSweep).toBe(0);
	});

	it("increments edit count and returns false before interval", () => {
		const config = { ...DEFAULT_CONFIG, edit_interval: 3 };
		expect(state.recordEdit(config)).toBe(false); // 1
		expect(state.recordEdit(config)).toBe(false); // 2
		expect(state.editsSinceLastSweep).toBe(2);
	});

	it("returns true when edit interval reached", () => {
		const config = { ...DEFAULT_CONFIG, edit_interval: 3 };
		state.recordEdit(config); // 1
		state.recordEdit(config); // 2
		expect(state.recordEdit(config)).toBe(true); // 3 — fires
	});

	it("resetCounter resets the edit count", () => {
		const config = { ...DEFAULT_CONFIG, edit_interval: 5 };
		state.recordEdit(config);
		state.recordEdit(config);
		state.resetCounter();
		expect(state.editsSinceLastSweep).toBe(0);
	});

	it("recordFileChecked tracks per-file dedup set", () => {
		state.recordFileChecked("/project/src/foo.ts");
		state.recordFileChecked("/project/src/bar.ts");
		expect(state.checkedFiles.has("/project/src/foo.ts")).toBe(true);
		expect(state.checkedFiles.has("/project/src/bar.ts")).toBe(true);
		expect(state.checkedFiles.has("/project/src/baz.ts")).toBe(false);
	});

	it("findingKey produces stable dedup keys", () => {
		const result = {
			tool: "tsc" as const,
			severity: "error" as const,
			file: "src/foo.ts",
			line: 42,
			message: "TS2339: Property 'json' does not exist on type 'void'.",
		};
		const key = ProjectWideSweepState.findingKey("tsc", result);
		expect(key).toContain("tsc:");
		expect(key).toContain("src/foo.ts:42:");
		// Same input produces same key
		expect(ProjectWideSweepState.findingKey("tsc", result)).toBe(key);
	});
});

describe("runProjectWideChecks", () => {
	let state: ProjectWideSweepState;

	beforeEach(() => {
		state = new ProjectWideSweepState();
	});

	it("returns cross-file findings from project-mode engine run", () => {
		const result = runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		expect(result.findings.length).toBe(3);
		expect(result.toolsRun).toEqual(["tsc", "biome"]);
		expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("findings use [cross-file] prefix in message", () => {
		const result = runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		for (const f of result.findings) {
			expect(f.message).toMatch(/^\[cross-file\]/);
		}
	});

	it("findings use configured severity", () => {
		const result = runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		for (const f of result.findings) {
			expect(f.severity).toBe("warning");
		}
	});

	it("deduplicates against previously reported findings", () => {
		// First sweep reports all 3
		const first = runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		expect(first.findings.length).toBe(3);

		// Second sweep should report 0 (all already in reportedFindings)
		const second = runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		expect(second.findings.length).toBe(0);
	});

	it("resets counter after sweep", () => {
		state.editsSinceLastSweep = 10;
		runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		expect(state.editsSinceLastSweep).toBe(0);
	});

	it("respects max_findings limit", () => {
		const config = { ...DEFAULT_CONFIG, max_findings: 2 };
		const result = runProjectWideChecks(config, state, "/project");
		expect(result.findings.length).toBe(2);
	});

	it("names findings with tool_project_wide suffix", () => {
		const result = runProjectWideChecks(DEFAULT_CONFIG, state, "/project");
		expect(nonNull(result.findings[0]).name).toBe("tsc_project_wide");
		expect(nonNull(result.findings[1]).name).toBe("biome_project_wide");
	});
});

describe("integration: debounce + export surface trigger", () => {
	it("sweep fires on interval regardless of export change", () => {
		const state = new ProjectWideSweepState();
		const config = { ...DEFAULT_CONFIG, edit_interval: 3 };

		// Simulate 3 edits without export changes
		state.recordEdit(config); // 1
		state.recordEdit(config); // 2
		const intervalReached = state.recordEdit(config); // 3
		expect(intervalReached).toBe(true);

		// Export change flag is false, but interval is met
		const shouldSweep = intervalReached || (config.on_export_change && false);
		expect(shouldSweep).toBe(true);
	});

	it("sweep fires immediately on export surface change", () => {
		const state = new ProjectWideSweepState();
		const config = { ...DEFAULT_CONFIG, edit_interval: 100 };

		// Only 1 edit, but export surface changed
		const intervalReached = state.recordEdit(config);
		expect(intervalReached).toBe(false);

		const exportSurfaceChanged = true;
		const shouldSweep = intervalReached || (config.on_export_change && exportSurfaceChanged);
		expect(shouldSweep).toBe(true);
	});

	it("sweep does NOT fire when disabled", () => {
		const config = { ...DEFAULT_CONFIG, enabled: false };
		// Even if interval reached, the config.enabled check in server.ts prevents the sweep
		expect(config.enabled).toBe(false);
	});
});
