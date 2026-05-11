import { describe, expect, it } from "vitest";
import { SHARED_SKIP_DIRS } from "./skip-dirs.js";

describe("SHARED_SKIP_DIRS", () => {
	it("includes the standard non-project directories", () => {
		for (const d of ["node_modules", ".git", "dist", "build", "target"]) {
			expect(SHARED_SKIP_DIRS.has(d)).toBe(true);
		}
	});

	it("includes interlinked's own data directories", () => {
		expect(SHARED_SKIP_DIRS.has(".interlinked")).toBe(true);
		expect(SHARED_SKIP_DIRS.has("interlinked")).toBe(true);
	});

	it("includes reference-repos (the load-bearing entry: 38K+ files lived there)", () => {
		expect(SHARED_SKIP_DIRS.has("reference-repos")).toBe(true);
	});

	it("does NOT include src — the actual project code must be walked", () => {
		expect(SHARED_SKIP_DIRS.has("src")).toBe(false);
	});

	it("does NOT include docs — docs-extractor needs to walk it", () => {
		expect(SHARED_SKIP_DIRS.has("docs")).toBe(false);
	});

	it("does NOT include test — test-extractor needs to walk it", () => {
		expect(SHARED_SKIP_DIRS.has("test")).toBe(false);
	});
});
