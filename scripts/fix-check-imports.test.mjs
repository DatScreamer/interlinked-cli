// Smoke test for the one-shot fix-check-imports.mjs script.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("fix-check-imports script file exists", () => {
	const p = resolve(process.cwd(), "scripts/fix-check-imports.mjs");
	expect(existsSync(p)).toBe(true);
});
