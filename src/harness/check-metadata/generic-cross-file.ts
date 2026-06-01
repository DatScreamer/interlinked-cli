// Metadata fragment: Batch 5 cross-file checks — handler/listener pairing,
// schema↔type drift, and migration up/down parity. Composed into
// GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_CROSS_FILE_META: Record<string, CheckMeta> = {
	// ========================================================================
	// Batch 5: cross-file (4 entries)
	// ========================================================================
	empty_body_handler: {
		name: "Empty-Body Handler",
		description:
			"Detects handler-named functions (handle*, route*, on[A-Z]*, HTTP verb-named) with empty / no-op bodies.",
		tier: 2,
		determinism: "heuristic",
	},
	listener_pairing: {
		name: "Listener Pairing",
		description:
			"Detects addEventListener / process.on / emitter.on without paired removeEventListener / off / removeListener.",
		tier: 2,
		determinism: "heuristic",
	},
	schema_type_drift: {
		name: "Schema ↔ Type Drift",
		description:
			"Detects same-file Zod schemas and TS interfaces with overlapping name root but divergent property sets.",
		tier: 2,
		determinism: "heuristic",
	},
	migration_parity: {
		name: "Migration Parity",
		description: "Detects `*_up.sql` files without a matching `*_down.sql` in the same dir.",
		tier: 1,
		determinism: "fully_deterministic",
	},
};
