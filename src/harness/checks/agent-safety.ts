// Agent Safety Checks — Async, Imports, Types, Security, Correctness.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from generic-checks.ts.
//
// This module is now a thin barrel. The detector implementations live in
// family-grouped sibling modules so each file stays under the per-file line
// ceiling. The public API (re-exported below) is unchanged — existing
// importers (the check registry, generic-checks.ts barrel, tests) keep
// working without modification.
//   - agent-safety-async.ts          — async / promise safety
//   - agent-safety-deps.ts           — import hygiene / dependency safety
//   - agent-safety-js-correctness.ts — JS/TS type-safety, security, correctness
//   - agent-safety-crypto.ts         — cross-language crypto / TLS / fs safety

// --- 1. Async/Promise Safety ---
export {
	checkAsyncPromiseExecutor,
	checkFloatingPromises,
	checkMisusedPromises,
	checkSilentPromiseSwallow,
} from "./agent-safety-async.js";
// --- 4. Cross-language crypto / TLS / filesystem safety ---
export {
	checkAesEcbMode,
	checkRecursiveWalkerLstat,
	checkTlsVerifyDisabled,
	checkWeakHash,
	checkWeakRandom,
} from "./agent-safety-crypto.js";
// --- 2. Import Hygiene / Dependency Safety ---
export {
	checkExtraneousDependencies,
	checkPhantomDependencies,
	checkSelfImport,
	findWorkspaceRootFor,
} from "./agent-safety-deps.js";
// --- 3. Type Safety / Security / Correctness ---
export {
	checkBroadObjectTypes,
	checkConstantCondition,
	checkEvalUsage,
	checkInnerHtmlUsage,
	checkJsLooseEquality,
	checkMagicLiteralInConditional,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkUnsafeOptionalChaining,
} from "./agent-safety-js-correctness.js";
