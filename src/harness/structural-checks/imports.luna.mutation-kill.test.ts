import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type { ImportEdge } from "../types/graph.js";
import { checkCrossPackageImports, checkDeadImports, checkHallucinatedImports } from "./imports.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);
const filePath = "/proj/src/a.ts";
const relPath = "src/a.ts";

afterEach(() => vi.resetAllMocks());

function graph(dependencies: ImportEdge[]): ProjectGraph {
	// SAFETY: the structural check only calls these ProjectGraph methods, all of
	// which are supplied by the typed mock object above.
	return {
		getDependencies: vi.fn().mockReturnValue(dependencies),
		getExports: vi.fn().mockReturnValue([]),
		findDuplicateExports: vi.fn().mockReturnValue([]),
		toRelative: vi.fn((path: string) => path.replace(/^\/proj\//, "")),
	} as unknown as ProjectGraph;
}

function edge(overrides: Partial<ImportEdge> = {}): ImportEdge {
	return {
		fromFile: filePath,
		toFile: "",
		specifier: "ghost",
		symbols: [],
		isTypeOnly: false,
		...overrides,
	};
}

describe("dead import scanning contracts", () => {
	// test-contract: boundary — a source file without imports has no bindings to
	// report, regardless of executable statements in its body.
	it("returns no finding when the source has no import section", () => {
		mockFs.readFileSync.mockReturnValue("const value = 1;\n");
		expect(checkDeadImports(filePath, relPath)).toEqual([]);
	});

	// test-contract: boundary — import syntax permits more than one separating
	// space, and the named binding must still be checked for use.
	it("parses a named import with multiple spaces after import", () => {
		mockFs.readFileSync.mockReturnValue("import  { unused } from './m';\nconst value = 1;\n");
		const result = checkDeadImports(filePath, relPath);
		expect(result[0]?.message).toContain("`unused`");
	});

	// test-contract: boundary — default imports have the same whitespace
	// tolerance as named imports and retain their local binding name.
	it("parses a default import with multiple spaces after import", () => {
		mockFs.readFileSync.mockReturnValue("import  DefaultThing from './m';\nconst value = 1;\n");
		const result = checkDeadImports(filePath, relPath);
		expect(result[0]?.message).toContain("`DefaultThing`");
	});
});

describe("hallucinated import ancestor lookup", () => {
	// test-contract: boundary — an importer at the filesystem root has no parent
	// directory to search; the root package.json must not be examined repeatedly.
	it("stops at the filesystem root while searching for package.json", () => {
		mockFs.existsSync.mockReturnValue(false);
		const result = checkHallucinatedImports(
			"/a.ts",
			"a.ts",
			graph([edge({ specifier: "ghost", toFile: "" })]),
		);
		expect(result).toEqual([]);
		expect(mockFs.existsSync).toHaveBeenCalledTimes(1);
	});
});

describe("cross-package import boundary contracts", () => {
	// test-contract: boundary — a relative edge without a resolved target cannot
	// establish a package boundary and must be ignored.
	it("ignores unresolved relative edges", () => {
		const result = checkCrossPackageImports(
			filePath,
			relPath,
			graph([edge({ specifier: "../pkg/module", toFile: "" })]),
		);
		expect(result).toEqual([]);
	});
});
