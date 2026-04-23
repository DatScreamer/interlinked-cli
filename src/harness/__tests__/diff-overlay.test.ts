// Integration tests for the biome diff-overlay gate.
// These actually invoke biome via `npx biome check`, so each case takes
// ~100-300ms. Acceptable for ~5 tests total.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateBiomeDiffOverlay } from "../diff-overlay.js";

const CLI_ROOT = resolve(import.meta.dirname, "../..");
// Use a fixture path inside src/ so biome's config scope includes it.
const FIXTURE_DIR = resolve(CLI_ROOT, "lib");
const FIXTURE_FILE = resolve(FIXTURE_DIR, "_overlay_fixture.ts");

const CLEAN_CONTENT = `// overlay test fixture
export function identity<T>(x: T): T {
	return x;
}
`;

describe("evaluateBiomeDiffOverlay", () => {
	beforeAll(() => {
		mkdirSync(FIXTURE_DIR, { recursive: true });
		writeFileSync(FIXTURE_FILE, CLEAN_CONTENT);
		// Warm biome — under parallel test load, npx biome's cold-start can
		// exceed the 500ms overlay budget on the first call, which surfaces
		// as a spurious empty-findings result. One warm invocation primes
		// the npm cache so the assertion runs have stable timing.
		evaluateBiomeDiffOverlay(FIXTURE_FILE, CLEAN_CONTENT, CLI_ROOT);
	});

	afterAll(() => {
		try {
			rmSync(FIXTURE_FILE);
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
		const nonExistent = resolve(CLI_ROOT, "lib", "_does_not_exist_overlay.ts");
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
