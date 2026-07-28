import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("split-taste script file exists", () => {
	const p = resolve(process.cwd(), "scripts/split-taste.mjs");
	expect(existsSync(p)).toBe(true);
});
