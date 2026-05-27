// Metadata for structural checks (PostToolUse, dependency-aware).
// Keys must match the boolean fields in StructuralChecksConfig.
// Extracted from check-metadata.ts so the doc generator can import domains
// individually without paying the cost of the combined map.

import type { CheckMeta } from "./types.js";

/** Public API — consumed by doc generation, docs-freshness test, and the
 *  top-level re-export in check-metadata.ts. */
export const STRUCTURAL_CHECK_META: Record<string, CheckMeta> = {
	// Tier 1: sub-100ms, every edit
	export_surface: {
		name: "Export Surface",
		description:
			"Detects breaking changes to exported symbols (renamed, removed, type-changed)",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	import_resolution: {
		name: "Import Resolution",
		description:
			"Validates all imports resolve to real files — catches typos and deleted modules",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	duplicate_symbols: {
		name: "Duplicate Symbols",
		description: "Flags identical export names across files that could cause ambiguous imports",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	co_dependency_staleness: {
		name: "Co-Dependency Staleness",
		description:
			"Warns when a file's dependencies were recently edited but this file wasn't updated",
		tier: 1,
		determinism: "partially_deterministic",
		externality: "local_write",
	},
	dead_imports: {
		name: "Dead Imports",
		description: "Detects imports that are no longer used after an edit",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	dead_exports: {
		name: "Dead Exports",
		description: "Detects exports with no importers in the project",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	hallucinated_imports: {
		name: "Hallucinated Imports",
		description: "Catches imports of symbols that don't exist in the target module",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	cross_package_imports: {
		name: "Cross-Package Imports",
		description: "Warns on imports that cross monorepo package boundaries incorrectly",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	undefined_env_vars: {
		name: "Undefined Env Vars",
		description: "Flags process.env references not documented in .env.example",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	sibling_awareness: {
		name: "Sibling Awareness",
		description: "Suggests related files that may need updates when editing a module",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	stale_read_warning: {
		name: "Stale Read Warning",
		description:
			"Warns when reading a file that was modified earlier in the session but not re-read",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "pure_read",
	},
	recently_failed: {
		name: "Recently Failed",
		description: "Warns when editing a file that had check failures earlier in the session",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	redundant_reread: {
		name: "Redundant Re-read",
		description: "Detects reading a file that was already read and hasn't changed",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "pure_read",
	},
	route_context: {
		name: "Route Context",
		description: "Adds HTTP route/endpoint context when editing handler files",
		tier: 1,
		determinism: "heuristic",
	},
	completion_tracking: {
		name: "Completion Tracking",
		description: "Tracks pending follow-up edits from export surface changes",
		tier: 1,
		determinism: "heuristic",
	},

	// Tier 2: sub-1s, every edit
	import_cycles: {
		name: "Import Cycles",
		description: "Detects circular import chains that can cause runtime issues",
		tier: 2,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	interface_change_impact: {
		name: "Interface Change Impact",
		description: "Identifies files affected when an interface or type definition changes",
		tier: 2,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	test_proximity: {
		name: "Test Proximity",
		description: "Suggests running related tests when editing source files",
		tier: 2,
		determinism: "partially_deterministic",
	},
	blast_radius: {
		name: "Blast Radius",
		description: "Estimates how many files are affected by changes to a hub module",
		tier: 2,
		determinism: "heuristic",
		externality: "local_write",
	},
	layer_violations: {
		name: "Layer Violations",
		description:
			"Enforces architectural layering rules (e.g., UI must not import from DB layer)",
		tier: 2,
		determinism: "fully_deterministic",
		externality: "local_write",
	},

	// Tier 3: conditional
	smart_tsc: {
		name: "Smart TypeScript Check",
		description:
			"Runs tsc only on the edited file when export surface didn't change (avoids full project rebuild)",
		tier: 3,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	impact_analysis: {
		name: "Impact Analysis",
		description:
			"Full dependency graph analysis showing breaking changes and affected downstream files",
		tier: 3,
		determinism: "heuristic",
		externality: "local_write",
	},
	test_first: {
		name: "Test First",
		description: "Nudge agent to write/run tests before editing source files",
		tier: 2,
		determinism: "heuristic",
	},
	cross_file_switch_discriminant: {
		name: "Cross-File Switch Discriminant",
		description:
			"Flags the same switch discriminant (.kind/.type/.tag) appearing in multiple files — usually a polymorphism opportunity",
		tier: 2,
		determinism: "heuristic",
	},
	single_implementation_interface: {
		name: "Single-Implementation Interface",
		description:
			"Flags exported interfaces with exactly one implementor — possible premature abstraction",
		tier: 2,
		determinism: "heuristic",
	},
};
