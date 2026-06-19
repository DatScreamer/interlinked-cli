// Metadata fragment: Batch 2 test-hygiene checks — duplicate names, real I/O,
// nondeterminism, SUT-import / SUT-mock smells, and weak-assertion shapes.
// Composed into GENERIC_CHECK_META in ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_TEST_HYGIENE_META: Record<string, CheckMeta> = {
	// ========================================================================
	// Batch 2: test-hygiene (6 entries)
	// ========================================================================
	duplicate_test_names: {
		name: "Duplicate Test Names",
		description:
			"Detects two it() / test() / specify() blocks with identical name strings within the same file.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	real_io_in_tests: {
		name: "Real Network / Filesystem in Tests",
		description:
			"Detects fetch / axios / http calls to non-loopback URLs or *Sync writes to non-tmp paths inside test files.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	test_nondeterminism: {
		name: "Test Nondeterminism",
		description:
			"Detects Date.now / Math.random / crypto.randomUUID in test bodies without fake-timers / clock mocking.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	hardcoded_timeout_in_tests: {
		name: "Hardcoded Timeout in Tests",
		description:
			"Detects setTimeout / setImmediate with literal millisecond delays inside test bodies.",
		tier: 2,
		determinism: "fully_deterministic",
	},
	test_missing_sut_import: {
		name: "Test Missing SUT Import",
		description:
			"Detects test files that don't import their SUT (foo.test.ts without `./foo` / `../foo`).",
		tier: 1,
		determinism: "partially_deterministic",
	},
	mocking_the_sut_self: {
		name: "Mocking the SUT in Its Own Test",
		description:
			"Detects vi.mock / jest.mock targeting the file under test from inside its own test.",
		tier: 1,
		determinism: "fully_deterministic",
	},
	test_subprocess_default_timeout: {
		name: "Test Spawns Slow Subprocess Without Timeout",
		description:
			"Detects it() / test() callbacks that spawn a known-slow subprocess (tsc, biome, npx, tsx, eslint, vitest, the project CLI) via node:child_process exec/spawn primitives with no explicit `{ timeout: N }` options object or trailing numeric-timeout argument.",
		tier: 2,
		determinism: "heuristic",
	},
	mock_only_test: {
		name: "Mock-Only Test",
		description:
			"Detects it() / test() blocks whose every assertion is a call-interaction matcher (toHaveBeenCalled* / toHaveReturned*) with no value, output, or state assertion.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	happy_path_only_test: {
		name: "Happy-Path-Only Test File",
		description:
			"Detects test files with 3+ cases that never assert a failure path (no .not.*, toThrow, .rejects, falsy assertion, or failure-named case).",
		tier: 2,
		determinism: "heuristic",
	},
	test_platform_conditional: {
		name: "Platform-Conditional Test Assertion",
		description:
			"A test comment narrates platform-variant behavior ('on platforms where…', 'macOS-only') while the NARRATED test never gates on it — evidence must be a PLATFORM-conditioned skipIf/runIf (process.platform, a platform-derived constant, or a platform-named flag) on that test or an enclosing suite, a platform branch in its body, or an unconditional .skip/.todo; a dependency gate like skipIf(!dockerAvailable), a gate on an unrelated sibling, or a mention in a comment/string is not evidence.",
		tier: 3,
		determinism: "heuristic",
	},
	test_silent_dependency_skip: {
		name: "Silent Dependency Skip",
		description:
			"`if (!X_AVAILABLE) return;` inside a test callback — bare, braced (`{ return; }`), or multi-line — records a PASS wherever the external dependency is missing; CI reports green while running nothing. Guards in helpers/lifecycle hooks are exempt. Use it.skipIf so the skip is reported.",
		tier: 1,
		determinism: "fully_deterministic",
	},
};
