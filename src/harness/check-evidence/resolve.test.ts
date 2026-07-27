// Tests for detector/test-file resolution.
//
// Uses a real temp tree rather than fs mocks: the module's whole job is
// filesystem traversal, and a mocked readdir would pin the mock, not the walk.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildDetectorIndex,
	identifiersIn,
	resolveDetector,
	walkFiles,
} from "./resolve.js";

let root: string;

function write(rel: string, content: string): void {
	const full = join(root, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cec-resolve-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("identifiersIn", () => {
	it("collects distinct identifiers", () => {
		const ids = identifiersIn("import { checkFoo } from './foo.js'; checkFoo(1);");
		expect(ids.has("checkFoo")).toBe(true);
		expect(ids.has("import")).toBe(true);
	});

	it("ignores numeric and punctuation-only tokens", () => {
		const ids = identifiersIn("42 + 7 === 49;");
		expect([...ids]).toEqual([]);
	});
});

describe("walkFiles", () => {
	it("finds nested files matching the predicate", () => {
		write("a/b/c.ts", "export const x = 1;");
		write("a/d.txt", "not typescript");
		const found = walkFiles(root, (p) => p.endsWith(".ts"));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/c\.ts$/);
	});

	it("skips node_modules and dist", () => {
		write("node_modules/pkg/index.ts", "export const y = 1;");
		write("dist/bundle.ts", "export const z = 1;");
		write("src/real.ts", "export const w = 1;");
		const found = walkFiles(root, (p) => p.endsWith(".ts"));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/real\.ts$/);
	});

	it("returns an empty list for a missing root", () => {
		expect(walkFiles(join(root, "nope"), () => true)).toEqual([]);
	});
});

describe("buildDetectorIndex", () => {
	beforeEach(() => {
		write("src/checks/nan.ts", "export function detectNaN(c: string) { return []; }");
		write(
			"src/checks/nan.test.ts",
			"import { detectNaN } from './nan.js';\ndescribe('x', () => { it('P1: fires', () => detectNaN('')); });",
		);
		write("src/checks/other.ts", "export const checkOther = () => [];");
	});

	it("maps an exported function to its repo-relative source file", () => {
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		expect(idx.sourceByFn.get("detectNaN")).toBe(join("src", "checks", "nan.ts"));
	});

	it("indexes exported consts as well as functions", () => {
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		expect(idx.sourceByFn.has("checkOther")).toBe(true);
	});

	it("attributes a test file to the detector it references", () => {
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		expect(idx.testsByFn.get("detectNaN")).toEqual([join("src", "checks", "nan.test.ts")]);
	});

	it("does not index test files as detector sources", () => {
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		for (const file of idx.sourceByFn.values()) {
			expect(file).not.toMatch(/\.test\.ts$/);
		}
	});

	it("attributes a shared suite to every detector it references", () => {
		write(
			"src/checks/shared.test.ts",
			"import { detectNaN } from './nan.js';\nimport { checkOther } from './other.js';\ndetectNaN(''); checkOther();",
		);
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		expect(idx.testsByFn.get("detectNaN")).toContain(join("src", "checks", "shared.test.ts"));
		expect(idx.testsByFn.get("checkOther")).toContain(join("src", "checks", "shared.test.ts"));
	});

	it("caches test source for later parsing", () => {
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		expect(idx.testSource.get(join("src", "checks", "nan.test.ts"))).toMatch(/P1: fires/);
	});
});

describe("resolveDetector", () => {
	it("returns nulls and an empty list for an unknown detector", () => {
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		expect(resolveDetector(idx, "noSuchDetector")).toEqual({
			detectorFile: null,
			testFiles: [],
		});
	});

	it("returns the resolved source and tests for a known detector", () => {
		write("src/checks/nan.ts", "export function detectNaN(c: string) { return []; }");
		write("src/checks/nan.test.ts", "import { detectNaN } from './nan.js'; detectNaN('');");
		const idx = buildDetectorIndex({ searchRoot: root, repoRoot: root });
		const loc = resolveDetector(idx, "detectNaN");
		expect(loc.detectorFile).toMatch(/nan\.ts$/);
		expect(loc.testFiles).toHaveLength(1);
	});
});
