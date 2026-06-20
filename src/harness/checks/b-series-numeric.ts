// interlinked-tdd: exempt
// B-Series numeric-literal hazard checks (parseInt radix, float equality).
// Extracted from b-series.ts to keep that module under the line cap.

import {
	getExtension,
	type InlineMatch,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";
import { nonNull } from "../../lib/non-null.js";

/**
 * Detect parseInt() calls without the radix parameter.
 * `parseInt(x)` without second argument can produce unexpected results.
 */
export function checkParseIntRadix(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bparseInt\s*\(\s*[^,)]+\s*\)/, 10);
}

/**
 * Detect floating point equality comparisons.
 * `=== 0.1` or `!== 3.14` — floating point comparisons are unreliable.
 * Skips values exactly representable in IEEE 754 binary64 (e.g., 0.0, 0.5, 1.0).
 */
const SAFE_FLOAT_VALUES = new Set([
	"0.0",
	"0.5",
	"1.0",
	"1.5",
	"2.0",
	"3.0",
	"4.0",
	"5.0",
	"0.25",
	"0.75",
	"0.125",
	"0.375",
	"0.625",
	"0.875",
]);

export function checkFloatEquality(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	const floatCompare = /[!=]==?\s*(\d+\.\d+)\b|\b(\d+\.\d+)\s*[!=]==?/;
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const m = nonNull(strippedLines[i]).match(floatCompare);
		if (!m) continue;

		const floatValue = nonNull(m[1] || m[2]);
		if (SAFE_FLOAT_VALUES.has(floatValue)) continue;

		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}
