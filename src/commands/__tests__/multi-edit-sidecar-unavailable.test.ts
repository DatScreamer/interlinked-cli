// ===========================================
// multi-edit × sidecar-unavailable — "unavailable is not clean"
// ===========================================
//
// Review-mandated regression pin: when the tsc-overlay SIDECAR cannot run
// (spawn failure, timeout, cooldown), `interlinked multi-edit` must REJECT
// the transaction and leave every file unchanged — never accept the batch on
// the strength of a checker that never ran. Before the typed
// SidecarOverlayOutcome landed, every sidecar failure collapsed to `[]`
// (indistinguishable from "checked clean") and multi-edit landed edits that
// introduced type errors.
//
// The sidecar CLIENT is mocked for determinism (per the review contract);
// everything above it — tsc-overlay dispatch, diff-overlay, the multi-edit
// gate and transactional write — is real. The happy-path integration suite
// (multi-edit.test.ts) pins the in-process mode; this file pins the sidecar
// mode's failure branch.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SidecarOverlayOutcome } from "../../harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js";

const UNAVAILABLE: SidecarOverlayOutcome = {
	status: "unavailable",
	reason: "sidecar killed by signal SIGTERM (timeout or external kill)",
};

// Mock ONLY the sidecar client. `runTscOverlayTyped` (real) dispatches here
// when the mode is "sidecar", so the typed unavailable outcome flows through
// the real diff-overlay → gate → transaction plumbing.
vi.mock("../../harness/check-engine/tool-runners/tsc-overlay-sidecar-client.js", () => ({
	runOverlayViaSidecarTyped: (): SidecarOverlayOutcome => UNAVAILABLE,
	runOverlayViaSidecar: (): never[] => [],
}));

import { sweepStaleFixtureDirs } from "../../harness/__tests__/fixture-hygiene.js";
import { _setTscOverlayModeOverrideForTest } from "../../harness/check-engine/tool-runners/tsc-overlay.js";
import { TSC_CHECKER_UNAVAILABLE_CODE } from "../../harness/diff-overlay.js";
import { gateProposedContentInline, MULTI_EDIT_ERROR_CODES, runMultiEdit } from "../multi-edit.js";

// Repo root (three levels up) — fixtures must live under projectRoot so the
// real biome/tsc plumbing treats them as project files (see multi-edit.test.ts
// for the full rationale).
const CLI_ROOT = resolve(import.meta.dirname, "../..", "..");
sweepStaleFixtureDirs(CLI_ROOT);
const FIXTURE_DIR = mkdtempSync(resolve(CLI_ROOT, "_multi_edit_sidecar_fixtures-"));

const INITIAL_CONTENT = 'export const SIDE_A = "one";\n';
const FIXTURE_PATH = resolve(FIXTURE_DIR, "_sidecar_unavailable_fixture.ts");

process.on("exit", () => {
	try {
		rmSync(FIXTURE_DIR, { recursive: true, force: true });
		// interlinked-ignore: empty_catch — process is exiting; nothing useful to do
	} catch {}
});

beforeAll(() => {
	// Force the sidecar transport so the mocked client is what the real
	// dispatcher calls — regardless of this repo's tsc_overlay config.
	_setTscOverlayModeOverrideForTest("sidecar");
	writeFileSync(FIXTURE_PATH, INITIAL_CONTENT, "utf-8");
});

afterAll(() => {
	_setTscOverlayModeOverrideForTest(null);
	rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("multi-edit × sidecar unavailable — positive (must fire)", () => {
	it("P1: rejects the transaction (GATE_REJECTED) and leaves the file unchanged", () => {
		const result = runMultiEdit([
			{
				path: FIXTURE_PATH,
				edits: [
					{
						old_string: 'export const SIDE_A = "one";',
						new_string: 'export const SIDE_A = "two";',
					},
				],
			},
		]);

		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.GATE_REJECTED);
		expect(result.file_changes_applied).toEqual([]);
		// Files unchanged — the transaction never wrote.
		expect(readFileSync(FIXTURE_PATH, "utf-8")).toBe(INITIAL_CONTENT);
		// The failure names the unavailable checker, not a type error.
		const unavailable = result.gate_failures?.find(
			(f) => f.code === TSC_CHECKER_UNAVAILABLE_CODE,
		);
		expect(unavailable).toBeDefined();
		expect(unavailable?.tool).toBe("tsc");
		expect(unavailable?.message).toMatch(/unavailable is not clean/);
	}, 60_000);

	it("P2: gateProposedContentInline surfaces one unavailable failure per proposed file", () => {
		const failures = gateProposedContentInline(
			[{ path: FIXTURE_PATH, content: 'export const SIDE_A = "three";\n' }],
			{ projectRoot: CLI_ROOT },
		);
		const unavailable = failures.filter((f) => f.code === TSC_CHECKER_UNAVAILABLE_CODE);
		expect(unavailable).toHaveLength(1);
		expect(unavailable[0]?.message).toMatch(/type checker unavailable/);
	}, 60_000);
});
