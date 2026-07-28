#!/usr/bin/env node
// Script to split generic-checks.ts into smaller modules.
// Extracts line ranges from original file, writes to new files with appropriate imports.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src/harness/generic-checks.ts");
const DST_DIR = resolve(process.cwd(), "src/harness/checks");

mkdirSync(DST_DIR, { recursive: true });

const content = readFileSync(SRC, "utf8");
const lines = content.split("\n");

// lineRanges is 1-based, inclusive.
function extract(fromLine, toLine) {
	const start = fromLine - 1;
	const end = toLine;
	return lines.slice(start, end).join("\n");
}

// Shared helpers that all check modules need.
const SHARED_IMPORT_FROM_SHARED = `import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";
`;

// Definition of each module to extract.
const modules = [
	{
		file: "language-agnostic.ts",
		header: `// Language-agnostic checks: binary content, empty file, large file, console/debug.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[272, 381]],
	},
	{
		file: "b-series.ts",
		header: `// B-Series PostToolUse inline checks.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[383, 904]],
	},
	{
		file: "cross-language.ts",
		header: `// Cross-language checks (SQL injection).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[906, 951]],
	},
	{
		file: "agent-safety.ts",
		header: `// Agent Safety Checks — Async, Imports, Types, Security, Correctness.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from generic-checks.ts.\n\n`,
		imports: `import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseExports, parseImports, resolveImportPath } from "../project-graph.js";
${SHARED_IMPORT_FROM_SHARED}`,
		ranges: [[953, 2281]],
	},
	{
		file: "performance.ts",
		header: `// Performance anti-pattern checks (loop-body analysis, repeated work, etc).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[2282, 2951]],
	},
	{
		file: "swift.ts",
		header: `// Swift-specific checks (Apple API Design Guidelines + Memory Safety + Concurrency).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[2952, 3709]],
	},
	{
		file: "return-types.ts",
		header: `// Missing return type annotations check.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[3710, 3817]],
	},
	{
		file: "test-file-exists.ts",
		header: `// Test file existence check.
// Extracted from generic-checks.ts.\n\n`,
		imports: `import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
${SHARED_IMPORT_FROM_SHARED}`,
		ranges: [[3819, 3923]],
	},
	{
		file: "complexity.ts",
		header: `// Function complexity checks.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[3925, 4141]],
	},
	{
		file: "export-ripple.ts",
		header: `// Export ripple check (detects changes to frequently-imported modules).
// Extracted from generic-checks.ts.\n\n`,
		imports: `import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseExports, parseImports, resolveImportPath } from "../project-graph.js";
${SHARED_IMPORT_FROM_SHARED}`,
		ranges: [[4143, 4289]],
	},
	{
		file: "taste.ts",
		header: `// Taste checks — opinionated code quality (naming, complexity, design smells).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[4291, 5096]],
	},
	{
		file: "deletion-hygiene.ts",
		header: `// Deletion hygiene — zombie code detectors.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[5098, 5474]],
	},
	{
		file: "supply-chain.ts",
		header: `// Supply-chain / runtime safety checks.
// Extracted from generic-checks.ts.\n\n`,
		imports: `import { existsSync, readFileSync } from "node:fs";
${SHARED_IMPORT_FROM_SHARED}`,
		ranges: [[5476, 5846]],
	},
	{
		file: "project-setup.ts",
		header: `// Project setup validation checks.
// Extracted from generic-checks.ts.\n\n`,
		imports: `import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
${SHARED_IMPORT_FROM_SHARED}`,
		ranges: [[5848, 6025]],
	},
	{
		file: "react.ts",
		header: `// React / frontend checks.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6027, 6142]],
	},
	{
		file: "js-ts-general.ts",
		header: `// JS/TS general checks (nested ternaries, catch-and-log, JSON parsing, etc).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6144, 6400]],
	},
	{
		file: "testing.ts",
		header: `// Testing-specific checks (snapshot, test-importing-test, excessive useEffect).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6402, 6494]],
	},
	{
		file: "sequential-awaits.ts",
		header: `// Sequential independent awaits detection (JS/TS).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6496, 6545]],
	},
	{
		file: "index-as-key.ts",
		header: `// React index-as-key detection.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6547, 6594]],
	},
	{
		file: "missing-effect-cleanup.ts",
		header: `// Missing effect cleanup detection (React).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6596, 6661]],
	},
	{
		file: "over-mocking.ts",
		header: `// Over-mocking detection (testing smell).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6663, 6708]],
	},
	{
		file: "pii.ts",
		header: `// PII detection + mixed error strategy check.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6710, 6918]],
	},
	{
		file: "error-handling.ts",
		header: `// Error-handling taste checks (bare catch, untyped catch, throw-as-control-flow, etc).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[6920, 7145]],
	},
	{
		file: "c-cpp.ts",
		header: `// C/C++ checks (unsafe functions, include guards, sprintf, malloc checks).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[7147, 7324]],
	},
	{
		file: "focused-tests.ts",
		header: `// Focused tests check (committed .only / fdescribe / fit).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[7326, 7353]],
	},
	{
		file: "placeholder-tests.ts",
		header: `// Placeholder test detection (stub/pending/TODO-body test cases).
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[7355, 7519]],
	},
	{
		file: "compat-stubs.ts",
		header: `// Compatibility stubs — referenced by check-registry but their full
// implementations live in other modules (or are pending refactor).
// Returning an empty match list keeps the registry build green without
// changing the observable behaviour of the missing checks.
// Extracted from generic-checks.ts.\n\n`,
		imports: SHARED_IMPORT_FROM_SHARED,
		ranges: [[7521, 7538]],
	},
];

for (const mod of modules) {
	const body = mod.ranges.map(([from, to]) => extract(from, to)).join("\n\n");
	const out = mod.header + mod.imports + "\n" + body + "\n";
	const path = resolve(DST_DIR, mod.file);
	writeFileSync(path, out);
	console.log(`Wrote ${path} (${body.split("\n").length} lines)`);
}

console.log("\nDone writing split modules.");
