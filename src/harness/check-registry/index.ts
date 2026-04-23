// Public surface of the check-registry module. Callers import from here.

export {
	buildAgentSafetyChecks,
	buildCheckInstructions,
	buildGenericCheckMeta,
} from "./builders.js";
export { CHECK_REGISTRY } from "./registry.js";
export type { CheckPhase, CheckRegistration, InlineMatch } from "./types.js";
