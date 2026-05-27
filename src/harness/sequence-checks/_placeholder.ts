// interlinked-tdd: exempt — no-op detector. Companion smoke test pins the
// empty-array invariant; this file has no other testable surface.

import type { SequenceDetector } from "./types.js";

/**
 * No-op sequence detector. Always returns `[]`. Confirms registry + dispatch
 * plumbing without false-firing. Disabled by default. The registry imports
 * this so even a zero-detector-rollout build has a sentinel entry to walk.
 */
export const noopSequenceDetector: SequenceDetector = {
	id: "_noop_never_fires",
	description: "No-op detector — always returns no matches",
	family: "quality",
	phase: "stop",
	default_enabled: false,
	determinism: "fully_deterministic",
	fn: () => [],
};
