// interlinked-tdd: exempt — scoped vitest config for mutation runs (Stryker).
// Restricts the suite to the mutation target's companion tests so the dry run +
// per-mutant runs stay in seconds (the full 800-file suite would blow the
// per-edit budget). Today's scope: the mutation module itself (dogfood target).
// The #15 generalization derives this per-target from the dependency view.
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/harness/mutation/*.test.ts"],
	},
});
