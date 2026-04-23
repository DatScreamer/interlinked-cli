import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

test("build-named-barrel script file exists", () => {
	const p = resolve(process.cwd(), "scripts/build-named-barrel.mjs");
	expect(existsSync(p)).toBe(true);
});
