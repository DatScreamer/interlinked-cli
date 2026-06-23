// CommonJS constructs used in an ES module — runtime-fatal, silent until import.
//
// A file that is ESM (a top-level `import`/`export`, or a `.mjs`/`.mts`
// extension) cannot use CommonJS globals: `require(...)`, `module.exports`, and
// the `__dirname`/`__filename` magic variables are all UNDEFINED under ESM and
// throw the moment the file is imported ("require is not defined in ES module
// scope"). This is a silent class — it type-checks and lints clean, then dies at
// runtime. It motivated this check directly: captured agent reasoning shows a
// vitest test file with `import { it } from "vitest"` that also did
// `const { readFileSync } = require("node:fs")` — "that won't work since the
// project uses ES modules."
//
// Zero-FP design (verified against this repo's own `require(`-bearing files):
//   - Only fires on a file PROVEN ESM (import/export present, or .mjs/.mts).
//   - TEST FILES ARE EXEMPT: a test runner (vitest/jest) injects `require`,
//     `__dirname`, and `__filename` into test-module scope, so CJS globals are
//     legitimately available there. (Dogfood proof: 11 test files in this repo
//     use them and the suite passes — flagging them would be a false positive.)
//   - `stripCommentsAndStrings` masks `require(` inside comments, string
//     literals, and (multi-line) template literals — so a detector that merely
//     searches for the text "require(" never trips it.
//   - Regex literals dodge it naturally: a regex escapes the paren (`/require\(/`)
//     and the dot (`module\.exports`), so the unescaped-`(`/`.` patterns miss.
//   - `createRequire` users (the sanctioned ESM dynamic-require escape hatch) and
//     `@codegen-data` carriers (hook-template strings) are skipped wholesale.
//   - `__dirname`/`__filename` are skipped when the file uses `import.meta` — the
//     deliberate `import.meta.dirname ?? __dirname` dual-runtime pattern.

import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

const MAX_MATCHES = 10;

/** A top-level ESM marker: an `import`/`export` statement at line start. */
const ESM_ANCHOR_RE = /^\s*(?:import|export)\b/m;
const ESM_ONLY_EXTS = new Set([".mjs", ".mts"]);

/**
 * Flag CommonJS constructs (`require(...)`, `module.exports`, `__dirname`,
 * `__filename`) in a file that is an ES module. Returns one InlineMatch per
 * offending line (capped). Empty for non-ESM files, non-JS/TS files, test files
 * (the runner provides CJS globals), and the sanctioned escape hatches noted in
 * the file header.
 */
export function detectCjsInEsm(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext)) return [];
	// Test runners inject require/__dirname/__filename into module scope — CJS
	// globals are legitimately available in tests, so never flag them there.
	if (isStrictTestFile(filePath)) return [];
	const isEsm = ESM_ONLY_EXTS.has(ext) || ESM_ANCHOR_RE.test(content);
	if (!isEsm) return [];
	if (content.includes("@codegen-data") || content.includes("createRequire")) return [];

	const original = content.split("\n");
	const stripped = stripCommentsAndStrings(content).split("\n");

	// `require(` and `module.exports` are unconditionally CJS-only. `__dirname` /
	// `__filename` are too, but the `import.meta.dirname ?? __dirname` dual pattern
	// is deliberate — drop those two when the file already uses `import.meta`.
	const re = content.includes("import.meta")
		? /\brequire\s*\(|\bmodule\s*\.\s*exports\b/
		: /\brequire\s*\(|\bmodule\s*\.\s*exports\b|\b__dirname\b|\b__filename\b/;
	return scanLinesStripped(original, stripped, re, MAX_MATCHES);
}
