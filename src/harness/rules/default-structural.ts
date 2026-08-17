// ===========================================
// Rules — default structural-check catalog (pure data leaf)
// ===========================================
// Extracted from default-config.ts (2026-08-17) so browser-bundled surfaces —
// the onboarding demo bundles setup-wizard.ts, which derives its dead-code
// scoping overlay from this catalog — can import the check list without
// pulling in the Node-only resolver graph (node:url / sidecar paths) that
// default-config.ts needs. Keep this module a pure data leaf: a value import
// of anything breaks the demo's esbuild bundle (pinned by the companion test).

import type { StructuralChecksConfig } from "../types.js";

/** The shipped structural-check defaults. `default-config.ts` re-exports this
 *  object BY REFERENCE (pinned) — edit values here only. */
export const DEFAULT_STRUCTURAL_CHECKS: StructuralChecksConfig = {
	// Off by default: dependency-graph scans add latency and warning volume that
	// many repos don't want by default. Re-enable per repo via
	// .interlinked/guard-rules.local.json once you've sized the project graph cost.
	enabled: false,
	export_surface: true,
	import_resolution: true,
	duplicate_symbols: true,
	co_dependency_staleness: true,
	import_cycles: true,
	new_import_cycle: true,
	interface_change_impact: true,
	test_proximity: true,
	smart_tsc: true,
	blast_radius: true,
	stale_read_warning: true,
	sibling_awareness: true,
	staleness_window_s: 300,
	blast_radius_threshold: 5,
	recently_failed: true,
	completion_tracking: true,
	route_context: true,
	redundant_reread: true,
	dead_imports: true,
	dead_code_action: "flag",
	completion_reminder_threshold: 10,
	dead_exports: true,
	hallucinated_imports: true,
	cross_package_imports: true,
	undefined_env_vars: true,
	layer_violations: false,
	impact_analysis: true,
	impact_high_threshold: 4,
	test_first: true,
	// Default hardened 2026-04-24: the TDD commit gate blocks `git commit`
	// when a source edit has no matching test-file change or the cycle is
	// stuck in red/regression. Flip to "warn" in `.interlinked/guard-rules.local.json`
	// for one-off escapes; use "nudge" to downgrade to info-only.
	test_first_mode: "enforce",
	// Warn by default: blocking every legacy-file edit on day one would
	// brick brownfield adoption; strict mode promotes this to "block".
	characterize_mode: "warn",
	cross_file_switch_discriminant: true,
	single_implementation_interface: true,
};
