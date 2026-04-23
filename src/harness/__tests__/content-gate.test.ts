// Tests for the shared content-quality gate consumed by Edit/Write hooks,
// the `interlinked write` CLI subcommand, and MultiEdit.
//
// The gate runs:
//   1. pre_block registry checks (deterministic agent-safety rules)
//   2. biome diff-overlay
//   3. tsc diff-overlay (TypeScript LanguageService)
//   4. (optional) pre_warn registry checks
//
// These tests focus on the shape of the `gateProposedContent` entry point:
// a clean batch, a failing batch, and a mixed-pass/fail batch. The
// per-tool semantics (what biome/tsc flag, how diff-overlay filters
// pre-existing findings) are already covered by `diff-overlay.test.ts`
// and `tsc-overlay.test.ts`.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	formatGateResult,
	GATE_SEVERITY_ERROR,
	GATE_SEVERITY_WARNING,
	gateProposedContent,
	readOnDiskOrUndefined,
} from "../content-gate.js";

const CLI_ROOT = resolve(import.meta.dirname, "../..");
// Fixture files live inside a dedicated subdir under src/lib so biome/tsc
// configs cover them. A unique subdir avoids collision with other tests
// (diff-overlay.test.ts) that write sibling fixtures at the same time.
const FIXTURE_DIR = resolve(CLI_ROOT, "lib/_content_gate_fixtures");
const CLEAN_FIXTURE = resolve(FIXTURE_DIR, "_gate_clean.ts");
const BIOME_FIXTURE = resolve(FIXTURE_DIR, "_gate_biome.ts");
const MIXED_FIXTURE_OK = resolve(FIXTURE_DIR, "_gate_mixed_ok.ts");
const MIXED_FIXTURE_BAD = resolve(FIXTURE_DIR, "_gate_mixed_bad.ts");

const CLEAN_CONTENT = `// clean gate fixture
export function identity<T>(x: T): T {
	return x;
}
`;

// Shared fixture lifecycle — all three describe blocks below rely on the
// same on-disk fixture files. Lifting setup/teardown to the file level
// keeps the `readOnDiskOrUndefined` check working when it runs in a
// separate `describe` block.
beforeAll(() => {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(CLEAN_FIXTURE, CLEAN_CONTENT);
	writeFileSync(BIOME_FIXTURE, CLEAN_CONTENT);
	writeFileSync(MIXED_FIXTURE_OK, CLEAN_CONTENT);
	writeFileSync(MIXED_FIXTURE_BAD, CLEAN_CONTENT);
	// Warm biome — under parallel test load, npx biome's cold-start can
	// exceed the diff-overlay's per-file budget, surfacing as empty results.
	// A priming run stabilises timing for the real assertions below.
	gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
		projectRoot: CLI_ROOT,
	});
});

afterAll(() => {
	// Remove the whole fixture subdir — cleaner than per-file rmSync and
	// leaves no stray state if the test is aborted mid-run.
	try {
		rmSync(FIXTURE_DIR, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

describe("gateProposedContent", () => {
	it("clean batch: returns ok with no failures", () => {
		// Propose identical content — no new findings possible.
		const result = gateProposedContent([{ path: CLEAN_FIXTURE, content: CLEAN_CONTENT }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		expect(typeof result.elapsedMs).toBe("number");
	});

	// Retry on rare flake: under parallel load biome can exceed the per-file
	// overlay budget on cold start. Warm-up in beforeAll covers most cases;
	// retry covers the occasional tail.
	it("biome failure: double-equals trips noSelfCompare/noDoubleEquals", { retry: 2 }, () => {
		// Add a snippet that biome will flag as a new finding.
		const bad = `${CLEAN_CONTENT}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = gateProposedContent([{ path: BIOME_FIXTURE, content: bad }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(false);
		const biomeFails = result.failures.filter((f) => f.tool === "biome");
		expect(biomeFails.length).toBeGreaterThan(0);
		expect(biomeFails[0].severity).toBe(GATE_SEVERITY_ERROR);
		const codes = biomeFails.map((f) => f.code).join(",");
		expect(codes).toMatch(/noSelfCompare|noDoubleEquals/);
	});

	it("mixed batch: one clean + one failing → batch fails, clean file surfaces no failures", { retry: 2 }, () => {
		const bad = `${CLEAN_CONTENT}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = gateProposedContent(
			[
				{ path: MIXED_FIXTURE_OK, content: CLEAN_CONTENT }, // clean
				{ path: MIXED_FIXTURE_BAD, content: bad }, // failing
			],
			{ projectRoot: CLI_ROOT },
		);
		expect(result.ok).toBe(false);
		// Failures are all attributed to the bad fixture, not the clean one.
		const pathsWithFailures = new Set(result.failures.map((f) => f.path));
		expect(pathsWithFailures.has(MIXED_FIXTURE_BAD)).toBe(true);
		expect(pathsWithFailures.has(MIXED_FIXTURE_OK)).toBe(false);
	});

	it("new-file write (no disk snapshot): skips biome/tsc diff, pre_block still runs", () => {
		// A path that doesn't exist on disk. New-file writes can't be diffed,
		// so biome/tsc should produce 0 findings, but the result should still
		// be ok because no pre_block violation fires on this content.
		const nonExistent = resolve(FIXTURE_DIR, "_gate_does_not_exist.ts");
		const result = gateProposedContent([{ path: nonExistent, content: CLEAN_CONTENT }], {
			projectRoot: CLI_ROOT,
		});
		expect(result.ok).toBe(true);
		expect(result.failures.filter((f) => f.tool === "biome")).toEqual([]);
		expect(result.failures.filter((f) => f.tool === "tsc")).toEqual([]);
	});

	it("empty batch: trivially ok", () => {
		const result = gateProposedContent([], { projectRoot: CLI_ROOT });
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});
});

describe("formatGateResult", () => {
	it("renders 'clean' for an ok result with no failures", () => {
		const out = formatGateResult({ ok: true, failures: [], elapsedMs: 1 });
		expect(out).toMatch(/clean/);
	});

	it("renders per-file sections with tool + rule code + line", () => {
		const out = formatGateResult({
			ok: false,
			elapsedMs: 12,
			failures: [
				{
					path: "src/foo.ts",
					tool: "tsc",
					code: "TS2304",
					line: 14,
					message: "Cannot find name 'FROZEN_NOW'",
					severity: GATE_SEVERITY_ERROR,
				},
				{
					path: "src/foo.ts",
					tool: "biome",
					code: "noUnusedImports",
					line: 4,
					message: "vi is declared but never used",
					severity: GATE_SEVERITY_WARNING,
				},
			],
		});
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("TS2304");
		expect(out).toContain("noUnusedImports");
		expect(out).toContain("tsc:");
		expect(out).toContain("biome:");
		// Warning prefix for non-blocking severity.
		expect(out).toContain("warn:");
	});
});

describe("readOnDiskOrUndefined", () => {
	it("returns undefined for a missing path", () => {
		expect(readOnDiskOrUndefined(resolve(FIXTURE_DIR, "_missing.ts"))).toBeUndefined();
	});
	it("returns content for an existing path", () => {
		const result = readOnDiskOrUndefined(CLEAN_FIXTURE);
		expect(result).toBe(CLEAN_CONTENT);
	});
});
