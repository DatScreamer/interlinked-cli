// interlinked-tdd: exempt — scoped vitest config for mutation runs (Stryker).
// Restricts the suite to the mutation target's companion tests so the dry run +
// per-mutant runs stay in seconds (the full 800-file suite would blow the
// per-edit budget).
//
// The scope is supplied PER RUN through INTERLINKED_MUTATION_TESTS (a
// comma-separated glob list) because the right tests depend on which file is
// being mutated. It was previously hardcoded to the mutation module, which had a
// silent and expensive consequence: every edit ANYWHERE ELSE in the repo ran
// zero tests, and Stryker's "No tests were executed" surfaced to the agent as a
// generic "the mutation runner failed" — so the gate looked broken rather than
// mis-scoped.
//
// The fallback keeps a standalone `stryker run` working without the env var.
//
// CORRECTNESS SETTINGS BELOW (env/setupFiles/timeouts) were missing until this
// widened import-graph test scoping (test-scope.ts) started forwarding real,
// previously-never-scoped test files instead of just one hand-picked
// companion. Measured live 2026-08-01: a graph-selected 60-test scope for
// `session-state.ts` failed Stryker's dry run with "There were failed tests
// in the initial test run" — several of the selected tests (evaluator/
// rules-loader tests among them) assume the isolation `vitest.config.ts` sets
// up globally (`INTERLINKED_SKIP_DISTILLED_RULES=1`, notably) and read the
// wrong ambient state without it. A one-file scope never happened to include
// one of those, so the gap was invisible until the scope widened — this file
// mirrors the CORRECTNESS-relevant settings from `vitest.config.ts` (not its
// coverage instrumentation, which Stryker has no use for and which only costs
// time here).
//
// DELIBERATELY NOT copying `retry: 1`: Stryker's own dry run under
// `coverageAnalysis: perTest` (stryker.conf.json) needs a stable 1:1
// test-to-coverage mapping to build its per-mutant test map. A retried test —
// even one that passes on the retry, which plain `vitest run` reports as a
// clean pass — still recorded an initial FAILED attempt, and Stryker's dry-run
// validator appears to key off of "did any attempt fail" rather than the
// vitest-level final verdict (measured live: the full 60-file/1804-test scope
// passes 100% under vitest's own Node API directly, but the identical scope
// fails Stryker's dry run with the generic ConfigError). Importing `retry`
// here would only reintroduce that failure mode at a wider scope than the
// original bug — the mutation dry run needs zero-tolerance for a first-attempt
// failure, not the CI-style flake tolerance `vitest.config.ts` opts into.
import { defineConfig } from "vitest/config";

const DEFAULT_SCOPE = ["src/harness/mutation/*.test.ts"];

function scopeFromEnv(): string[] {
	const raw = process.env.INTERLINKED_MUTATION_TESTS;
	if (!raw) return DEFAULT_SCOPE;
	const globs = raw
		.split(",")
		.map((g) => g.trim())
		.filter((g) => g.length > 0);
	// An env var that parses to nothing would otherwise select the whole repo,
	// which is the slow failure this config exists to prevent.
	return globs.length > 0 ? globs : DEFAULT_SCOPE;
}

export default defineConfig({
	test: {
		include: scopeFromEnv(),
		setupFiles: ["./src/test-setup/property-budget.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		env: {
			INTERLINKED_SKIP_DISTILLED_RULES: "1",
		},
	},
});
