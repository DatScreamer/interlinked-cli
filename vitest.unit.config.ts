import { configDefaults, defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Unit lane — everything EXCEPT the integration lane (`*.integration.test.ts`,
// the subprocess-spawning / Linux-sensitive suite). These are the fast,
// OS-independent tests: regex, parsing, data transforms, pure check logic.
//
// CI runs this as its own job on every push for quick feedback and as the
// clean-checkout backstop; it sits well under the job timeout. The full suite
// (unit + integration) still runs via `npm test` (pre-push + local).
//
// Inherits every base setting (timeouts, retry, env, CI worker cap, coverage);
// only `exclude` is extended. The base default export is a plain config object,
// so spreading its `.test` and overriding one key avoids mergeConfig's
// array-concatenation (which would otherwise keep the integration files in).
const base = baseConfig as { test?: Record<string, unknown> };
export default defineConfig({
	...baseConfig,
	test: {
		...(base.test ?? {}),
		exclude: [
			...configDefaults.exclude,
			"**/*.integration.test.ts",
			// TEMP: recurrence.test.ts hangs at collection on the Linux CI runner
			// (deterministic; passes at CI=1 on macOS). Excluded to test whether
			// the hang is file-specific (unit goes green) or resource accumulation
			// from earlier tool-spawning unit files (hang moves to the next file).
			// It still runs in the pre-push gate. Revert once root-caused.
			"**/__tests__/recurrence.test.ts",
		],
		// Diagnostic: [FILE-START]/[FILE-END] markers pinpoint the Linux-only
		// unit-lane hang (a leaked node grandchild) from the CI log — the last
		// started-not-ended file is the culprit. Remove once fixed.
		reporters: ["default", "./vitest-file-start-reporter.mjs"],
	},
});
