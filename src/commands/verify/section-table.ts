// ===========================================
// Declarative code-quality section table
// ===========================================
// Each entry maps a bucket inside `CodeQualityResults` to the human-readable
// label, noun, pass-label, and severity color used by `streaming-output.ts`.
//
// The table is split into per-group fragment files (composed below, in order):
//   1. coreSections          — error-severity red (JSON, imports, export
//                              ripple) + warning-severity yellow (size,
//                              typing, hygiene).
//   2. agentSafetySections   — agent-safety checks (mix of red + yellow),
//                              Mythos drift detectors, taste / structural.
//   3. ubsSections           — UBS Plan 04 rows + D.1 backlog + D.2 parity.
//   4. batchSections         — Batch 1/2/5/8 packs, tsconfig strictness,
//                              endpoint-security pack.
//
// Order must mirror the legacy inline call sequence — `streaming-output.ts`
// and the verify skip-id pipeline both depend on it.

import { agentSafetySections } from "./section-table-agent-safety.js";
import { batchSections } from "./section-table-batches.js";
import { coreSections } from "./section-table-core.js";
import type { SectionSpec } from "./section-table-types.js";
import { ubsSections } from "./section-table-ubs.js";

export type { SectionSpec } from "./section-table-types.js";

/** Public API — consumed by `streaming-output.ts`. */
export const SECTIONS: readonly SectionSpec[] = [
	...coreSections,
	...agentSafetySections,
	...ubsSections,
	...batchSections,
];
