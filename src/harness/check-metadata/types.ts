// Shared types for the check-metadata module. A light file of its own so
// each metadata constant file can import from here without re-importing
// Determinism directly from ../types.

import type { Determinism } from "../types.js";

/** Documentation metadata for a single registered check. */
export interface CheckMeta {
	name: string;
	description: string;
	tier: 1 | 2 | 3;
	determinism: Determinism;
}
