// Real-overlay integration test for the per-edit coverage block.
//
// Proves the apply-before-disk overlay (`createCoverageOverlay`) + the
// `JsCoverageRunner` actually MEASURE coverage end-to-end on a real tree: a
// throwaway one-module fixture with its test, run through a genuine
// `vitest run --coverage` against the overlay (no stubs). This is the one test
// that exercises the whole lane for real; every other coverage-guard test
// injects a stub runner so no real suite runs.
//
// GUARDED behind `INTERLINKED_RUN_COVERAGE_OVERLAY_E2E=1` because it spawns a
// full vitest-under-coverage process (~seconds) — too slow for the default fast
// path and the ~2x-slower macOS CI runner (feedback_ci_macos_slow_test_timeout).
// Run it explicitly:
//   INTERLINKED_RUN_COVERAGE_OVERLAY_E2E=1 npx vitest run src/harness/coverage-overlay.integration.test.ts

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetCoverageFinalCache } from "./coverage-final-reader.js";
import { createCoverageOverlay } from "./coverage-overlay.js";
import { JsCoverageRunner } from "./coverage-runner.js";

const RUN = process.env.INTERLINKED_RUN_COVERAGE_OVERLAY_E2E === "1";
// Reuse THIS repo's installed vitest + coverage-v8 so the fixture needs no
// install; the overlay symlinks node_modules from the fixture root, which we
// point back here.
const REPO_ROOT = resolve(import.meta.dirname, "../..");

let fixture: string;

beforeAll(() => {
	if (!RUN) return;
	fixture = mkdtempSync(join(tmpdir(), "interlinked-cov-e2e-"));
	mkdirSync(join(fixture, "src"), { recursive: true });

	// A one-module fixture: `used()` is exercised by the test; `unused()` is not.
	writeFileSync(
		join(fixture, "src", "math.ts"),
		[
			"export function used(a: number, b: number): number {",
			"  return a + b;",
			"}",
			"export function unused(a: number, b: number): number {",
			"  return a - b;",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(fixture, "src", "math.test.ts"),
		[
			'import { describe, it, expect } from "vitest";',
			'import { used } from "./math.js";',
			'describe("math", () => {',
			'  it("adds", () => {',
			"    expect(used(2, 3)).toBe(5);",
			"  });",
			"});",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(fixture, "vitest.config.ts"),
		[
			'import { defineConfig } from "vitest/config";',
			"export default defineConfig({",
			"  test: { include: ['src/**/*.test.ts'] },",
			"});",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(fixture, "package.json"),
		JSON.stringify({ name: "cov-e2e-fixture", type: "module", private: true }),
	);
	// Point the fixture's node_modules at this repo's so vitest resolves.
	try {
		symlinkSync(join(REPO_ROOT, "node_modules"), join(fixture, "node_modules"), "dir");
	} catch (err) {
		// intentional: a pre-existing link is fine; the overlay also symlinks
		// node_modules from the fixture root, so resolution still works.
		void err;
	}
});

afterAll(() => {
	if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe.skipIf(!RUN)("coverage overlay + JsCoverageRunner (real suite)", () => {
	it(
		"measures real coverage on the overlay: edited function covered, sibling uncovered",
		async () => {
			__resetCoverageFinalCache();
			// Propose an edit to `used()` that the test still covers.
			const proposed = [
				"export function used(a: number, b: number): number {",
				"  const sum = a + b;",
				"  return sum;",
				"}",
				"export function unused(a: number, b: number): number {",
				"  return a - b;",
				"}",
				"",
			].join("\n");

			const overlay = createCoverageOverlay(fixture, "src/math.ts", proposed);
			try {
				const runner = new JsCoverageRunner();
				const result = await runner.run({
					projectRoot: overlay.overlayRoot,
					coverageDir: join(overlay.overlayRoot, ".interlinked", "coverage"),
				});

				expect(result.ok).toBe(true);
				expect(result.suiteMs).toBeGreaterThan(0);

				const cov = result.perFile.get("src/math.ts");
				expect(cov).toBeDefined();
				const used = cov?.functions.find((f) => f.name === "used");
				const unused = cov?.functions.find((f) => f.name === "unused");
				// `used` is exercised by the test → covered; `unused` is never called.
				expect((used?.statement_pct ?? 0) > 0).toBe(true);
				expect(unused?.hits ?? -1).toBe(0);
			} finally {
				overlay.cleanup();
			}
		},
		120_000,
	);
});
