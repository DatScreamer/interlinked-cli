import { describe, expect, it } from "vitest";
import { formatStructuralWarnings } from "../structural-checks.js";
import type { StructuralCheckResult } from "../types.js";

describe("structural checks extended — formatting and instructions", () => {
	it("filters out noisy checks (dead_exports, dead_imports, test_proximity)", () => {
		const results: StructuralCheckResult[] = [
			{ check: "dead_exports", severity: "info", message: "Unused exports", file: "a.ts" },
			{ check: "dead_imports", severity: "info", message: "Unused imports", file: "b.ts" },
			{ check: "test_proximity", severity: "info", message: "No test file", file: "c.ts" },
		];
		const warnings = formatStructuralWarnings(results);
		expect(warnings).toHaveLength(0);
	});

	it("formats hallucinated_imports check results with instructions", () => {
		const results: StructuralCheckResult[] = [
			{
				check: "hallucinated_imports",
				severity: "warning",
				message: 'src/app.ts imports "nonexistent-pkg" but it is not in package.json.',
				file: "src/app.ts",
			},
		];
		const warnings = formatStructuralWarnings(results);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:hallucinated_imports]");
		expect(warnings[0]).toContain("Install the missing package");
	});

	it("formats cross_package_imports check results with instructions", () => {
		const results: StructuralCheckResult[] = [
			{
				check: "cross_package_imports",
				severity: "warning",
				message: "src/app.ts crosses a package.json boundary.",
				file: "src/app.ts",
			},
		];
		const warnings = formatStructuralWarnings(results);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[interlinked:cross_package_imports]");
		expect(warnings[0]).toContain("package name");
	});

	it("includes detail when present", () => {
		const results: StructuralCheckResult[] = [
			{
				check: "export_surface",
				severity: "warning",
				message: "Export surface changed",
				file: "src/utils.ts",
				detail: "  foo removed, bar added",
			},
		];
		const warnings = formatStructuralWarnings(results);
		expect(warnings[0]).toContain("foo removed, bar added");
	});

	it("handles mixed results — filters noisy, keeps actionable", () => {
		const results: StructuralCheckResult[] = [
			{ check: "dead_exports", severity: "info", message: "Unused export", file: "a.ts" },
			{
				check: "hallucinated_imports",
				severity: "warning",
				message: "Missing package",
				file: "b.ts",
			},
			{
				check: "jsdoc_param_mismatch",
				severity: "warning",
				message: "Param mismatch",
				file: "c.ts",
			},
		];
		const warnings = formatStructuralWarnings(results);
		expect(warnings).toHaveLength(2);
	});
});
