// Smoke tests for project-graph/resolve.ts.

import { describe, expect, it } from "vitest";
import { resolveImportPath, tryResolveFile } from "./resolve.js";

describe("resolve (smoke)", () => {
	it("exports resolveImportPath and tryResolveFile", () => {
		expect(typeof resolveImportPath).toBe("function");
		expect(typeof tryResolveFile).toBe("function");
	});

	it("returns null for bare specifiers without tsconfig paths", () => {
		expect(resolveImportPath("/tmp/a.ts", "commander")).toBeNull();
	});

	it("returns null for non-existent relative candidates", () => {
		expect(resolveImportPath("/tmp/a.ts", "./does-not-exist")).toBeNull();
	});

	it("returns null for tryResolveFile on missing paths", () => {
		expect(tryResolveFile("/tmp/__definitely_missing_file__")).toBeNull();
	});
});
