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
			// recurrence.test.ts was quarantined here 2026-07 as "hangs at
			// collection on the ubuntu runner" — EXONERATED 2026-07-29: runs
			// 30410747800 / 30412876710 hung on two DIFFERENT innocent files at
			// the same ~600-file queue depth, and each "guilty" file passed once
			// its size-order position moved. The hang tracks queue POSITION (the
			// single-worker forks pool wedges the runner ~600 child-spawns in),
			// not file content — recurrence just happened to sit at the lethal
			// depth of that era's file-size distribution. Fixed by sharding the
			// CI unit lane (ci.yml matrix, separate vitest mains); the file is
			// back in the lane as a standing test of that diagnosis.
		],
	},
});
