#!/usr/bin/env node
// Split agent-safety.ts (1361 lines) into two files at the section-6 boundary.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHECKS_DIR = resolve(process.cwd(), "src/harness/checks");
const SRC = `${CHECKS_DIR}/agent-safety.ts`;
const lines = readFileSync(SRC, "utf-8").split("\n");

// Find the split marker
const splitIdx = lines.findIndex((l) => l.trim() === "// --- 6. Additional correctness/style ---");
if (splitIdx === -1) throw new Error("Split marker not found");

// Part 1: lines 0 .. splitIdx-1 (up to but not including section 6)
// Keep the existing imports; they're used by both halves.
const part1Lines = lines.slice(0, splitIdx);
const part1 = part1Lines.join("\n") + "\n";

// Part 2 (agent-safety-advanced.ts): lines splitIdx .. end
// Needs its own imports header.
const newHeader = `// Agent-safety checks — "Additional correctness / style" (part 2 of 2).
// Extracted from agent-safety.ts to stay under the 800-line module ceiling.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseExports, parseImports, resolveImportPath } from "../project-graph.js";
import { getGitSourceFiles } from "./export-ripple.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";
`;

const part2Body = lines.slice(splitIdx).join("\n");
const part2 = newHeader + "\n" + part2Body + "\n";

writeFileSync(`${CHECKS_DIR}/agent-safety.ts`, part1);
writeFileSync(`${CHECKS_DIR}/agent-safety-advanced.ts`, part2);

console.log(
	`agent-safety.ts: ${part1.split("\n").length} lines, agent-safety-advanced.ts: ${part2.split("\n").length} lines`,
);
