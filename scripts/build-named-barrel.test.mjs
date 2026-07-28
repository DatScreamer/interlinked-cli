import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("build-named-barrel script file exists", () => {
	const p = resolve(process.cwd(), "scripts/build-named-barrel.mjs");
	expect(existsSync(p)).toBe(true);
});
