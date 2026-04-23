// Integration tests for the tsc diff-overlay gate.
// These spin up the TypeScript LanguageService, so the first test is slow
// (~1-3s warmup). Subsequent tests reuse the cached LS and run in ~50ms.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearTscOverlayCache } from "../check-engine/tool-runners/tsc-overlay.js";
import { evaluateTscDiffOverlay, isTscFindingBlocking } from "../diff-overlay.js";

const CLI_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = resolve(CLI_ROOT, "lib");
const FIXTURE_FILE = resolve(FIXTURE_DIR, "_tsc_overlay_fixture.ts");

// A trivially clean starting file — matters that it's clean under the CLI's
// tsconfig so "introduce one new error" tests are unambiguous.
const CLEAN_CONTENT = `// tsc-overlay test fixture
export function identity<T>(x: T): T {
	return x;
}
`;

describe("evaluateTscDiffOverlay", () => {
	beforeAll(() => {
		mkdirSync(FIXTURE_DIR, { recursive: true });
		writeFileSync(FIXTURE_FILE, CLEAN_CONTENT);
		// Ensure a fresh LS for the test file's mtime
		clearTscOverlayCache(CLI_ROOT);
	});

	afterAll(() => {
		try {
			rmSync(FIXTURE_FILE);
		} catch {
			// intentional: best-effort cleanup
		}
		clearTscOverlayCache(CLI_ROOT);
	});

	it("returns no findings when proposed content matches disk", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const result = evaluateTscDiffOverlay(FIXTURE_FILE, onDisk, CLI_ROOT);
		expect(result.newFindings).toEqual([]);
		expect(result.elapsedMs).toBe(0);
	});

	it("flags a newly introduced TS2322 (type not assignable)", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const proposed = `${onDisk}\nconst _bad: number = "not a number";\n`;
		const result = evaluateTscDiffOverlay(FIXTURE_FILE, proposed, CLI_ROOT);
		expect(result.newFindings.length).toBeGreaterThanOrEqual(1);
		const ruleIds = result.newFindings.map((f) => f.ruleId);
		expect(ruleIds).toContain("TS2322");
	});

	it("TS2322 is classified as blocking (not warn-only)", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		const proposed = `${onDisk}\nconst _bad: number = "not a number";\n`;
		const result = evaluateTscDiffOverlay(FIXTURE_FILE, proposed, CLI_ROOT);
		const [ts2322] = result.newFindings.filter((f) => f.ruleId === "TS2322");
		expect(ts2322).toBeDefined();
		expect(isTscFindingBlocking(ts2322 as NonNullable<typeof ts2322>)).toBe(true);
	});

	it("TS6133 (unused variable) is classified as warn-only", () => {
		// Fabricate a CheckResult shaped like tsc would produce
		const fake = {
			tool: "tsc" as const,
			severity: "error" as const,
			file: "x.ts",
			line: 1,
			message: "'foo' is declared but its value is never read.",
			ruleId: "TS6133",
		};
		expect(isTscFindingBlocking(fake)).toBe(false);
	});

	it("returns empty when the target file doesn't exist on disk (new file)", () => {
		const nonExistent = resolve(CLI_ROOT, "lib", "_does_not_exist_tsc.ts");
		const result = evaluateTscDiffOverlay(
			nonExistent,
			"export const x: number = 1;\n",
			CLI_ROOT,
		);
		expect(result.newFindings).toEqual([]);
		expect(result.elapsedMs).toBe(0);
	});

	it("returns empty for files with non-TS extensions", () => {
		const result = evaluateTscDiffOverlay(
			FIXTURE_FILE.replace(".ts", ".md"),
			"whatever",
			CLI_ROOT,
		);
		expect(result.newFindings).toEqual([]);
	});

	it("repeated overlay with clean content after a dirty one returns to clean", () => {
		const onDisk = readFileSync(FIXTURE_FILE, "utf-8");
		// First dirty
		evaluateTscDiffOverlay(FIXTURE_FILE, `${onDisk}\nconst _bad: number = "x";\n`, CLI_ROOT);
		// Then clean — should report no findings
		const clean = evaluateTscDiffOverlay(FIXTURE_FILE, onDisk, CLI_ROOT);
		expect(clean.newFindings).toEqual([]);
	});
});
