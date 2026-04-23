// ===========================================
// tool-results smoke test
// ===========================================

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterCodeQualityResults, runCodeQualityChecks, runSuggestions } from "./tool-results.js";
import type { CodeQualityResults } from "./tool-results-types.js";

let tempDir: string;
let counter = 0;

beforeEach(() => {
	tempDir = join(tmpdir(), `tool-results-test-${process.pid}-${++counter}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runCodeQualityChecks", () => {
	it("returns a full CodeQualityResults object for an empty file set", () => {
		const r = runCodeQualityChecks([], tempDir);
		expect(r.strongTyping).toEqual([]);
		expect(r.suppressions).toEqual([]);
		expect(r.projectLocRatio).toEqual([]);
	});

	it("flags strong-typing issues on a file with `any` usage", () => {
		const file = join(tempDir, "bad.ts");
		writeFileSync(file, "export function foo(x: any): any { return x; }\n");
		const r = runCodeQualityChecks([file], tempDir);
		expect(r.strongTyping.length).toBeGreaterThan(0);
	});
});

describe("filterCodeQualityResults", () => {
	it("drops issues whose check is in the skip set", () => {
		const results: CodeQualityResults = {
			...runCodeQualityChecks([], tempDir),
			strongTyping: [{ check: "strong_typing", file: "a.ts", line: 1, message: "m" }],
		};
		const filtered = filterCodeQualityResults(results, new Set(["strong_typing"]));
		expect(filtered.strongTyping).toEqual([]);
	});

	it("retains unrelated checks", () => {
		const results: CodeQualityResults = {
			...runCodeQualityChecks([], tempDir),
			largeFiles: [{ check: "large_files", file: "a.ts", line: 1, message: "m" }],
		};
		const filtered = filterCodeQualityResults(results, new Set(["strong_typing"]));
		expect(filtered.largeFiles.length).toBe(1);
	});
});

describe("runSuggestions", () => {
	it("returns empty map for no files", () => {
		const r = runSuggestions({ files: [], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("skips test files", () => {
		const file = join(tempDir, "foo.test.ts");
		writeFileSync(file, "describe('x', () => { it('y', () => {}); });\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});
});
