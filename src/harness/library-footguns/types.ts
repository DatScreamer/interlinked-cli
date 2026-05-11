// ============================================================
// Library footgun registry — types
// ============================================================
// Adapted from Mythos's curl analysis (daniel.haxx.se, 2026-05-11):
// detecting third-party API misuse "through contextual library
// knowledge." Mythos succeeded because it has broad training data.
// Our deterministic equivalent: an explicit per-library footgun
// registry. Each library ships a small set of regex/AST shape
// checks that fire when its known anti-patterns appear in the code.
//
// Per-library opt-out lives in `.interlinked/disabled-libraries.json`:
//   { "version": 1, "disabled": ["redis", "node-fetch"] }
// A whole library can be silenced without code edits.
//
// Per feedback_harness_deterministic_only: every check is a pure
// regex+context shape — no LLM in the path.

import type { InlineMatch } from "../checks/shared.js";

/** A single footgun check belonging to a specific library. */
export interface LibraryFootgunCheck {
	/** Harness check id (e.g. "node_fetch_no_timeout"). */
	id: string;
	/** Display name shown to the agent. */
	name: string;
	/** Library family — used for the disabled-libraries opt-out. */
	library: string;
	/** Per-file detector. Should be FAST (<1ms typical) and never throw. */
	detect: (content: string, filePath: string) => InlineMatch[];
	/** Cold-reader fix instruction — concrete, copy-pasteable when possible. */
	fixInstruction: string;
}

/** Disabled-libraries config file shape. */
export interface DisabledLibrariesConfig {
	version: 1;
	/** Library names (matching `LibraryFootgunCheck.library`) to silence. */
	disabled: string[];
}
