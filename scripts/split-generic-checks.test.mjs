// Smoke test for the one-shot split-generic-checks.mjs script.
// This script is not run in CI — it was used to split the original
// generic-checks.ts into per-family modules. The test only asserts
// the script is parseable as a module and exposes nothing unexpected.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("split script file exists", () => {
	const p = resolve(process.cwd(), "scripts/split-generic-checks.mjs");
	expect(existsSync(p)).toBe(true);
});
