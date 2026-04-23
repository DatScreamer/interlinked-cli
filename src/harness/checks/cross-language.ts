// Cross-language checks (SQL injection).
// Extracted from generic-checks.ts.

import { getExtension, type InlineMatch, stripComments } from "./shared.js";

// ===========================================
// Cross-Language Checks
// ===========================================

/** Detect SQL injection — string interpolation in query/execute calls. */
export function checkSqlInjection(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
			// Match .query()/.execute()/.raw()/.prepare()/.exec() with template literal interpolation
			if (/\.(query|execute|raw|prepare|exec)\s*\(\s*`[^`]*\$\{/.test(line)) {
				// Exclude safe patterns unlikely to be SQL injection:
				// PRAGMA statements (schema introspection, never user data)
				if (/\bPRAGMA\s/i.test(line)) continue;
				// DDL statements with code-controlled identifiers
				if (/\b(ALTER|DROP|CREATE)\s+(TABLE|INDEX|TRIGGER)\b/i.test(line)) continue;
				// SQL fragment helper functions (e.g., ARCHIVED_FILTER(), VISIBLE_PROJECT_FILTER())
				if (/\$\{\s*[A-Z][A-Z_]*\s*\(/.test(line)) continue;
				// Double-quoted identifier interpolation ("${tableName}")
				if (/"\$\{[^}]+\}"/.test(line)) continue;
				// Dynamic column building via .join() (column names from code, values use ?)
				if (/\$\{[^}]*\.join\s*\(/.test(line)) continue;
				// FTS rebuild command pattern
				if (/VALUES\s*\(\s*'rebuild'\s*\)/i.test(line)) continue;
				// Simple identifier interpolation referencing table/column names from code
				if (/\$\{\s*\w*(table|column|tbl|col|idx|spec)\w*\s*\}/i.test(line)) continue;
				matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
				continue;
			}
		}
		if (ext === ".py" && /\.(execute|executemany)\s*\(\s*f["']/.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			continue;
		}
		if (/\.(query|execute)\s*\(\s*["'][^"']*["']\s*\+/.test(line)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}
