// Integration tests for the biome diff-overlay gate.
// These actually invoke biome via `npx biome check`, so each case takes
// ~100-300ms. Acceptable for ~5 tests total.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _isRelativeModuleNotFound, evaluateBiomeDiffOverlay } from "../diff-overlay.js";

type Diag = Parameters<typeof _isRelativeModuleNotFound>[0];
const diag = (message: string): Diag => ({ message }) as Diag;

describe("_isRelativeModuleNotFound — TDD red-step detection", () => {
	it("matches a relative sibling module-not-found", () => {
		expect(
			_isRelativeModuleNotFound(diag("Cannot find module './corpus.js' or its type declarations.")),
		).toBe(true);
	});
	it("matches a parent-relative module-not-found", () => {
		expect(_isRelativeModuleNotFound(diag("Cannot find module '../types.js'."))).toBe(true);
	});
	it("does NOT match a bare package module-not-found", () => {
		expect(_isRelativeModuleNotFound(diag("Cannot find module 'react'."))).toBe(false);
	});
	it("does NOT match an unrelated implicit-any diagnostic", () => {
		expect(_isRelativeModuleNotFound(diag("Parameter 'x' implicitly has an 'any' type."))).toBe(
			false,
		);
	});
	it("handles a missing message field", () => {
		expect(_isRelativeModuleNotFound({} as Diag)).toBe(false);
	});
});

// NB: for this file CLI_ROOT resolves to `src/harness` (two levels up from
// `src/harness/__tests__`), and that is exactly the `projectRoot` the overlay is
// called with — biome/tsc config is found by walking UP from there to the repo
// root. (It is NOT the repo root; don't "fix" it.)
const CLI_ROOT = resolve(import.meta.dirname, "../..");
// Fixtures live in a UNIQUE per-process `mkdtempSync` dir, so no two test files
// (or parallel runs) ever write the same path — the parallel-safety invariant
// (the prior fixed `<CLI_ROOT>/lib` path raced sibling overlay tests under
// `--file-parallelism`, flipping findings to empty). The dir is rooted under
// CLI_ROOT (not os.tmpdir()) for a hard toolchain reason: the check-engine
// rewrites biome overlay findings to a path RELATIVE to projectRoot and then
// filters to that file (index.ts getBiomeDiagnosticsForOverlay). A fixture
// OUTSIDE projectRoot yields a `../…`-laden relative path the filter drops →
// silent zero findings. Rooting under CLI_ROOT (== projectRoot) makes the
// rewrite+filter agree, and biome.json / tsconfig still resolve up-tree. The
// `_…fixtures-` name is skipped by the strip-brace corpus walk.
const FIXTURE_DIR = mkdtempSync(resolve(CLI_ROOT, "_diff_overlay_fixtures-"));
const FIXTURE_FILE = resolve(FIXTURE_DIR, "_overlay_fixture.ts");

const CLEAN_CONTENT = `// overlay test fixture
export function identity<T>(x: T): T {
	return x;
}
`;

describe("evaluateBiomeDiffOverlay", () => {
	beforeAll(() => {
		// FIXTURE_DIR already exists (mkdtempSync created it at module load).
		writeFileSync(FIXTURE_FILE, CLEAN_CONTENT);
		// Warm biome — under parallel test load, npx biome's cold-start can
		// exceed the 500ms overlay budget on the first call, which surfaces
		// as a spurious empty-findings result. One warm invocation primes
		// the npm cache so the assertion runs have stable timing.
		evaluateBiomeDiffOverlay(FIXTURE_FILE, CLEAN_CONTENT, CLI_ROOT);
	}, 30_000);

	afterAll(() => {
		try {
			rmSync(FIXTURE_DIR, { recursive: true, force: true });
		} catch {
			// intentional: best-effort cleanup
		}
	});

	it("returns no findings when proposed content matches disk", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE, onDisk, CLI_ROOT);
		expect(result.newFindings).toEqual([]);
		expect(result.elapsedMs).toBe(0);
	});

	it("returns no findings on an unrelated whitespace change", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		// Collapse a blank line — doesn't change any biome-flaggable content.
		const proposed = onDisk.replace(/\n\n/g, "\n");
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE, proposed, CLI_ROOT);
		expect(result.newFindings).toEqual([]);
	});

	// Retry on rare flake: under parallel full-suite load, npx biome's
	// cold-start can overshoot the per-file overlay budget. The warm-up
	// call in beforeAll handles most of this; retry covers the remainder.
	it("flags a newly introduced noSelfCompare / noDoubleEquals violation", { retry: 2 }, () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const proposed = `${onDisk}\nexport function _probe() {\n\treturn 1 == 1;\n}\n`;
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE, proposed, CLI_ROOT);
		expect(result.newFindings.length).toBeGreaterThan(0);
		const ruleIds = result.newFindings.map((f) => f.ruleId).join(",");
		expect(ruleIds).toMatch(/noSelfCompare|noDoubleEquals/);
	});

	it("returns empty when the target file doesn't exist on disk (new file)", () => {
		const nonExistent = resolve(FIXTURE_DIR, "_does_not_exist_overlay.ts");
		const result = evaluateBiomeDiffOverlay(nonExistent, "export const x = 1;\n", CLI_ROOT);
		// No "before" state → can't call any finding "new".
		expect(result.newFindings).toEqual([]);
		expect(result.elapsedMs).toBe(0);
	});

	it("returns empty for files with non-JS/TS extensions", () => {
		const result = evaluateBiomeDiffOverlay(FIXTURE_FILE.replace(".ts", ".md"), "x", CLI_ROOT);
		expect(result.newFindings).toEqual([]);
	});
});
