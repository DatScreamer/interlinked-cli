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
	},
});
