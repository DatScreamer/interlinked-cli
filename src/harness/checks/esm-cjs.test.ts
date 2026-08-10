import { describe, expect, it } from "vitest";
import { detectCjsInEsm } from "./esm-cjs.js";

const F = "/repo/src/x.ts";

describe("detectCjsInEsm — CommonJS used in an ES module", () => {
	// ── positives: must fire ──────────────────────────────────────────────────
	it("P1: flags require() in a file that also imports (the vitest case)", () => {
		const src = `import { it } from "vitest";
const { readFileSync } = require("node:fs");
`;
		const m = detectCjsInEsm(src, F);
		expect(m.length).toBe(1);
		expect(m[0]?.line).toBe(2);
	});

	it("P2: flags module.exports in an ESM file", () => {
		const src = `import { x } from "./x.js";
module.exports = { x };
`;
		expect(detectCjsInEsm(src, F).length).toBe(1);
	});

	it("P3: flags require() in a .mjs file even with no import", () => {
		expect(detectCjsInEsm(`const cfg = require("./config.json");\n`, "/repo/build.mjs").length).toBe(1);
	});

	it("P4: flags bare __dirname in an ESM file with no import.meta", () => {
		const src = `export const x = 1;
const here = __dirname;
`;
		expect(detectCjsInEsm(src, F).length).toBe(1);
	});

	// ── negatives: must NOT fire ──────────────────────────────────────────────
	it("N1: does NOT flag a pure CJS file (no import/export anchor)", () => {
		const src = `const fs = require("node:fs");
module.exports = { fs };
`;
		expect(detectCjsInEsm(src, F)).toEqual([]);
	});

	it("N2: does NOT flag test files — the runner injects require/__dirname", () => {
		const src = `import { it } from "vitest";
const fs = require("node:fs");
const dir = __dirname;
`;
		expect(detectCjsInEsm(src, "/repo/src/foo.test.ts")).toEqual([]);
		expect(detectCjsInEsm(src, "/repo/src/__tests__/foo.ts")).toEqual([]);
	});

	it("N3: does NOT flag require( inside comments or string literals", () => {
		const src = `import { x } from "./x.js";
// use require() only in CJS files
const key = "require(";
if (line.includes("require(")) return;
`;
		expect(detectCjsInEsm(src, F)).toEqual([]);
	});

	it("N4: does NOT flag __dirname under the import.meta.dirname dual pattern", () => {
		const src = `import { join } from "node:path";
const dir = import.meta.dirname || __dirname;
`;
		expect(detectCjsInEsm(src, F)).toEqual([]);
	});

	it("N5: does NOT flag a file using createRequire (sanctioned ESM escape hatch)", () => {
		const src = `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const y = require("./y.cjs");
`;
		expect(detectCjsInEsm(src, F)).toEqual([]);
	});

	it("N6: does NOT flag @codegen-data hook-template carriers", () => {
		const src = `// @codegen-data
export const HOOK = "const p = require('node:path');";
`;
		expect(detectCjsInEsm(src, F)).toEqual([]);
	});

	it("N7: does NOT flag non-JS/TS files", () => {
		expect(detectCjsInEsm(`require("x")`, "/repo/README.md")).toEqual([]);
	});
});
