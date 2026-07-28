// Shared internal helpers for the UBS language-specific detector modules.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Not part of the public API — only the sibling check modules import this.

import { nonNull } from "../../../lib/non-null.js";
import { lineHasNoqaSuppression } from "../shared.js";

// ===========================================
// Extension predicates
// ===========================================

export const PY_EXTS = [".py", ".pyi"] as const;
export const JS_TS_EXT_LIST = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
] as const;

export function isPyFile(ext: string): boolean {
	return (PY_EXTS as readonly string[]).includes(ext);
}

export function isJsTsFile(ext: string): boolean {
	return (JS_TS_EXT_LIST as readonly string[]).includes(ext);
}

/** Per-detector finding cap shared across the UBS backlog detectors. */
export const MATCH_LIMIT = 10;

// ===========================================
// Comment/string stripping (preserving string contents)
// ===========================================

/**
 * Strip `//` line comments, `#` line comments, and block comments while
 * leaving the contents of string literals intact. Distinct from
 * `stripCommentsAndStrings` in `../shared.js`, which also blanks strings.
 */
export function stripCommentsPreservingStrings(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		let stripped = "";
		let quote: "'" | "\"" | "`" | null = null;
		let escaped = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlock) {
				if (ch === "*" && next === "/") {
					inBlock = false;
					i++;
				}
				continue;
			}
			if (quote) {
				stripped += ch;
				if (escaped) {
					escaped = false;
				} else if (ch === "\\") {
					escaped = true;
				} else if (ch === quote) {
					quote = null;
				}
				continue;
			}
			if (ch === "'" || ch === "\"" || ch === "`") {
				quote = ch;
				stripped += ch;
				continue;
			}
			if (ch === "/" && next === "*") {
				inBlock = true;
				i++;
				continue;
			}
			if (ch === "/" && next === "/") break;
			if (ch === "#") break;
			stripped += ch;
		}
		out.push(stripped);
	}
	return out.join("\n");
}

// ===========================================
// noqa suppression range scan (Python checks)
// ===========================================

/**
 * Scan a 1-based line range of the original (unstripped) content for a
 * Bandit/flake8-style `# noqa[: <code>]` suppression that maps to the given
 * check id. Used by Python-language checks where the suppression often
 * appears on the opening line of a multi-line call but the match anchors on
 * a deeper keyword (`shell=True`, etc.).
 *
 * Both `startLine` and `endLine` are 1-based and inclusive. Returns true if
 * ANY line in that range carries a suppressing noqa for the given check.
 */
export function isNoqaSuppressedInRange(
	originalLines: string[],
	startLine: number,
	endLine: number,
	checkId: string,
): boolean {
	const lo = Math.max(1, Math.min(startLine, endLine));
	const hi = Math.min(originalLines.length, Math.max(startLine, endLine));
	for (let i = lo - 1; i < hi; i++) {
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), checkId)) return true;
	}
	return false;
}
