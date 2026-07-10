// Tests for the skipped-tests water-line policy loader.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	emptySkippedTestsBaseline,
	loadSkippedTestsBaseline,
	maxSkippedFor,
	SKIPPED_TESTS_BASELINE_REL,
} from "./skipped-tests-policy.js";

let root: string | null = null;

function makeRoot(baselineJson?: string): string {
	root = mkdtempSync(join(tmpdir(), "skip-baseline-"));
	if (baselineJson !== undefined) {
		const path = join(root, SKIPPED_TESTS_BASELINE_REL);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(path, baselineJson, "utf-8");
	}
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = null;
});

describe("loadSkippedTestsBaseline", () => {
	it("loads a valid baseline", () => {
		const dir = makeRoot(
			JSON.stringify({ version: 1, max_skipped: 0, files: { "src/legacy.test.ts": 3 } }),
		);
		const baseline = loadSkippedTestsBaseline(dir);
		expect(baseline).toEqual({
			version: 1,
			max_skipped: 0,
			files: { "src/legacy.test.ts": 3 },
		});
	});

	it("returns null when the file is absent", () => {
		expect(loadSkippedTestsBaseline(makeRoot())).toBeNull();
	});

	it("returns null on malformed JSON or wrong version", () => {
		expect(loadSkippedTestsBaseline(makeRoot("{not json"))).toBeNull();
		expect(loadSkippedTestsBaseline(makeRoot(JSON.stringify({ version: 2 })))).toBeNull();
	});

	it("tolerates a missing/invalid files map", () => {
		const dir = makeRoot(JSON.stringify({ version: 1, max_skipped: 1 }));
		expect(loadSkippedTestsBaseline(dir)).toEqual({ version: 1, max_skipped: 1, files: {} });
	});
});

describe("maxSkippedFor", () => {
	const baseline = { version: 1 as const, max_skipped: 0, files: { "a.test.ts": 4 } };

	it("grandfathered file gets its recorded ceiling", () => {
		expect(maxSkippedFor(baseline, "a.test.ts")).toBe(4);
	});

	it("everything else gets the global cap", () => {
		expect(maxSkippedFor(baseline, "b.test.ts")).toBe(0);
	});

	it("no baseline means the empty-baseline floor (0)", () => {
		expect(maxSkippedFor(null, "a.test.ts")).toBe(emptySkippedTestsBaseline().max_skipped);
	});
});
