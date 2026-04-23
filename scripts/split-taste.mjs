#!/usr/bin/env node
// Split taste.ts into two files at the checkMagicNumbers boundary.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHECKS_DIR = resolve(process.cwd(), "src/harness/checks");
const SRC = `${CHECKS_DIR}/taste.ts`;
const lines = readFileSync(SRC, "utf-8").split("\n");

// Find the JSDoc opener right before checkMagicNumbers — that's the clean split boundary.
// The JSDoc starts a few lines before the `export function checkMagicNumbers` line.
let splitIdx = -1;
for (let i = 0; i < lines.length; i++) {
	if (lines[i].trim().startsWith("export function checkMagicNumbers")) {
		// Walk back to find the JSDoc opener
		for (let j = i - 1; j >= 0; j--) {
			if (lines[j].trim().startsWith("/**")) {
				splitIdx = j;
				break;
			}
		}
		break;
	}
}
if (splitIdx === -1) throw new Error("Split marker not found");

const part1 = lines.slice(0, splitIdx).join("\n") + "\n";
const newHeader = `// Taste checks — part 2 of 2 (magic numbers, ternaries, flag args, commented-out code).
// Extracted from taste.ts to stay under the 800-line module ceiling.

import {
	collectFunctionSignature,
	countTopLevelCommas,
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";
`;
const part2 = newHeader + "\n" + lines.slice(splitIdx).join("\n") + "\n";

writeFileSync(`${CHECKS_DIR}/taste.ts`, part1);
writeFileSync(`${CHECKS_DIR}/taste-smell.ts`, part2);

console.log(
	`taste.ts: ${part1.split("\n").length} lines, taste-smell.ts: ${part2.split("\n").length} lines`,
);
