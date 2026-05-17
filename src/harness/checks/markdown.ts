// Markdown-specific checks.
// A checks/<family>.ts module; the generic-checks.ts barrel re-exports it.

import { getExtension, type InlineMatch } from "./shared.js";

/** Markdown file extensions this family applies to. */
const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

/** A markdown link whose href is empty, whitespace-only, or just `#` —
 *  `[text]()`, `[text]( )`, `[text](#)`. A real same-page anchor link
 *  (`[text](#section)`) has a slug after the `#` and does NOT match. */
const PLACEHOLDER_LINK_RE = /\[[^\]\n]*\]\(\s*#?\s*\)/;

/** Maximum placeholder-link findings reported per file. */
const MAX_MATCHES = 20;

/**
 * Blank out fenced code blocks (``` … ``` / ~~~ … ~~~) while preserving the
 * line count, so a documented *example* of placeholder-link syntax inside a
 * code block is not flagged as a real placeholder link.
 */
function stripFencedCodeBlocks(content: string): string[] {
	const out: string[] = [];
	let inFence = false;
	for (const line of content.split("\n")) {
		if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
			inFence = !inFence;
			out.push("");
			continue;
		}
		out.push(inFence ? "" : line);
	}
	return out;
}

/**
 * Detect placeholder markdown links — `[text]()` / `[text](#)` — links
 * written but never given a real destination. A common agent failure mode:
 * convincing-looking docs whose links point nowhere. Scoped to markdown
 * files; fenced code blocks are excluded so syntax examples don't fire.
 */
export function checkPlaceholderMarkdownLinks(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!MARKDOWN_EXTS.has(getExtension(filePath))) return [];
	const matches: InlineMatch[] = [];
	const scanLines = stripFencedCodeBlocks(content);
	const originalLines = content.split("\n");
	for (let i = 0; i < scanLines.length && matches.length < MAX_MATCHES; i++) {
		if (PLACEHOLDER_LINK_RE.test(scanLines[i])) {
			matches.push({
				line: i + 1,
				text: (originalLines[i] ?? "").trim().slice(0, 150),
			});
		}
	}
	return matches;
}
