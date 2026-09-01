import { describe, expect, it, vi } from "vitest";
import type { ProjectWideCheckConfig } from "../types.js";
import type { CheckReport } from "../check-engine/types.js";

const { mRunChecks } = vi.hoisted(() => ({ mRunChecks: vi.fn() }));

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: vi.fn(() => ({ runChecks: mRunChecks })),
}));

import { ProjectWideSweepState, runProjectWideChecks } from "./project-wide.js";

/**
 * The sweep debouncer decides how often the expensive project-wide pass runs.
 * Getting it wrong is invisible in the worst direction: too rarely and the sweep
 * silently stops covering the tree, which reads exactly like "no findings".
 *
 * This file exists as the direct companion to `project-wide.ts` — the existing
 * coverage reaches it through the `quality-checks.js` barrel, so neither the
 * no-test-file check nor a cold reader could see that it was tested at all.
 */
function config(over: Partial<ProjectWideCheckConfig> = {}): ProjectWideCheckConfig {
	// SAFETY: the debouncer reads only `edit_interval`; the cast supplies the rest
	// of the config shape without coupling these tests to unrelated fields.
	return { enabled: true, edit_interval: 3, tools: ["biome"], timeout_ms: 1000, ...over } as ProjectWideCheckConfig;
}

describe("ProjectWideSweepState — the sweep debouncer", () => {
	it("does not fire before the interval is reached", () => {
		const s = new ProjectWideSweepState();
		expect(s.recordEdit(config({ edit_interval: 3 }))).toBe(false);
		expect(s.recordEdit(config({ edit_interval: 3 }))).toBe(false);
	});

	it("fires exactly ON the configured interval", () => {
		const s = new ProjectWideSweepState();
		const cfg = config({ edit_interval: 3 });
		s.recordEdit(cfg);
		s.recordEdit(cfg);
		expect(s.recordEdit(cfg)).toBe(true);
	});

	it("keeps firing past the interval until it is reset", () => {
		// The counter is not self-clearing: a caller that forgets to reset must
		// still get sweeps rather than silently stopping.
		const s = new ProjectWideSweepState();
		const cfg = config({ edit_interval: 2 });
		s.recordEdit(cfg);
		expect(s.recordEdit(cfg)).toBe(true);
		expect(s.recordEdit(cfg)).toBe(true);
	});

	it("fires on every edit when the interval is 1", () => {
		const s = new ProjectWideSweepState();
		expect(s.recordEdit(config({ edit_interval: 1 }))).toBe(true);
	});

	it("records checked files so a project-wide sweep can dedup against per-file runs", () => {
		const s = new ProjectWideSweepState();
		s.recordFileChecked("src/a.ts");
		s.recordFileChecked("src/a.ts");
		expect(s.checkedFiles.has("src/a.ts")).toBe(true);
		expect(s.checkedFiles.size).toBe(1);
	});

	it("starts with no checked files and no reported findings", () => {
		const s = new ProjectWideSweepState();
		expect(s.checkedFiles.size).toBe(0);
		expect(s.reportedFindings.size).toBe(0);
		expect(s.editsSinceLastSweep).toBe(0);
	});

	it("does not treat a file as checked just because another was", () => {
		const s = new ProjectWideSweepState();
		s.recordFileChecked("src/a.ts");
		expect(s.checkedFiles.has("src/b.ts")).toBe(false);
	});
});

describe("runProjectWideChecks — unavailable tools", () => {
	it("reports a missing requested tool as deferred and retains the retry cadence", () => {
		const state = new ProjectWideSweepState();
		state.editsSinceLastSweep = 3;
		const report: CheckReport = {
			results: [],
			toolsRun: [{ id: "biome", available: false, reason: "not installed" }],
			toolsSkipped: [{ id: "biome", available: false, reason: "not installed" }],
			skipped: [{ check: "biome", reason: "not installed", category: "tool_missing" }],
			elapsedMs: 0,
			metrics: [],
			deduplicatedCount: 0,
		};
		mRunChecks.mockReturnValueOnce(report);

		const result = runProjectWideChecks(
			config({ tools: ["biome"], max_findings: 10, severity: "warning" }),
			state,
			"/repo",
		);

		expect(result.toolsRun).toEqual([]);
		expect(result.deferredReasons).toEqual(["biome: not installed"]);
		expect(result.findings).toEqual([]);
		expect(state.editsSinceLastSweep).toBe(3);
	});
});
