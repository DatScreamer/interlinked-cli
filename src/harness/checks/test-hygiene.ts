// Test-file hygiene checks (Batch 2) — public barrel.
//
// The detectors fire only on test files and each catches a distinct
// test-suite-gaming or test-isolation failure mode common in LLM-authored test
// code. All are <1ms regex-based. The implementations live in two cohesive
// family modules; this barrel re-exports the full public surface so the check
// registry (`generic-checks.ts`) and every other importer stay unchanged.
//
// - test-hygiene-isolation.ts — "tests must be deterministic & isolated":
//     real-IO / nondeterminism / hardcoded-timeout / subprocess-default-timeout
// - test-hygiene-quality.ts   — "the test is weak":
//     duplicate-names / missing-SUT-import / mocking-the-SUT-self / mock-only /
//     happy-path-only (+ the hasAnyProjectSourceImport helper)
// - test-hygiene-shared.ts    — internal primitives shared by both families
//     (the it()/test() call-opening regex + balanced call-span scanner)

export {
	checkHardcodedTimeoutInTests,
	checkRealIoInTests,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
} from "./test-hygiene-isolation.js";
export {
	checkDuplicateTestNames,
	checkHappyPathOnlyTest,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkTestMissingSutImport,
	hasAnyProjectSourceImport,
} from "./test-hygiene-quality.js";
export { checkTestLegitimacy } from "./test-legitimacy.js";
