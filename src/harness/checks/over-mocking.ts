// Over-mocking detection (testing smell).
// Extracted from generic-checks.ts.

import { getExtension, type InlineMatch, isTestFile } from "./shared.js";
import { nonNull } from "../../lib/non-null.js";

// ===========================================
// Over-Mocking Detection (Testing)
// ===========================================

/**
 * Detect test files with too many mock/spy calls — a sign the tests may be
 * testing mocks rather than real behavior.
 *
 * Counts vi.mock, jest.mock, vi.spyOn, jest.spyOn calls.
 * Threshold: 8+ triggers a warning. Only fires on test files.
 */
export function checkOverMocking(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let count = 0;
	const WARNING_THRESHOLD = 8;

	const mockPattern = /\b(vi|jest)\.(mock|spyOn)\s*\(/;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = nonNull(lines[i]).trim();
		if (mockPattern.test(trimmed)) {
			count++;
		}
	}

	if (count >= WARNING_THRESHOLD) {
		// Report the first mock/spy line as the anchor with the total count
		for (let i = 0; i < lines.length; i++) {
			if (mockPattern.test(nonNull(lines[i]).trim())) {
				matches.push({
					line: i + 1,
					text: `[${count} mock/spy calls — tests may be testing mocks rather than real behavior] ${nonNull(lines[i]).trim().slice(0, 100)}`,
				});
				break;
			}
		}
	}

	return matches;
}
