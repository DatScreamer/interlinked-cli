// ===========================================
// Check Registry — legacy flat-file mirror
// ===========================================
// The authoritative declarative check registry lives at ./check-registry/.
// This file exists as a compatibility shim: callers that used to import
// `{ CHECK_REGISTRY, buildAgentSafetyChecks, ... }` directly from
// "./check-registry.js" continue to work without changes.
//
// New code should import from "./check-registry/index.js" instead.
// The folder-based split keeps each entry file under the ~800-line ceiling.

export type { CheckPhase, CheckRegistration, InlineMatch } from "./check-registry/index.js";
export {
	buildAgentSafetyChecks,
	buildCheckInstructions,
	buildGenericCheckMeta,
	CHECK_REGISTRY,
} from "./check-registry/index.js";
