// Sequential independent awaits detection (JS/TS).
// Extracted from generic-checks.ts.

import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";

// ===========================================
// Sequential Independent Awaits Detection (JS/TS)
// ===========================================

/**
 * Detect sequential `const x = await ...;` lines where the second doesn't
 * reference the first's variable — they could run concurrently with Promise.all.
 *
 * Only fires on JS/TS files. Skips test files.
 */
export function checkSequentialAwaits(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const awaitPattern = /^(?:const|let|var)\s+(\w+)\s*=\s*await\s+(.+);?\s*$/;

	let prevVarName: string | null = null;
	let prevLineIdx = -1;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const m = awaitPattern.exec(trimmed);
		if (m) {
			const varName = m[1];
			const expr = m[2];
			// Check if this await references the previous await's variable
			if (prevVarName !== null && prevLineIdx === i - 1) {
				if (!expr.includes(prevVarName)) {
					// Skip interactive I/O — prompts must be sequential (output interleaves)
					const prevExpr = lines[prevLineIdx].trim();
					if (/\bprompt\s*\(|\breadline\b|\bquestion\s*\(/.test(prevExpr)) continue;
					if (/\bprompt\s*\(|\breadline\b|\bquestion\s*\(/.test(expr)) continue;
					matches.push({
						line: prevLineIdx + 1,
						text: `[sequential independent awaits — consider Promise.all] ${lines[prevLineIdx].trim().slice(0, 100)}`,
					});
				}
			}
			prevVarName = varName;
			prevLineIdx = i;
		} else {
			prevVarName = null;
			prevLineIdx = -1;
		}
	}

	return matches;
}
