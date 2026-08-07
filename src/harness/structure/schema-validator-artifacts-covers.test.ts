// Unit tests for schema-validator-artifacts-covers.ts — per-artifact-file
// schema validators (tests, docs, examples, packages). Each validator
// rejects unknown keys and malformed shapes; these tests assert the actual
// rejection (path + message), not just that validity flipped to false.

import { describe, expect, it } from "vitest";
import {
	validateDocsFile,
	validateExamplesFile,
	validatePackagesFile,
	validateTestsFile,
} from "./schema-validator-artifacts-covers.js";

/** Convenience: find the first error whose path matches exactly. */
function errAt(result: { errors: Array<{ path: string; message: string }> }, path: string) {
	return result.errors.find((e) => e.path === path);
}

// ----------------------------------------------------------------------------
// validateTestsFile
// ----------------------------------------------------------------------------

describe("validateTestsFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [
				{
					id: "test-a",
					file: "src/a.test.ts",
					kind: "unit",
					covers: [{ artifact_kind: "module", artifact_id: "mod-a" }],
				},
			],
		});
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("accepts an empty tests array", () => {
		expect(validateTestsFile({ version: 1, tests: [] })).toEqual({ valid: true, errors: [] });
	});

	it("rejects a non-object payload (string)", () => {
		const result = validateTestsFile("not an object");
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects a null payload", () => {
		const result = validateTestsFile(null);
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects an array payload", () => {
		const result = validateTestsFile([]);
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects an unknown top-level key", () => {
		const result = validateTestsFile({ version: 1, tests: [], bogus: true });
		expect(errAt(result, "$.bogus")?.message).toBe('Unknown key "bogus"');
	});

	it("rejects a version that is not 1", () => {
		const result = validateTestsFile({ version: 2, tests: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects when tests is not an array and returns immediately", () => {
		const result = validateTestsFile({ version: 1, tests: "nope" });
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([{ path: "$.tests", message: "Must be an array" }]);
	});

	it("rejects a non-string test id", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [{ id: 5, file: "a.ts", kind: "unit", covers: [] }],
		});
		expect(errAt(result, "$.tests[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a duplicate test id", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [
				{ id: "dup", file: "a.ts", kind: "unit", covers: [] },
				{ id: "dup", file: "b.ts", kind: "unit", covers: [] },
			],
		});
		expect(errAt(result, "$.tests[1].id")?.message).toBe('Duplicate test ID "dup"');
	});

	it("rejects a non-string test file", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [{ id: "t", file: 5, kind: "unit", covers: [] }],
		});
		expect(errAt(result, "$.tests[0].file")?.message).toBe("Must be a string");
	});

	it("rejects a test file that is not repo-relative", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [{ id: "t", file: "/abs/a.ts", kind: "unit", covers: [] }],
		});
		expect(errAt(result, "$.tests[0].file")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("rejects an invalid test kind", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [{ id: "t", file: "a.ts", kind: "bogus", covers: [] }],
		});
		expect(errAt(result, "$.tests[0].kind")?.message).toMatch(/^Must be one of: /);
	});

	it("treats a non-array covers as empty and does not error on covers itself", () => {
		const result = validateTestsFile({
			version: 1,
			tests: [{ id: "t", file: "a.ts", kind: "unit", covers: "nope" }],
		});
		expect(result.valid).toBe(true);
	});
});

// ----------------------------------------------------------------------------
// validateDocsFile
// ----------------------------------------------------------------------------

describe("validateDocsFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [
				{
					id: "doc-a",
					file: "docs/a.md",
					kind: "reference",
					covers: [{ artifact_kind: "module", artifact_id: "mod-a" }],
				},
			],
		});
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("rejects a non-object payload", () => {
		const result = validateDocsFile(42);
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects an array payload", () => {
		expect(validateDocsFile([]).valid).toBe(false);
	});

	it("rejects a version that is not 1", () => {
		const result = validateDocsFile({ version: "1", docs: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects when docs is not an array and returns immediately", () => {
		const result = validateDocsFile({ version: 1, docs: {} });
		expect(result.errors).toEqual([{ path: "$.docs", message: "Must be an array" }]);
	});

	it("rejects a non-string doc id", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [{ id: 1, file: "a.md", kind: "reference", covers: [] }],
		});
		expect(errAt(result, "$.docs[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a duplicate doc id", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [
				{ id: "dup", file: "a.md", kind: "reference", covers: [] },
				{ id: "dup", file: "b.md", kind: "reference", covers: [] },
			],
		});
		expect(errAt(result, "$.docs[1].id")?.message).toBe('Duplicate doc ID "dup"');
	});

	it("rejects a non-string doc file", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [{ id: "d", file: 1, kind: "reference", covers: [] }],
		});
		expect(errAt(result, "$.docs[0].file")?.message).toBe("Must be a string");
	});

	it("rejects a doc file that is not repo-relative", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [{ id: "d", file: "../escape.md", kind: "reference", covers: [] }],
		});
		expect(errAt(result, "$.docs[0].file")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("rejects an invalid doc kind", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [{ id: "d", file: "a.md", kind: "bogus", covers: [] }],
		});
		expect(errAt(result, "$.docs[0].kind")?.message).toMatch(/^Must be one of: /);
	});

	it("treats a non-array covers as empty", () => {
		const result = validateDocsFile({
			version: 1,
			docs: [{ id: "d", file: "a.md", kind: "reference", covers: null }],
		});
		expect(result.valid).toBe(true);
	});
});

// ----------------------------------------------------------------------------
// validateExamplesFile
// ----------------------------------------------------------------------------

describe("validateExamplesFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateExamplesFile({
			version: 1,
			examples: [
				{
					id: "ex-a",
					file: "examples/a.ts",
					covers: [{ artifact_kind: "module", artifact_id: "mod-a" }],
				},
			],
		});
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("rejects a non-object payload", () => {
		const result = validateExamplesFile("nope");
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects a null payload", () => {
		expect(validateExamplesFile(null).valid).toBe(false);
	});

	it("rejects a version that is not 1", () => {
		const result = validateExamplesFile({ version: 0, examples: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects when examples is not an array and returns immediately", () => {
		const result = validateExamplesFile({ version: 1, examples: "nope" });
		expect(result.errors).toEqual([{ path: "$.examples", message: "Must be an array" }]);
	});

	it("rejects a non-string example id", () => {
		const result = validateExamplesFile({
			version: 1,
			examples: [{ id: 1, file: "a.ts", covers: [] }],
		});
		expect(errAt(result, "$.examples[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a duplicate example id", () => {
		const result = validateExamplesFile({
			version: 1,
			examples: [
				{ id: "dup", file: "a.ts", covers: [] },
				{ id: "dup", file: "b.ts", covers: [] },
			],
		});
		expect(errAt(result, "$.examples[1].id")?.message).toBe('Duplicate example ID "dup"');
	});

	it("rejects a non-string example file", () => {
		const result = validateExamplesFile({
			version: 1,
			examples: [{ id: "e", file: 1, covers: [] }],
		});
		expect(errAt(result, "$.examples[0].file")?.message).toBe("Must be a string");
	});

	it("rejects an example file that is not repo-relative", () => {
		const result = validateExamplesFile({
			version: 1,
			examples: [{ id: "e", file: "/abs.ts", covers: [] }],
		});
		expect(errAt(result, "$.examples[0].file")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("treats a non-array covers as empty", () => {
		const result = validateExamplesFile({
			version: 1,
			examples: [{ id: "e", file: "a.ts", covers: 5 }],
		});
		expect(result.valid).toBe(true);
	});
});

// ----------------------------------------------------------------------------
// validatePackagesFile
// ----------------------------------------------------------------------------

describe("validatePackagesFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [{ id: "pkg-a", root: "packages/a", entrypoints: ["src/index.ts"] }],
		});
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("rejects a non-object payload", () => {
		const result = validatePackagesFile("nope");
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects an array payload", () => {
		expect(validatePackagesFile([]).valid).toBe(false);
	});

	it("rejects a version that is not 1", () => {
		const result = validatePackagesFile({ version: 2, packages: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects when packages is not an array and returns immediately", () => {
		const result = validatePackagesFile({ version: 1, packages: "nope" });
		expect(result.errors).toEqual([{ path: "$.packages", message: "Must be an array" }]);
	});

	it("rejects a non-string package id", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [{ id: 1, root: "packages/a", entrypoints: [] }],
		});
		expect(errAt(result, "$.packages[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a duplicate package id", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [
				{ id: "dup", root: "packages/a", entrypoints: [] },
				{ id: "dup", root: "packages/b", entrypoints: [] },
			],
		});
		expect(errAt(result, "$.packages[1].id")?.message).toBe('Duplicate package ID "dup"');
	});

	it("rejects a non-string package root", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [{ id: "p", root: 1, entrypoints: [] }],
		});
		expect(errAt(result, "$.packages[0].root")?.message).toBe("Must be a string");
	});

	it("rejects a package root that is not repo-relative", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [{ id: "p", root: "/abs", entrypoints: [] }],
		});
		expect(errAt(result, "$.packages[0].root")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("rejects entrypoints that are not an array", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [{ id: "p", root: "packages/a", entrypoints: "nope" }],
		});
		expect(errAt(result, "$.packages[0].entrypoints")?.message).toBe("Must be an array");
	});

	it("defaults a missing entrypoints field to an empty array (valid)", () => {
		const result = validatePackagesFile({
			version: 1,
			packages: [{ id: "p", root: "packages/a" }],
		});
		expect(result.valid).toBe(true);
	});
});
