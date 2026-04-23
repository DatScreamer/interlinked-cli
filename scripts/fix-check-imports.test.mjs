// Smoke test for the one-shot fix-check-imports.mjs script.
import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

test("fix-check-imports script file exists", () => {
	const p = resolve(process.cwd(), "scripts/fix-check-imports.mjs");
	expect(existsSync(p)).toBe(true);
});
