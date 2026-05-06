// Parity test for the two suggestion-check registries.
//
// We carry two arrays of `{ check, source, fn }` entries:
//   - src/harness/server/suggestion-checks.ts (35+ entries, runs every
//     PostToolUse on edited files)
//   - src/commands/verify/suggestions.ts      (9+ entries, opt-in via
//     `interlinked verify --suggestions` for offline scans)
//
// The harness registry is intentionally a superset — many heuristic checks
// are too noisy to run offline. But when a check is meant to fire in BOTH
// pipelines, drift is silent: the hook surfaces it during the edit, then
// `verify --suggestions` says "all clean" because the registry never got
// updated. This test pins the curated subset that must be in both.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const HARNESS_FILE = join(ROOT, "src/harness/server/suggestion-checks.ts");
const VERIFY_FILE = join(ROOT, "src/commands/verify/suggestions.ts");

function checkIds(file: string): Set<string> {
	const src = readFileSync(file, "utf-8");
	const ids = new Set<string>();
	const re = /\bcheck:\s*"([a-z0-9-]+)"/g;
	let m: RegExpExecArray | null;
	while (true) {
		m = re.exec(src);
		if (m === null) break;
		ids.add(m[1]);
	}
	return ids;
}

// Checks that MUST appear in both registries. Adding a check here is the
// explicit signal that it's worth running offline; CI then enforces.
// New entries land here whenever a suggestion-check is added that should
// be visible during `verify --suggestions`, not just during edits.
const PARITY_REQUIRED: readonly string[] = [
	"sql-injection",
	"perf-query-in-loop",
	"perf-await-in-loop",
	"silent-catch",
	// `silent-promise-swallow` was promoted to the default-warning
	// CHECK_REGISTRY pipeline (entries-warnings.ts → silent_promise_catch),
	// removing it from both suggestion registries — so it intentionally is
	// no longer parity-required here.
	"recursive-walker-lstat",
	"unreachable-code",
	"mixed-error-strategy",
] as const;

describe("suggestion-registry parity", () => {
	it("every check in verify's registry exists in the harness registry", () => {
		// Forward direction: verify can never carry a check the harness
		// doesn't. If you added something to verify, it must also fire on
		// every PostToolUse edit.
		const harness = checkIds(HARNESS_FILE);
		const verify = checkIds(VERIFY_FILE);
		const orphans = [...verify].filter((id) => !harness.has(id));
		expect(orphans).toEqual([]);
	});

	it("every parity-required check is present in BOTH registries", () => {
		const harness = checkIds(HARNESS_FILE);
		const verify = checkIds(VERIFY_FILE);
		const missingFromHarness = PARITY_REQUIRED.filter((id) => !harness.has(id));
		const missingFromVerify = PARITY_REQUIRED.filter((id) => !verify.has(id));
		expect(missingFromHarness).toEqual([]);
		expect(missingFromVerify).toEqual([]);
	});
});
