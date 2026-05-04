// ===========================================
// suggestions unit tests
// ===========================================

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuggestions } from "./suggestions.js";

let tempDir: string;
let counter = 0;

beforeEach(() => {
	tempDir = join(tmpdir(), `suggestions-test-${process.pid}-${++counter}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runSuggestions", () => {
	it("returns empty map when given no files", () => {
		const r = runSuggestions({ files: [], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("skips test files entirely", () => {
		const file = join(tempDir, "foo.test.ts");
		writeFileSync(file, "describe('x', () => { it('y', () => {}); });\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("skips non-JS/TS files", () => {
		const file = join(tempDir, "foo.py");
		writeFileSync(file, "print('hello')\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("registers silent-promise-swallow at the DEFAULT threshold (proves it's not filtered out)", () => {
		// Regression: the harness PostToolUse pipeline and `verify
		// --suggestions` use parallel registries; new checks must be added
		// to BOTH or offline verification silently skips them. AND the
		// scorer must have a BASE_SEVERITY entry above the default
		// threshold (0.5) — without one, the 0.5 fallback × 0.75 default
		// proximity scores 0.375 and gets filtered.
		const file = join(tempDir, "swallow.ts");
		writeFileSync(file, "fetch('/api').catch(() => {});\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 10, threshold: 0.5 });
		const allFindings = [...r.values()].flat();
		expect(allFindings.some((f) => f.check === "silent-promise-swallow")).toBe(true);
	});

	it("registers recursive-walker-lstat at the DEFAULT threshold (proves it's not filtered out)", () => {
		const file = join(tempDir, "walker.ts");
		writeFileSync(
			file,
			[
				"import { readdirSync, statSync } from 'node:fs';",
				"function walk(dir) {",
				"  for (const e of readdirSync(dir)) {",
				"    const p = dir + '/' + e;",
				"    if (statSync(p).isDirectory()) walk(p);",
				"  }",
				"}",
				"",
			].join("\n"),
		);
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 10, threshold: 0.5 });
		const allFindings = [...r.values()].flat();
		expect(allFindings.some((f) => f.check === "recursive-walker-lstat")).toBe(true);
	});
});
