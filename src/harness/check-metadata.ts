// ===========================================
// Check Metadata — structured data for documentation generation
// ===========================================
// Single source of truth for check names, descriptions, determinism, and tiers.
// Used by the doc generator to produce reference documentation.
// If a check exists but isn't documented here, the freshness test will fail.
//
// POLICY: Every new blocking check (determinism = "fully_deterministic") MUST have:
//   1. determinism explicitly classified
//   2. A fixture test if fully_deterministic (positive + negative case)
//   3. An oracle (expected output) checked into the test
//
// Implementation: the actual metadata constants live in ./check-metadata/*.
// This file re-exports them so callers continue to work without path changes.

export { BEHAVIORAL_CHECK_META } from "./check-metadata/behavioral.js";
export { GENERIC_CHECK_META } from "./check-metadata/generic.js";
export { QUALITY_CHECK_META } from "./check-metadata/quality.js";
export { STRUCTURAL_CHECK_META } from "./check-metadata/structural.js";
export { SUGGESTION_CHECK_META } from "./check-metadata/suggestion.js";
