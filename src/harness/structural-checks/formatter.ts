// ===========================================
// Structural Check Formatting
// ===========================================
// Renders StructuralCheckResult records as [interlinked:<check>] stderr
// warning strings with per-check remediation advice appended.

import type { StructuralCheckResult } from "../types.js";

/** Per-check instructions appended to warnings */
const CHECK_INSTRUCTIONS: Record<string, string> = {
	export_surface:
		"Update all affected importers. If the export was renamed, update import statements. If removed, remove the import or add an alternative.",
	import_resolution:
		"Fix the broken import. The target file may have been moved, renamed, or the export removed by another agent. Re-read the target file.",
	duplicate_symbols:
		"Consider using the existing export instead of creating a new one. If both are needed, use distinct names to avoid confusion.",
	co_dependency_staleness:
		"Coordinate with the other agent(s) via MCP messaging. They may be working with a stale understanding of this file's contract.",
	import_cycles:
		"Break the cycle by extracting shared types/interfaces into a separate module, or by using dynamic imports for one direction.",
	new_import_cycle:
		"This specific edit closed the loop — undo the new import, or break the cycle by extracting shared types/interfaces into a separate module.",
	interface_change_impact:
		"Verify all files that import this interface/type still conform to the new shape. Run type-check to confirm.",
	test_proximity:
		"Consider updating or adding tests for this file. Tests catch regressions from multi-agent edits.",
	dead_imports:
		"Remove unused imports. They add unnecessary dependencies and can confuse readers about what the file actually uses.",
	dead_exports:
		"Remove unused exports or mark them as internal. Dead exports add maintenance burden.",
	hallucinated_imports:
		"Install the missing package or fix the import. This package is not in package.json.",
	cross_package_imports:
		"Use the package name instead of a relative import that crosses package boundaries.",
	undefined_env_vars:
		"Add the environment variable to .env.example so other developers know it's needed.",
	jsdoc_param_mismatch: "Update JSDoc @param tags to match the actual function parameters.",
	export_ripple_compilation:
		"The export change broke downstream importers. Fix the type errors in the listed files, or revert the export change and update importers first.",
	export_ripple_tests:
		"Tests are failing after this export surface change. Fix the source so existing tests pass. Do NOT modify tests to suppress failures.",
};

// Noisy checks that should go through the scored suggestion pipeline instead of
// being dumped as raw warnings. These are filtered out of the structural output.
const NOISY_CHECKS = new Set([
	"dead_imports",
	"dead_exports",
	"test_proximity",
	"duplicate_symbols",
]);

/**
 * Public API — consumed by server.ts / evaluator.
 *
 * Format structural check results as stderr warning strings.
 */
export function formatStructuralWarnings(results: StructuralCheckResult[]): string[] {
	return results
		.filter((r) => !NOISY_CHECKS.has(r.check))
		.map((r) => {
			let msg = `[interlinked:${r.check}] ${r.message}`;
			if (r.detail) {
				msg += `\n${r.detail}`;
			}
			const instruction = CHECK_INSTRUCTIONS[r.check];
			if (instruction) {
				msg += `\n→ ${instruction}`;
			}
			return msg;
		});
}
