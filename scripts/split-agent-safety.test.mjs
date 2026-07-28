import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("split-agent-safety script file exists", () => {
	const p = resolve(process.cwd(), "scripts/split-agent-safety.mjs");
	expect(existsSync(p)).toBe(true);
});
