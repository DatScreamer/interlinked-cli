#!/usr/bin/env node
// One-shot repair: fix imports across the freshly-split check modules.
// Runs after split-generic-checks.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const d = resolve(process.cwd(), "src/harness/checks");

// Helper: surgical replace of the import block.
function patch(filename, find, replaceWith) {
	const p = `${d}/${filename}`;
	const raw = readFileSync(p, "utf8");
	if (!raw.includes(find)) {
		console.error(`skip ${filename}: marker not found`);
		return;
	}
	const out = raw.replace(find, replaceWith);
	writeFileSync(p, out);
	console.log(`patched ${filename}`);
}

// error-handling.ts, focused-tests.ts, js-ts-general.ts, pii.ts, placeholder-tests.ts, testing.ts, react.ts
// — need JS_TS_ALL_EXTS imported.
// sequential-awaits.ts — needs JS_TS_EXTS.
// Shared import shape:
const SHARED_BLOCK = `import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";`;

const SHARED_BLOCK_WITH_JS_TS_ALL = `import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	JS_TS_ALL_EXTS,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";`;

const SHARED_BLOCK_WITH_JS_TS_EXTS = `import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";`;

for (const fname of [
	"error-handling.ts",
	"focused-tests.ts",
	"js-ts-general.ts",
	"pii.ts",
	"placeholder-tests.ts",
	"testing.ts",
]) {
	patch(fname, SHARED_BLOCK, SHARED_BLOCK_WITH_JS_TS_ALL);
}

// sequential-awaits.ts needs JS_TS_EXTS
patch("sequential-awaits.ts", SHARED_BLOCK, SHARED_BLOCK_WITH_JS_TS_EXTS);

// react.ts — has local JS_TS_ALL_EXTS const that we should keep (so don't touch it).

// complexity.ts needs collectFunctionSignature + countTopLevelCommas from shared
// Its local definitions stay in place; we need to import the shared ones too for cross-file uses.
// Actually: complexity.ts DEFINES countTopLevelCommas locally — the TS error says it's missing.
// Looking at the file more carefully: complexity.ts has `checkComplexityBrace(lines, matches)`
// which calls countTopLevelCommas... that call site IS in the brace-helper at the bottom of the file.
// So countTopLevelCommas is defined AFTER it's used (function hoisting).
// Actually TypeScript complains because it's using a function named collectFunctionSignature
// that lives in return-types.ts. Fix: import it from shared.
{
	const p = `${d}/complexity.ts`;
	const raw = readFileSync(p, "utf8");
	const out = raw.replace(
		SHARED_BLOCK,
		`import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";`,
	);
	writeFileSync(p, out);
	console.log("patched complexity.ts");
}

// return-types.ts — had a local collectFunctionSignature. It now exists in shared too.
// Remove local, import from shared.
{
	const p = `${d}/return-types.ts`;
	let raw = readFileSync(p, "utf8");
	raw = raw.replace(
		SHARED_BLOCK,
		`import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";`,
	);
	// Remove the local definition (kept at bottom)
	raw = raw.replace(
		/\/\/ ===========================================\n\/\/ Helper\n\/\/ ===========================================[\s\S]*function collectFunctionSignature\(lines: string\[\], startIdx: number\): string \{[\s\S]*?\n\}\n/,
		"",
	);
	// Alternative: some files use "function collectFunctionSignature" without the section banner.
	raw = raw.replace(
		/function collectFunctionSignature\(lines: string\[\], startIdx: number\): string \{[\s\S]*?\n\}\n/,
		"",
	);
	writeFileSync(p, raw);
	console.log("patched return-types.ts");
}

// taste.ts — uses collectFunctionSignature + countTopLevelCommas + does NOT define them.
{
	const p = `${d}/taste.ts`;
	const raw = readFileSync(p, "utf8");
	const out = raw.replace(
		SHARED_BLOCK,
		`import {
	collectFunctionSignature,
	countTopLevelCommas,
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";`,
	);
	writeFileSync(p, out);
	console.log("patched taste.ts");
}

// export-ripple.ts — needs extractModuleExportNames, join, dirname
{
	const p = `${d}/export-ripple.ts`;
	let raw = readFileSync(p, "utf8");
	raw = raw.replace(
		"import { execFileSync } from \"node:child_process\";\nimport { readFileSync } from \"node:fs\";\nimport { isAbsolute, relative, resolve } from \"node:path\";\nimport { parseExports, parseImports, resolveImportPath } from \"../project-graph.js\";",
		`import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseExports, parseImports, resolveImportPath } from "../project-graph.js";
import { extractModuleExportNames } from "./swift.js";`,
	);
	writeFileSync(p, raw);
	console.log("patched export-ripple.ts");
}

// project-setup.ts — missing resolve, dirname
{
	const p = `${d}/project-setup.ts`;
	let raw = readFileSync(p, "utf8");
	raw = raw.replace(
		`import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";`,
		`import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";`,
	);
	writeFileSync(p, raw);
	console.log("patched project-setup.ts");
}

console.log("done.");
