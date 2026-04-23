// React index-as-key detection.
// Extracted from generic-checks.ts.

import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

// ===========================================
// Index as Key Detection (React)
// ===========================================

/**
 * Detect array index used as React key prop — breaks reconciliation on reorder.
 * Catches `key={i}`, `key={index}`, `key={idx}`, `key={k}` and template
 * literal variants like `key={\`item-${i}\`}`.
 *
 * Only fires on .tsx/.jsx files. Skips test files.
 */
export function checkIndexAsKey(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Direct variable: key={i}, key={index}, key={idx}, key={k}
	const directPattern = /key=\{(i|idx|index|k)\}\s*/;
	// Template literal: key={`..${i}..`}, key={`..${index}..`}, etc.
	const templatePattern = /key=\{`[^`]*\$\{(i|idx|index|k)\}[^`]*`\}/;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (directPattern.test(trimmed) || templatePattern.test(trimmed)) {
			// Look backwards for the .map() call to check if it's a static array.
			// Patterns like [0,1,2].map, Array(n).fill().map, or "skeleton" in
			// the template key are static lists that never reorder — index is fine.
			let contextWindow = "";
			for (let j = Math.max(0, i - 3); j <= i; j++) {
				contextWindow += lines[j];
			}
			if (/\[\s*[\d,\s]+\]\s*\.map\b/.test(contextWindow)) continue; // literal array
			if (/Array\s*\(\s*\d+\s*\)/.test(contextWindow)) continue; // Array(n).fill().map
			if (/skeleton|placeholder|loading|spacer/i.test(trimmed)) continue; // UI placeholders

			matches.push({
				line: i + 1,
				text: `[index used as key — breaks reconciliation on reorder. Use a stable identifier] ${trimmed.slice(0, 100)}`,
			});
		}
	}

	return matches;
}
