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
			// recurrence.test.ts hangs at COLLECTION (import/register phase, before
			// any test runs) on the ubuntu CI runner — deterministic, confirmed
			// file-specific (excluding it makes the lane complete; the hang does
			// not move to another file), yet it passes at CI=1 on macOS. Root
			// cause is still open (imports are pure; describe bodies are trivial),
			// so it is quarantined here and still runs in the pre-push gate (which
			// executes the full suite on macOS). See docs/design/ci-lane-split.md.
			// TODO(recurrence-ci-hang): root-cause the Linux collection hang.
			"**/__tests__/recurrence.test.ts",
		],
	},
});
