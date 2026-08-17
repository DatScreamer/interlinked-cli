// Metadata fragment: type-discipline wave (2026-08-14) — two detectors
// ported from dmmulroy/anti-slop (MIT), detection algorithm only. See
// docs/external-pulse/anti-slop.md. Composed into GENERIC_CHECK_META in
// ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_TYPE_DISCIPLINE_META: Record<string, CheckMeta> = {
	conditional_empty_object_spread: {
		name: "Conditional Empty-Object Spread",
		description:
			"Detects an object-literal spread whose argument is a ternary with an empty object {} on one branch — { ...(cond ? {} : { field: v }) } — used to conditionally omit a field. Exempts the idiomatic guarded-passthrough shape <guard> ? { key: expr } : {} whose property value textually matches the guard",
		tier: 1,
		determinism: "heuristic",
	},
	unknown_type_alias: {
		name: "Unknown Type Alias",
		description:
			"Detects a named type alias whose resolved type (chased through same-file, non-generic alias references) is exactly unknown — e.g. type Foo = unknown;",
		tier: 1,
		determinism: "heuristic",
	},
};
